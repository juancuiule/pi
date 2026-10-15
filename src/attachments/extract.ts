// Preparing an upload for the model: text decoded, HTML read as text, PDF text per page, images validated and
// resized. Runs in a worker thread (see worker.ts), never in the server's own thread: parsing untrusted files is
// bounded by the worker's time and memory limits, and nothing here executes or fetches anything from the file.
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import sharp from "sharp";
import type { FormatEnum } from "sharp";
import { extractText, getDocumentProxy } from "unpdf";

import type { AttachmentKind, Prepared } from "./format.ts";
import { decodeText, normalizeText } from "./format.ts";
import { htmlToText } from "./html.ts";

export interface ExtractLimits {
  readonly maxPdfPages: number;
  readonly maxImagePixels: number;
  /** The long edge of the copy the model gets. */
  readonly modelImageEdge: number;
  readonly thumbnailEdge: number;
}

export interface ExtractInput {
  readonly path: string;
  readonly kind: AttachmentKind;
  readonly mediaType: string;
  readonly limits: ExtractLimits;
}

export interface Extracted {
  readonly prepared: Prepared;
  /** Images: the copy the model gets, in the original's format. */
  readonly modelImage?: Uint8Array;
  /** Images: a small WebP for the console. */
  readonly thumbnail?: Uint8Array;
}

/** Why an upload was refused: not a file we read (`unsupported`), over a limit (`too_large`), or broken (`failed`). */
export class ExtractionRefusedError extends Error {
  readonly reason: "unsupported" | "too_large" | "failed";

  constructor(reason: "unsupported" | "too_large" | "failed", message: string) {
    super(message);
    this.name = "ExtractionRefusedError";
    this.reason = reason;
  }
}

/** An installed package's version, from its package.json (packages do not all export it). */
const versionOf = (name: string): string => {
  let dir = path.dirname(fileURLToPath(import.meta.resolve(name)));
  for (;;) {
    try {
      const manifest = JSON.parse(
        readFileSync(path.join(dir, "package.json"), "utf-8")
      ) as {
        name?: string;
        version?: string;
      };
      if (manifest.name === name && manifest.version !== undefined) {
        return `${name}@${manifest.version}`;
      }
    } catch {
      // No package.json here; keep going up.
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return name;
    }
    dir = parent;
  }
};

/** A PDF page with fewer non-space characters than this has no usable text layer. */
const MIN_PAGE_CHARS = 3;

const decoded = (bytes: Uint8Array) => {
  const text = decodeText(bytes);
  if (text === undefined) {
    throw new ExtractionRefusedError(
      "unsupported",
      "The file is not text in an encoding we can read."
    );
  }
  const warnings =
    text.encoding === "windows-1252"
      ? [
          "The file is not UTF-8; it was read as Windows-1252, so some characters may be wrong.",
        ]
      : [];
  return { text: text.text, warnings };
};

const emptyWarning = (text: string) =>
  text === "" ? ["The file has no text."] : [];

const extractTextFile = (bytes: Uint8Array): Extracted => {
  const { text, warnings } = decoded(bytes);
  const normalized = normalizeText(text);
  return {
    prepared: {
      kind: "text",
      pages: [normalized],
      ocrPages: [],
      warnings: [...warnings, ...emptyWarning(normalized)],
      extractor: "text",
    },
  };
};

const extractHtml = (bytes: Uint8Array): Extracted => {
  const { text, warnings } = decoded(bytes);
  const readable = htmlToText(text);
  const page =
    readable.title === undefined
      ? readable.text
      : `Title: ${readable.title}\n\n${readable.text}`;
  return {
    prepared: {
      kind: "html",
      pages: [page],
      ocrPages: [],
      warnings: [...warnings, ...emptyWarning(readable.text)],
      extractor: versionOf("htmlparser2"),
    },
  };
};

const extractPdf = async (
  bytes: Uint8Array,
  limits: ExtractLimits
): Promise<Extracted> => {
  const document = await getDocumentProxy(bytes, {
    disableFontFace: true,
    useSystemFonts: false,
    stopAtErrors: false,
    verbosity: 0,
  }).catch((error: unknown) => {
    const name = error instanceof Error ? error.name : "";
    throw new ExtractionRefusedError(
      "failed",
      name === "PasswordException"
        ? "The PDF is password-protected."
        : `The PDF could not be read: ${error instanceof Error ? error.message : String(error)}`
    );
  });
  // No cleanup: the worker that runs this ends right after, and its memory with it.
  if (document.numPages > limits.maxPdfPages) {
    throw new ExtractionRefusedError(
      "too_large",
      `The PDF has ${document.numPages} pages; at most ${limits.maxPdfPages} can be attached.`
    );
  }
  const { text } = await extractText(document, { mergePages: false });
  const pages = text.map((page) => normalizeText(page));
  const ocrPages = pages.flatMap((page, index) =>
    page.replaceAll(/\s/gu, "").length < MIN_PAGE_CHARS ? [index + 1] : []
  );
  return {
    prepared: {
      kind: "pdf",
      pages: pages.map((page, index) =>
        ocrPages.includes(index + 1) ? "" : page
      ),
      ocrPages,
      warnings: [
        "Text is extracted page by page; reading order and tables may not match the layout.",
      ],
      extractor: versionOf("unpdf"),
    },
  };
};

const FORMATS: Record<string, keyof FormatEnum> = {
  "image/png": "png",
  "image/jpeg": "jpeg",
  "image/webp": "webp",
};

const extractImage = async (
  bytes: Uint8Array,
  mediaType: string,
  limits: ExtractLimits
): Promise<Extracted> => {
  const format = FORMATS[mediaType];
  if (format === undefined) {
    throw new ExtractionRefusedError(
      "unsupported",
      `Images of type ${mediaType} cannot be attached.`
    );
  }
  const open = () =>
    sharp(bytes, { limitInputPixels: limits.maxImagePixels, failOn: "error" });
  const metadata = await open()
    .metadata()
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      throw /pixel limit/iu.test(message)
        ? new ExtractionRefusedError(
            "too_large",
            `The image is larger than ${Math.round(limits.maxImagePixels / 1_000_000)} megapixels.`
          )
        : new ExtractionRefusedError(
            "failed",
            `The image could not be read: ${message}`
          );
    });
  if (metadata.format !== format) {
    throw new ExtractionRefusedError(
      "unsupported",
      "The image's contents do not match its type."
    );
  }
  const width = metadata.autoOrient?.width ?? metadata.width;
  const height = metadata.autoOrient?.height ?? metadata.height;
  // Oriented like it displays; metadata (EXIF, location) is not copied.
  const resized = (edge: number) =>
    open().rotate().resize({
      width: edge,
      height: edge,
      fit: "inside",
      withoutEnlargement: true,
    });
  try {
    const modelImage = await resized(limits.modelImageEdge)
      .toFormat(format)
      .toBuffer();
    const thumbnail = await resized(limits.thumbnailEdge)
      .webp({ quality: 75 })
      .toBuffer();
    return {
      prepared: {
        kind: "image",
        pages: [],
        ocrPages: [],
        warnings:
          Math.max(width, height) > limits.modelImageEdge
            ? [
                `The model gets a copy scaled down to ${limits.modelImageEdge} pixels on the long edge.`,
              ]
            : [],
        extractor: `sharp@${sharp.versions.sharp}`,
        image: { width, height },
      },
      modelImage: new Uint8Array(modelImage),
      thumbnail: new Uint8Array(thumbnail),
    };
  } catch (error) {
    throw new ExtractionRefusedError(
      "failed",
      `The image could not be read: ${error instanceof Error ? error.message : String(error)}`
    );
  }
};

/** Prepare one stored upload. Throws `ExtractionRefusedError` for files that cannot be attached. */
export const extract = async (input: ExtractInput): Promise<Extracted> => {
  const bytes = new Uint8Array(await readFile(input.path));
  switch (input.kind) {
    case "text": {
      return extractTextFile(bytes);
    }
    case "html": {
      return extractHtml(bytes);
    }
    case "pdf": {
      return extractPdf(bytes, input.limits);
    }
    case "image": {
      return extractImage(bytes, input.mediaType, input.limits);
    }
    default: {
      throw new TypeError(`Unknown kind: ${input.kind satisfies never}`);
    }
  }
};
