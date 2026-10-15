// Attachments in the console. A sent file reaches the model as an `<attachment id="…" name="…" type="…"
// status="…" …>` block after the person's text (src/attachments/format.ts formatBlocks); the transcript drops the
// blocks and shows each file as a chip that downloads the original.
import type { AttachmentInfo } from "effect-pi/api";

/** What the picker offers; the server checks every file again. */
export const ACCEPTED_FILES =
  ".txt,.md,.markdown,.html,.htm,.pdf,.png,.jpg,.jpeg,.webp";

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

const BLOCK_START = /(?:^|\n\n)<attachment id="att_[0-9a-f]{32}"/u;
const OPEN_TAG = "<attachment ";
const ATTRIBUTE = /[a-z]+="[^"]*"/gu;
const KINDS = new Set<string>(["text", "html", "pdf", "image"]);
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
export const splitAttachments = (
  text: string
): {
  readonly text: string;
  readonly attachments: readonly AttachmentRef[];
} => {
  const start = BLOCK_START.exec(text);
  if (start === null) {
    return { text, attachments: [] };
  }
  const blocks = text.slice(start.index);
  const attachments = blocks.split("\n").flatMap((line) => {
    if (!line.startsWith(OPEN_TAG) || !line.endsWith(">")) {
      return [];
    }
    const ref = refOf(line.slice(OPEN_TAG.length, -1));
    return ref === undefined ? [] : [ref];
  });
  return { text: text.slice(0, start.index), attachments };
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

/** The short status a chip shows; empty for a file that is ready. */
export const attachmentStatus = (draft: DraftAttachment): string => {
  switch (draft.state) {
    case "uploading": {
      return "Uploading…";
    }
    case "failed": {
      return draft.error;
    }
    case "uploaded": {
      return statusText(draft.info);
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

/** The ids a message sends: uploaded files only; refused ones stay behind for the person to remove. */
export const sendableIds = (drafts: readonly DraftAttachment[]): string[] =>
  drafts.flatMap((draft) =>
    draft.state === "uploaded" ? [draft.info.id] : []
  );
