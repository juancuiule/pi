// Attachments in the console. A sent file reaches the model as an `<attachment id="…" name="…" type="…"
// status="…" …>` block after the person's text (src/attachments/format.ts formatBlocks); the transcript drops the
// blocks and shows each file as a chip that downloads the original.
import type { AttachmentInfo } from "effect-pi/api";

export type AttachmentKind = AttachmentInfo["kind"];

/** A file in the transcript, as its block names it. */
export interface AttachmentRef {
  readonly id: string;
  readonly name: string;
  readonly kind: AttachmentKind;
  readonly status: AttachmentInfo["status"];
  /** Whether the message held the whole text (`undefined`), part of it, or none of it. */
  readonly included?: "part" | "none";
}

const BLOCK_START = /(?:^|\n\n)<attachment id="att_[0-9a-f]{32}"/gu;
const OPEN_TAG = "<attachment ";
const CLOSE_TAG = "\n</attachment>";
const ATTRIBUTE = /[a-z]+="[^"]*"/gu;
const KINDS = new Set<string>([
  "text",
  "html",
  "pdf",
  "table",
  "image",
  "file",
]);
const STATUSES = new Set<string>(["ready", "partial", "needs_ocr"]);

const unescape = (value: string) =>
  value.replaceAll("&quot;", '"').replaceAll("&amp;", "&");

const refOf = (attributes: string): AttachmentRef | undefined => {
  const fields = new Map<string, string>();
  for (const [pair] of attributes.matchAll(ATTRIBUTE)) {
    const at = pair.indexOf('="');
    fields.set(pair.slice(0, at), unescape(pair.slice(at + 2, -1)));
  }
  const id = fields.get("id");
  const name = fields.get("name");
  const kind = fields.get("type") ?? "";
  const status = fields.get("status") ?? "";
  if (
    id === undefined ||
    name === undefined ||
    !KINDS.has(kind) ||
    !STATUSES.has(status)
  ) {
    return undefined;
  }
  const included = fields.get("included");
  return {
    id,
    name,
    kind: kind as AttachmentKind,
    status: status as AttachmentInfo["status"],
    ...(included === "part" || included === "none" ? { included } : {}),
  };
};

/** A user message's text without its attachment blocks, and the files they name. */
/**
 * The files of `tail` when it is nothing but complete blocks, separated by blank lines, up to the end. A file's text
 * cannot hold a closing tag (the server escapes it), so a block ends at the first one.
 */
const blocksOf = (tail: string): AttachmentRef[] | undefined => {
  const refs: AttachmentRef[] = [];
  let at = 0;
  while (at < tail.length) {
    const lineEnd = tail.indexOf("\n", at);
    const line = lineEnd === -1 ? "" : tail.slice(at, lineEnd);
    const ref =
      line.startsWith(OPEN_TAG) && line.endsWith(">")
        ? refOf(line.slice(OPEN_TAG.length, -1))
        : undefined;
    const close = ref === undefined ? -1 : tail.indexOf(CLOSE_TAG, lineEnd);
    if (ref === undefined || close === -1) {
      return undefined;
    }
    refs.push(ref);
    at = close + CLOSE_TAG.length;
    if (at < tail.length && !tail.startsWith("\n\n", at)) {
      return undefined;
    }
    at += 2;
  }
  return refs;
};

/**
 * A user message's text without its attachment blocks, and the files they name. Only blocks that run, complete, to
 * the end of the message count: the server appends them after the text, and escapes what a person types, so a typed
 * example of the format stays text.
 */
export const splitAttachments = (
  text: string
): {
  readonly text: string;
  readonly attachments: readonly AttachmentRef[];
} => {
  for (const match of text.matchAll(BLOCK_START)) {
    const start = match.index + (match[0].startsWith("\n\n") ? 2 : 0);
    const attachments = blocksOf(text.slice(start));
    if (attachments !== undefined) {
      return { text: text.slice(0, match.index), attachments };
    }
  }
  return { text, attachments: [] };
};

/** Where the console gets an attachment's original or thumbnail; `conversation` is unset for a staged upload. */
export const attachmentUrl = (
  id: string,
  which: "original" | "thumbnail",
  conversation?: number
): string =>
  `/api/attachments/${encodeURIComponent(id)}/${which}${
    conversation === undefined ? "" : `?conversation=${conversation}`
  }`;

/** One page of a sent PDF, drawn as an image by the server. */
export const attachmentPageUrl = (
  id: string,
  page: number,
  conversation?: number
): string =>
  `/api/attachments/${encodeURIComponent(id)}/pages/${page}${
    conversation === undefined ? "" : `?conversation=${conversation}`
  }`;

/** A file in the composer: uploading, refused, or uploaded and checked. */
export type DraftAttachment =
  | {
      readonly key: string;
      readonly name: string;
      readonly state: "uploading";
    }
  | {
      readonly key: string;
      readonly name: string;
      readonly state: "failed";
      readonly error: string;
    }
  | {
      readonly key: string;
      readonly name: string;
      readonly state: "uploaded";
      readonly info: AttachmentInfo;
    };

/** What a checked file's status means for the person: whether the model can read all of it. */
export const statusText = (info: {
  readonly status: AttachmentInfo["status"];
  readonly ocrPages?: readonly number[];
}): string => {
  switch (info.status) {
    case "ready": {
      return "";
    }
    case "partial": {
      const pages = info.ocrPages ?? [];
      return pages.length === 0
        ? "Some pages can't be read"
        : `Can't read page${pages.length === 1 ? "" : "s"} ${pages.join(", ")} (scanned)`;
    }
    case "needs_ocr": {
      return "Scanned: the text can't be read";
    }
    default: {
      throw new TypeError(`Unknown status: ${info.status satisfies never}`);
    }
  }
};

/** A ready table's size, so the person sees it was read as one: "4,812 rows × 6 columns". */
export const sizeText = (info: {
  readonly rows?: number;
  readonly columns?: number;
}): string =>
  info.rows === undefined || info.columns === undefined
    ? ""
    : `${info.rows.toLocaleString("en-US")} row${info.rows === 1 ? "" : "s"} × ${info.columns} column${info.columns === 1 ? "" : "s"}`;

/** The short status a chip shows: what the model cannot read, a table's size, or nothing. */
export const attachmentStatus = (draft: DraftAttachment): string => {
  switch (draft.state) {
    case "uploading": {
      return "Uploading…";
    }
    case "failed": {
      return draft.error;
    }
    case "uploaded": {
      return statusText(draft.info) || sizeText(draft.info);
    }
    default: {
      throw new TypeError(`Unknown state: ${draft satisfies never}`);
    }
  }
};

/** Whether a message can be sent: some text or a file, and nothing still uploading. */
export const canSend = (
  prompt: string,
  drafts: readonly DraftAttachment[]
): boolean =>
  !drafts.some((draft) => draft.state === "uploading") &&
  (prompt.trim() !== "" || drafts.some((draft) => draft.state === "uploaded"));

/**
 * What a message sends: the uploaded files' ids, their keys to drop from the composer once it is sent, and the
 * drafts themselves, for the pending message and to restore on failure. Refused files stay behind for the person to
 * remove.
 */
export const sendable = (
  drafts: readonly DraftAttachment[]
): {
  readonly ids: string[];
  readonly keys: string[];
  readonly drafts: readonly Extract<DraftAttachment, { state: "uploaded" }>[];
} => {
  const uploaded = drafts.flatMap((draft) =>
    draft.state === "uploaded" ? [draft] : []
  );
  return {
    ids: uploaded.map((draft) => draft.info.id),
    keys: uploaded.map((draft) => draft.key),
    drafts: uploaded,
  };
};

/** An uploaded file as the transcript's chips name it. */
export const attachmentRef = (info: AttachmentInfo): AttachmentRef => ({
  id: info.id,
  name: info.name,
  kind: info.kind,
  status: info.status,
});

/**
 * The cells of a prepared table row: cells are joined with ` | `, and inside a cell `\|`, `\n` and `\\` stand for a
 * pipe, a line break and a backslash (src/attachments/table.ts renderRow).
 */
export const tableCells = (line: string): string[] => {
  const cells: string[] = [];
  let cell = "";
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === "\\" && index + 1 < line.length) {
      const next = line[index + 1];
      cell += next === "n" ? "\n" : (next ?? "");
      index += 1;
    } else if (line.startsWith(" | ", index)) {
      cells.push(cell);
      cell = "";
      index += 2;
    } else {
      cell += char ?? "";
    }
  }
  cells.push(cell);
  return cells;
};
