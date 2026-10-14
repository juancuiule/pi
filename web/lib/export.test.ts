import type { ConversationSummary, EntryRecord } from "effect-pi/api";
import { describe, expect, it } from "vitest";

import type { ConversationState } from "./conversation-state";
import { exportSlug, toJsonl, toMarkdown } from "./export";

const entry = (id: number, model: unknown[]): EntryRecord =>
  ({
    id,
    model,
  }) as unknown as EntryRecord;

const summary: ConversationSummary = {
  id: 42,
  sandbox: "shell",
  sandboxId: "effect-pi-shell-abcd1234",
  title: "List files & count",
  status: "idle",
  pausing: false,
  pendingApprovals: 0,
  createdAt: 0,
};

const state: ConversationState = {
  entries: [
    entry(1, [
      {
        role: "user",
        content: [
          { type: "text", text: "List /etc" },
          { type: "image", mimeType: "image/png", data: "AAAA" },
        ],
      },
    ]),
    entry(2, [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "let me think" },
          { type: "text", text: "Here is **the list**." },
          {
            type: "toolCall",
            id: "c1",
            name: "bash",
            arguments: { command: "ls /etc" },
          },
        ],
      },
    ]),
    entry(3, [
      {
        role: "toolResult",
        toolCallId: "c1",
        isError: false,
        content: [
          { type: "text", text: "hosts\n```\nnested fence\n```" },
          { type: "image", mimeType: "image/png", data: "BBBB" },
        ],
      },
    ]),
    entry(4, [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "c2",
            name: "write",
            arguments: { path: "/x" },
          },
        ],
      },
    ]),
    entry(5, [
      {
        role: "toolResult",
        toolCallId: "c2",
        isError: true,
        content: [{ type: "text", text: "permission denied" }],
      },
    ]),
    entry(6, [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "c3",
            name: "desktop_screenshot",
            arguments: {},
          },
        ],
      },
    ]),
    entry(7, [
      {
        role: "toolResult",
        toolCallId: "c3",
        isError: false,
        content: [{ type: "image", mimeType: "image/png", data: "CCCC" }],
      },
    ]),
  ],
  streaming: undefined,
  tools: {},
  running: false,
  queued: 0,
  usage: undefined,
  failures: [],
};

describe(exportSlug, () => {
  it("slugs the title and appends the id", () => {
    expect(exportSlug("List files & count", 42)).toBe("list-files-count-42");
  });
});

describe(toJsonl, () => {
  it("emits one parseable record per line with a trailing newline", () => {
    const lines = toJsonl(state);
    expect(lines.endsWith("\n")).toBeTruthy();
    const parsed = lines
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as EntryRecord);
    expect(parsed.map((r) => r.id)).toStrictEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("keeps image blocks' base64 data", () => {
    expect(toJsonl(state)).toContain('"data":"AAAA"');
  });
});

describe(toMarkdown, () => {
  it("renders a mixed transcript", () => {
    const md = toMarkdown(summary, state);
    const checks = [
      md.startsWith("# List files & count"),
      md.includes("Sandbox: Shell · Started 1970-01-01T00:00:00.000Z"),
      md.includes(
        "## User\n\nList /etc\n\n![image](data:image/png;base64,AAAA)"
      ),
      md.includes("## Assistant\n\nHere is **the list**."),
      md.includes("### Tool: bash\n"),
      md.includes("### Tool: write (failed)"),
      md.includes('"command": "ls /etc"'),
      md.includes("permission denied"),
      !md.includes("let me think"),
      // The output's inner ``` run forces a longer fence.
      md.includes("````\nhosts\n```\nnested fence\n```\n````"),
      // A result's images follow its fenced text output.
      md.includes("````\n\n![image](data:image/png;base64,BBBB)"),
      // An image-only result has no empty text fence.
      md.includes(
        "### Tool: desktop_screenshot\n\n```json\n{}\n```\n\n![image](data:image/png;base64,CCCC)"
      ),
    ];
    expect(checks).toStrictEqual(Array.from({ length: 12 }, () => true));
  });
});
