import { describe, expect, it } from "vitest";

import {
  attachmentUrl,
  canSend,
  sendableIds,
  splitAttachments,
  statusText,
} from "./attachments";
import type { DraftAttachment } from "./attachments";

const ID = `att_${"a".repeat(32)}`;
const OTHER = `att_${"b".repeat(32)}`;

const block = (attributes: string, body = "1: text") =>
  `<attachment id="${ID}" ${attributes}>\n${body}\n</attachment>`;

describe(splitAttachments, () => {
  it("separates the person's text from the files' blocks", () => {
    const text = `Summarize these.\n\n${block('name="a &quot;x&quot;.md" type="text" status="ready" size="1 lines"')}\n\n<attachment id="${OTHER}" name="scan.pdf" type="pdf" status="needs_ocr" size="2 pages, 0 lines" included="none">\n[No page has a text layer]\n</attachment>`;
    expect(splitAttachments(text)).toStrictEqual({
      text: "Summarize these.",
      attachments: [
        { id: ID, name: 'a "x".md', kind: "text", status: "ready" },
        {
          id: OTHER,
          name: "scan.pdf",
          kind: "pdf",
          status: "needs_ocr",
          included: "none",
        },
      ],
    });
  });

  it("reads a message of only files, and leaves text that only mentions a block alone", () => {
    expect(
      splitAttachments(block('name="a.png" type="image" status="ready"'))
    ).toStrictEqual({
      text: "",
      attachments: [{ id: ID, name: "a.png", kind: "image", status: "ready" }],
    });
    const typed = 'Explain <attachment id="att_x"> tags';
    expect(splitAttachments(typed)).toStrictEqual({
      text: typed,
      attachments: [],
    });
  });
});

describe(canSend, () => {
  const uploaded: DraftAttachment = {
    key: "f1",
    name: "a.md",
    state: "uploaded",
    info: {
      id: ID,
      name: "a.md",
      mediaType: "text/markdown",
      kind: "text",
      size: 1,
      status: "ready",
      ocrPages: [],
      warnings: [],
      createdAt: 0,
    },
  };
  const uploading: DraftAttachment = {
    key: "f2",
    name: "b.md",
    state: "uploading",
  };
  const failed: DraftAttachment = {
    key: "f3",
    name: "c.exe",
    state: "failed",
    error: "Unsupported",
  };

  it("needs text or an uploaded file, and waits for uploads", () => {
    expect([
      canSend("  ", []),
      canSend("hi", []),
      canSend("", [uploaded]),
      canSend("hi", [uploaded, uploading]),
      canSend("", [failed]),
    ]).toStrictEqual([false, true, true, false, false]);
  });

  it("sends only uploaded files", () => {
    expect(sendableIds([uploaded, failed])).toStrictEqual([ID]);
  });
});

describe(statusText, () => {
  it("says when the model cannot read all of a file", () => {
    expect([
      statusText({ status: "ready" }),
      statusText({ status: "partial", ocrPages: [3] }),
      statusText({ status: "partial", ocrPages: [3, 4] }),
      statusText({ status: "needs_ocr" }),
    ]).toStrictEqual([
      "",
      "Can't read page 3 (scanned)",
      "Can't read pages 3, 4 (scanned)",
      "Scanned: the text can't be read",
    ]);
  });
});

describe(attachmentUrl, () => {
  it("scopes downloads to the conversation", () => {
    expect(attachmentUrl(ID, "original", 4)).toBe(
      `/api/attachments/${ID}/original?conversation=4`
    );
    expect(attachmentUrl(ID, "thumbnail")).toBe(
      `/api/attachments/${ID}/thumbnail`
    );
  });
});
