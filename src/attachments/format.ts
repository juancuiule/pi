// The text side of attachments, with no I/O: what kind of file an upload is, how its text is decoded, and what the
// model reads: the `<attachment>` blocks of a message, `read_attachment`'s ranges and `search_attachment`'s matches.
// Prepared text is numbered by page (PDFs) and line, or by row (tables), so a citation names a place that exists.

import { DELIMITER_NAMES } from "./table.ts";
import type { Delimiter } from "./table.ts";

export type AttachmentKind = "text" | "html" | "pdf" | "table" | "image";

/** `partial`: a PDF with some pages that need OCR; `needs_ocr`: none of its pages has text. */
export type AttachmentStatus = "ready" | "partial" | "needs_ocr";

/** What an extraction produced, stored once beside the original. */
// A type, not an interface: it is stored as JSON and must stay a plain JSON type.
// oxlint-disable-next-line typescript/consistent-type-definitions
export type Prepared = {
  readonly kind: AttachmentKind;
  /**
   * Documents: one entry per PDF page, or a single entry for text, HTML and tables (one line per row, row 1 the
   * header). Empty for images.
   */
  readonly pages: readonly string[];
  /** 1-based pages without a text layer. */
  readonly ocrPages: readonly number[];
  readonly warnings: readonly string[];
  /** The tool and version that prepared it, e.g. `unpdf@1.8.1`. */
  readonly extractor: string;
  /** Images: the decoded size of the original. */
  readonly image?: { readonly width: number; readonly height: number };
  /** Tables: rows after the header, the header's columns, and the delimiter the file uses. */
  readonly table?: {
    readonly rows: number;
    readonly columns: number;
    readonly delimiter: string;
  };
};

/** An attachment as the API and the console see it. */
export interface AttachmentInfo {
  readonly id: string;
  readonly name: string;
  readonly mediaType: string;
  readonly kind: AttachmentKind;
  readonly size: number;
  readonly status: AttachmentStatus;
  /** PDFs: the page count. */
  readonly pages?: number;
  /** Documents: the prepared text's length. */
  readonly chars?: number;
  readonly ocrPages: readonly number[];
  readonly warnings: readonly string[];
  readonly width?: number;
  readonly height?: number;
  /** Tables: rows after the header, and the header's columns. */
  readonly rows?: number;
  readonly columns?: number;
  readonly createdAt: number;
}

export const ATTACHMENT_ID = /^att_[0-9a-f]{32}$/u;

// --- Classification ---

const EXTENSIONS: Record<string, AttachmentKind> = {
  txt: "text",
  md: "text",
  markdown: "text",
  html: "html",
  htm: "html",
  pdf: "pdf",
  csv: "table",
  tsv: "table",
  png: "image",
  jpg: "image",
  jpeg: "image",
  webp: "image",
};

const startsWith = (bytes: Uint8Array, signature: readonly number[], at = 0) =>
  signature.every((byte, index) => bytes[at + index] === byte);

const ascii = (text: string) =>
  [...text].map((char) => char.codePointAt(0) ?? 0);

/** The media type a file's first bytes show, for the formats with a signature. */
export const sniff = (head: Uint8Array): string | undefined => {
  if (startsWith(head, ascii("%PDF-"))) {
    return "application/pdf";
  }
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "image/png";
  }
  if (startsWith(head, [0xff, 0xd8, 0xff])) {
    return "image/jpeg";
  }
  if (startsWith(head, ascii("RIFF")) && startsWith(head, ascii("WEBP"), 8)) {
    return "image/webp";
  }
  if (startsWith(head, ascii("GIF8"))) {
    return "image/gif";
  }
  if (startsWith(head, [0x50, 0x4b, 0x03, 0x04])) {
    return "application/zip";
  }
  return undefined;
};

const TEXT_TYPES: Record<"text" | "html" | "table", readonly string[]> = {
  text: ["text/plain", "text/markdown", "text/x-markdown"],
  html: ["text/html", "application/xhtml+xml"],
  // Windows reports CSV files as Excel's type.
  table: [
    "text/csv",
    "text/x-csv",
    "application/csv",
    "text/comma-separated-values",
    "text/tab-separated-values",
    "application/vnd.ms-excel",
  ],
};

/** Reported types that say nothing: browsers send these for files they do not know. */
const UNKNOWN_TYPES = new Set(["", "application/octet-stream"]);

const baseType = (reported: string) =>
  reported.split(";")[0]?.trim().toLowerCase() ?? "";

const accepts = (reported: string, ...types: readonly string[]) =>
  UNKNOWN_TYPES.has(reported) || types.includes(reported);

const textMediaType = (kind: "text" | "html" | "table", extension: string) => {
  if (kind === "html") {
    return "text/html";
  }
  if (kind === "table") {
    return extension === "tsv" ? "text/tab-separated-values" : "text/csv";
  }
  return extension === "txt" ? "text/plain" : "text/markdown";
};

/** The media type a file of `kind` has when its signature and reported type agree with its extension. */
const mediaTypeOf = (
  kind: AttachmentKind,
  extension: string,
  reported: string,
  sniffed: string | undefined
): string | undefined => {
  switch (kind) {
    case "pdf": {
      return sniffed === "application/pdf" && accepts(reported, sniffed)
        ? sniffed
        : undefined;
    }
    case "image": {
      const expected =
        extension === "jpg" ? "image/jpeg" : `image/${extension}`;
      return sniffed === expected && accepts(reported, expected)
        ? expected
        : undefined;
    }
    case "text":
    case "html":
    case "table": {
      // Some systems report Markdown, HTML and tables as plain text.
      if (
        sniffed !== undefined ||
        !accepts(reported, ...TEXT_TYPES[kind], "text/plain")
      ) {
        return undefined;
      }
      return textMediaType(kind, extension);
    }
    default: {
      throw new TypeError(`Unknown kind: ${kind satisfies never}`);
    }
  }
};

/**
 * What an upload is, from its name, the type the client reported and its first bytes; no one of them is enough.
 * Fails with the reason it is not accepted.
 */
export const classify = (
  name: string,
  reportedType: string,
  head: Uint8Array
):
  | { readonly kind: AttachmentKind; readonly mediaType: string }
  | { readonly unsupported: string } => {
  const extension =
    /\.(?<extension>[^./\\]+)$/u.exec(name)?.groups?.extension?.toLowerCase() ??
    "";
  const kind = EXTENSIONS[extension];
  if (kind === undefined) {
    return {
      unsupported:
        "Only text, Markdown, HTML, CSV, TSV, PDF, PNG, JPEG and WebP files can be attached.",
    };
  }
  const mediaType = mediaTypeOf(
    kind,
    extension,
    baseType(reportedType),
    sniff(head)
  );
  return mediaType === undefined
    ? {
        unsupported: `The file's contents do not match its .${extension} name.`,
      }
    : { kind, mediaType };
};

// --- Text decoding ---

/** Whether `text` has control characters that text files do not contain; tab, newlines, form feed and escape are fine. */
const hasBinaryControl = (text: string) => {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x08 || (code >= 0x0e && code <= 0x1f && code !== 0x1b)) {
      return true;
    }
  }
  return false;
};

/** The text of `bytes` in `encoding`, or `undefined` when they are not valid in it. */
const tryDecode = (bytes: Uint8Array, encoding: string): string | undefined => {
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch {
    // Not valid in this encoding.
  }
};

/**
 * A text file's contents: UTF-8 (with or without a BOM), UTF-16 with a BOM, or else Windows-1252 when it has no
 * control bytes. `undefined` when it is not text.
 */
export const decodeText = (
  bytes: Uint8Array
): { readonly text: string; readonly encoding: string } | undefined => {
  const attempt = (encoding: string, from = 0) => {
    const text = tryDecode(bytes.subarray(from), encoding);
    return text === undefined || hasBinaryControl(text)
      ? undefined
      : { text, encoding };
  };
  if (startsWith(bytes, [0xef, 0xbb, 0xbf])) {
    return attempt("utf-8", 3);
  }
  if (startsWith(bytes, [0xff, 0xfe])) {
    return attempt("utf-16le", 2);
  }
  if (startsWith(bytes, [0xfe, 0xff])) {
    return attempt("utf-16be", 2);
  }
  return attempt("utf-8") ?? attempt("windows-1252");
};

/** Lines of prepared text: `\r\n` and `\r` become `\n`, trailing whitespace goes, and so do runs of blank lines. */
export const normalizeText = (text: string): string =>
  text
    .replaceAll(/\r\n?/gu, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replaceAll(/\n{3,}/gu, "\n\n")
    .trim();

/** A file name safe for a path in a Sandbox, still readable. */
export const safeName = (name: string): string =>
  (name.split(/[\\/]/u).pop() ?? "")
    .normalize("NFC")
    .replaceAll(/[^\p{L}\p{N}._ -]+/gu, "_")
    .replace(/^[.\s]+/u, "")
    .slice(0, 120) || "file";

/** Where a conversation's Sandbox has an attachment's original, relative to the Workspace. */
export const sandboxPath = (id: string, name: string): string =>
  `.attachments/${id}/${safeName(name)}`;

// --- Positions in prepared text ---

/** A place in prepared text: a 1-based page (1 for unpaged text) and line, and a 0-based column within the line. */
export interface Position {
  readonly page: number;
  readonly line: number;
  readonly column?: number;
}

const linesOf = (page: string) => (page === "" ? [] : page.split("\n"));

const paged = (prepared: Prepared) => prepared.kind === "pdf";

const tabular = (prepared: Prepared) => prepared.kind === "table";

/** What a line is called: a table's lines are its rows. */
const lineWord = (prepared: Prepared) => (tabular(prepared) ? "row" : "line");

const ocrNote =
  "[No text layer on this page: it needs OCR, which is not available.]";

const pageMarker = (prepared: Prepared, page: number) =>
  `[page ${page} of ${prepared.pages.length}]`;

export interface Range {
  /** Numbered lines, with page markers for PDFs. */
  readonly text: string;
  readonly from: Position;
  /** Where the next range starts; `undefined` when this one reached the end. */
  readonly next: Position | undefined;
}

type Step =
  | { readonly kind: "line"; readonly text: string }
  | { readonly kind: "stop"; readonly next: Position }
  | { readonly kind: "cut"; readonly text: string; readonly next: Position };

/** What one line does to a range that has used `used` of `budget` characters. */
const lineStep = (
  full: string,
  at: Required<Position>,
  room: { readonly used: number; readonly budget: number },
  options: { readonly split: boolean; readonly empty: boolean }
): Step => {
  const { page, line, column } = at;
  const prefix =
    column === 0 ? `${line}: ` : `${line} (from column ${column + 1}): `;
  const rest = full.slice(column);
  if (room.used + prefix.length + rest.length <= room.budget) {
    return { kind: "line", text: `${prefix}${rest}` };
  }
  const fitsAlone = column === 0 && prefix.length + rest.length <= room.budget;
  if (!options.split || (!options.empty && fitsAlone)) {
    return { kind: "stop", next: { page, line } };
  }
  // A line longer than what is left: as much as fits, and the rest from its column.
  const left = Math.max(1, room.budget - room.used - prefix.length);
  return rest.length <= left
    ? { kind: "line", text: `${prefix}${rest}` }
    : {
        kind: "cut",
        text: `${prefix}${rest.slice(0, left)}`,
        next: { page, line, column: column + left },
      };
};

/** At most this share of a range repeats the header, so the rows asked for always get most of it. */
const HEADER_SHARE = 4;

/**
 * A table read from further down starts with its header, so every range says what its columns are. A header longer
 * than its share of `budget` is cut, and says so.
 */
const headerLines = (
  prepared: Prepared,
  lines: readonly string[],
  line: number,
  budget: number
): string[] => {
  if (!tabular(prepared) || line <= 1 || line > lines.length) {
    return [];
  }
  const header = lines[0] ?? "";
  const room = Math.floor(budget / HEADER_SHARE);
  const shown =
    header.length <= room
      ? header
      : `${header.slice(0, room)}… [header cut; read row 1 for all of it]`;
  return [`1: ${shown}`, ...(line > 2 ? ["…"] : [])];
};

/**
 * Prepared text from `from`, lines with their numbers, up to about `budget` characters. With `split` (the default) a
 * range has at least one line, or part of one when a single line is longer; without it, only whole lines, possibly
 * none. Positions past the end give an empty range.
 */
export const renderRange = (
  prepared: Prepared,
  from: Position,
  budget: number,
  { split = true }: { readonly split?: boolean } = {}
): Range => {
  const out: string[] = [];
  let used = 0;
  const push = (text: string) => {
    out.push(text);
    used += text.length + 1;
  };
  const done = (next?: Position): Range => ({
    text: out.join("\n"),
    from,
    next,
  });
  let column = Math.max(0, from.column ?? 0);
  let line = Math.max(1, from.line);
  for (
    let page = Math.max(1, from.page);
    page <= prepared.pages.length;
    page += 1
  ) {
    if (paged(prepared) && line === 1 && column === 0) {
      const marker = pageMarker(prepared, page);
      if (out.length > 0 && used + marker.length > budget) {
        return done({ page, line: 1 });
      }
      push(marker);
      if (prepared.ocrPages.includes(page)) {
        push(ocrNote);
      }
    }
    const lines = linesOf(prepared.pages[page - 1] ?? "");
    const header = headerLines(prepared, lines, line, budget);
    for (const text of header) {
      push(text);
    }
    for (; line <= lines.length; line += 1) {
      const step = lineStep(
        lines[line - 1] ?? "",
        { page, line, column },
        { used, budget },
        { split, empty: out.length === header.length }
      );
      if (step.kind === "stop") {
        return done(step.next);
      }
      push(step.text);
      if (step.kind === "cut") {
        return done(step.next);
      }
      column = 0;
    }
    line = 1;
  }
  return done();
};

const describePosition = (prepared: Prepared, position: Position) => {
  const column =
    position.column === undefined ? "" : `, column ${position.column + 1}`;
  const line = `${lineWord(prepared)} ${position.line}${column}`;
  return paged(prepared) ? `page ${position.page}, ${line}` : line;
};

const nextCall = (id: string, prepared: Prepared, next: Position) => {
  const args = [
    `id: "${id}"`,
    ...(paged(prepared) ? [`page: ${next.page}`] : []),
    `line: ${next.line}`,
    ...(next.column === undefined ? [] : [`column: ${next.column + 1}`]),
  ];
  return `read_attachment(${args.join(", ")})`;
};

/** The size of a document's prepared text, for coverage notes. */
export const extent = (prepared: Prepared): string => {
  if (prepared.table !== undefined) {
    return `${prepared.table.rows} rows × ${prepared.table.columns} columns, after the header in row 1`;
  }
  const lines = prepared.pages.reduce(
    (sum, page) => sum + linesOf(page).length,
    0
  );
  return paged(prepared)
    ? `${prepared.pages.length} pages, ${lines} lines`
    : `${lines} lines`;
};

/** The prepared text's length in characters. */
export const charsOf = (prepared: Prepared): number =>
  prepared.pages.reduce((sum, page) => sum + page.length, 0);

/** What `read_attachment` returns: the range, then where it was in the whole file and what to read next. */
export const formatRead = (
  id: string,
  name: string,
  prepared: Prepared,
  range: Range
): string => {
  const whole = extent(prepared);
  const header = `${name} (${id}), ${whole}; from ${describePosition(prepared, range.from)}:`;
  const footer =
    range.next === undefined
      ? "[End of the file.]"
      : `[Continues at ${describePosition(prepared, range.next)}: ${nextCall(id, prepared, range.next)}]`;
  return range.text === ""
    ? `${header}\n[Nothing here: the file is ${whole}.]`
    : `${header}\n${range.text}\n${footer}`;
};

export interface SearchMatch {
  readonly page: number;
  readonly line: number;
  readonly text: string;
}

const SNIPPET = 300;

/** Lines that contain every term of `query`, ignoring case. */
export const search = (
  prepared: Prepared,
  query: string
): readonly SearchMatch[] => {
  const terms = query
    .toLowerCase()
    .split(/\s+/u)
    .filter((term) => term !== "");
  if (terms.length === 0) {
    return [];
  }
  return prepared.pages.flatMap((page, pageIndex) =>
    linesOf(page).flatMap((text, lineIndex) => {
      const lower = text.toLowerCase();
      if (!terms.every((term) => lower.includes(term))) {
        return [];
      }
      const first = Math.min(...terms.map((term) => lower.indexOf(term)));
      const start = Math.max(0, first - SNIPPET / 3);
      const snippet = text.slice(start, start + SNIPPET);
      return [
        {
          page: pageIndex + 1,
          line: lineIndex + 1,
          text: `${start > 0 ? "…" : ""}${snippet}${start + SNIPPET < text.length ? "…" : ""}`,
        },
      ];
    })
  );
};

/** What `search_attachment` returns: at most `limit` matches with their places. */
export const formatSearch = (
  id: string,
  name: string,
  prepared: Prepared,
  query: string,
  matches: readonly SearchMatch[],
  limit: number
): string => {
  if (matches.length === 0) {
    return `No ${lineWord(prepared)} of ${name} (${id}) contains every term of "${query}".`;
  }
  const shown = matches.slice(0, limit);
  const lines = shown.map(
    (match) => `${describePosition(prepared, match)}: ${match.text}`
  );
  const more =
    matches.length > shown.length
      ? `\n[${matches.length - shown.length} more matches; search for more specific terms.]`
      : "";
  return `${matches.length} matching ${lineWord(prepared)}s in ${name} (${id}):\n${lines.join("\n")}${more}`;
};

// --- The message's blocks ---

const attribute = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll(/[\n\r<>]/gu, " ");

/**
 * Text that cannot open or close an attachment block: a file's text cannot close its block early, and what a person
 * types cannot pass for a block the server appended.
 */
export const escapeAttachmentTags = (text: string): string =>
  text.replaceAll(/<(?<slash>\/?)attachment/giu, "<$<slash>\u200Battachment");

export interface MessageAttachment {
  readonly info: AttachmentInfo;
  readonly prepared: Prepared;
}

export const OPEN_TAG = "<attachment ";
export const CLOSE_TAG = "</attachment>";

const openTag = (info: AttachmentInfo, extra: Record<string, string>) => {
  const attributes: Record<string, string> = {
    id: info.id,
    name: info.name,
    type: info.kind,
    status: info.status,
    ...extra,
  };
  return `${OPEN_TAG}${Object.entries(attributes)
    .map(([key, value]) => `${key}="${attribute(value)}"`)
    .join(" ")}>`;
};

/**
 * The text blocks of a message's attachments, in order, sharing `budget` characters of inline text: each document
 * gets whole pages (or lines) while they fit, and a note of what it holds and how to read the rest. Images are only
 * a block; their content follows the text when `images` (the model takes them).
 */
export const formatBlocks = (
  attachments: readonly MessageAttachment[],
  options: { readonly budget: number; readonly images: boolean }
): string[] => {
  let left = options.budget;
  return attachments.map(({ info, prepared }) => {
    if (prepared.kind === "image") {
      const size =
        prepared.image === undefined
          ? {}
          : {
              width: String(prepared.image.width),
              height: String(prepared.image.height),
            };
      const note = options.images
        ? "[The image follows this message's text.]"
        : "[Not sent: this model does not take images. Tell the person if it matters.]";
      return `${openTag(info, size)}\n${note}\n${CLOSE_TAG}`;
    }
    const extra: Record<string, string> = { size: extent(prepared) };
    const notes: string[] = [];
    if (prepared.table !== undefined) {
      notes.push(
        `[A table: one row per line, cells between " | " (the file separates them with ${DELIMITER_NAMES[prepared.table.delimiter as Delimiter] ?? `"${prepared.table.delimiter}"`}). Values are as written in the file.]`
      );
    }
    // What the extraction could not be sure of, e.g. a guessed separator or rows that do not fit the header.
    for (const warning of prepared.warnings) {
      notes.push(`[Note: ${warning}]`);
    }
    if (prepared.ocrPages.length > 0) {
      notes.push(
        prepared.ocrPages.length === prepared.pages.length
          ? "[No page has a text layer (a scan or images): it needs OCR, which is not available, so its contents cannot be read.]"
          : `[Pages without a text layer, which need OCR (not available): ${prepared.ocrPages.join(", ")}.]`
      );
    }
    const range = renderRange(
      prepared,
      { page: 1, line: 1 },
      Math.max(0, left),
      {
        split: false,
      }
    );
    left -= range.text.length;
    if (range.next === undefined) {
      return [
        openTag(info, extra),
        ...notes,
        escapeAttachmentTags(range.text),
        CLOSE_TAG,
      ].join("\n");
    }
    const hasLines = /^\d+: /mu.test(range.text);
    if (hasLines) {
      notes.push(
        `[Only up to ${describePosition(prepared, range.next)} (exclusive) is included here. Read the rest with ${nextCall(info.id, prepared, range.next)}, or find passages with search_attachment.]`
      );
      return [
        openTag(info, { ...extra, included: "part" }),
        escapeAttachmentTags(range.text),
        ...notes,
        CLOSE_TAG,
      ].join("\n");
    }
    left = 0;
    notes.push(
      `[Not included here (${charsOf(prepared)} characters). Read it with read_attachment(id: "${info.id}"), or find passages with search_attachment.]`
    );
    return [
      openTag(info, { ...extra, included: "none" }),
      ...notes,
      CLOSE_TAG,
    ].join("\n");
  });
};
