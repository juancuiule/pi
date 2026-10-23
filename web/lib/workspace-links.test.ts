import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ConversationSummary, EntryRecord, Message } from "effect-pi/api";
import { createElement } from "react";
import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Markdown } from "../components/console/markdown";
import { Transcript } from "../components/console/transcript";
import { initialState } from "./conversation-state";
import { WorkspaceContext } from "./workspace-context";
import {
  EMPTY_INDEX,
  linkIndexOf,
  normalizeWorkspacePath,
  splitProse,
  workspaceIndexOf,
  workspaceTargetOf,
} from "./workspace-links";
import type { WorkspaceIndex } from "./workspace-links";

const TREE = [
  "README.md",
  "notes/",
  "notes/plan.md",
  "proposals/",
  "proposals/01-research.md",
  "src/",
  "src/app.ts",
];

const index = workspaceIndexOf(TREE, { directories: true });

describe(normalizeWorkspacePath, () => {
  it.each([
    ["/workspace/notes/plan.md", "notes/plan.md"],
    ["./notes/plan.md", "notes/plan.md"],
    ["notes/plan.md", "notes/plan.md"],
    ["notes/", "notes"],
    ["README.md", "README.md"],
    ["/workspace", undefined],
    ["/workspace/", undefined],
    ["/etc/passwd", undefined],
    ["~/x", undefined],
    ["a/../b", undefined],
    ["a/./b", undefined],
    ["a//b", undefined],
    ["https://x.y/a/b", undefined],
    ["", undefined],
  ])("%s -> %s", (raw, expected) => {
    expect(normalizeWorkspacePath(raw)).toBe(expected);
  });
});

describe(workspaceTargetOf, () => {
  it.each([
    ["/workspace/notes/plan.md", { path: "notes/plan.md", kind: "file" }],
    ["./notes/plan.md", { path: "notes/plan.md", kind: "file" }],
    ["notes/plan.md", { path: "notes/plan.md", kind: "file" }],
    ["./README.md", { path: "README.md", kind: "file" }],
    ["notes/", { path: "notes", kind: "directory" }],
    ["/workspace/notes", { path: "notes", kind: "directory" }],
    ["README.md", undefined],
    ["notes", undefined],
    ["notes/plan.md/", undefined],
    ["notes/missing.md", undefined],
    ["/tmp/notes/plan.md", undefined],
  ])("%s", (raw, expected) => {
    expect(workspaceTargetOf(raw, index)).toStrictEqual(expected);
  });
});

/** The prose with each linked token in brackets, so a case reads as the output it expects. */
const linked = (text: string, at: WorkspaceIndex = index) =>
  splitProse(text, at)
    .map((segment) =>
      segment.target === undefined ? segment.text : `[${segment.text}]`
    )
    .join("");

describe(splitProse, () => {
  it.each([
    ["see notes/plan.md.", "see [notes/plan.md]."],
    ["(see notes/plan.md)", "(see [notes/plan.md])"],
    [
      "in notes/plan.md, then src/app.ts:",
      "in [notes/plan.md], then [src/app.ts]:",
    ],
    [
      "at src/app.ts:42 and src/app.ts:42:7.",
      "at [src/app.ts]:42 and [src/app.ts]:42:7.",
    ],
    [
      '"/workspace/proposals/01-research.md"',
      '"[/workspace/proposals/01-research.md]"',
    ],
    ["the folder proposals/ holds it", "the folder [proposals/] holds it"],
    ["README.md stays", "README.md stays"],
    ["notes/missing.md stays", "notes/missing.md stays"],
    ["partial proposals/01-res", "partial proposals/01-res"],
    ["a/b and/or c", "a/b and/or c"],
  ])("%s", (text, expected) => {
    expect(linked(text)).toBe(expected);
  });

  it("gives back the input when joined", () => {
    const text = "  (notes/plan.md),\n\tsrc/app.ts:3 README.md ./README.md! ";
    expect(
      splitProse(text, index)
        .map((segment) => segment.text)
        .join("")
    ).toBe(text);
  });
});

const conversation = (
  sandbox: ConversationSummary["sandbox"],
  status: ConversationSummary["status"]
) => ({ sandbox, status });

describe(linkIndexOf, () => {
  it("links files and folders of a live shell conversation", () => {
    expect([...linkIndexOf(conversation("shell", "idle"), TREE)]).toStrictEqual(
      [...index]
    );
  });

  it("links only files at desktop Level, which has no Files tab", () => {
    const desktop = linkIndexOf(conversation("desktop", "running"), TREE);
    expect([...desktop]).toStrictEqual(
      [...index].filter(([, kind]) => kind === "file")
    );
    expect([...desktop.values()]).not.toContain("directory");
  });

  it.each([
    ["none", "idle"],
    ["shell", "paused"],
    ["shell", "archived"],
  ] as const)("links nothing at %s / %s", (sandbox, status) => {
    expect(linkIndexOf(conversation(sandbox, status), TREE).size).toBe(0);
  });

  it("links nothing before the tree loads", () => {
    expect(linkIndexOf(conversation("shell", "idle")).size).toBe(0);
  });
});

const provide = (child: ReturnType<typeof createElement>, at = index) =>
  createElement(
    WorkspaceContext.Provider,
    { value: { index: at, open: () => null } },
    child
  );

// Markdown requires children in its props type; createElement passes them as the third argument.
const LINKING = { workspaceLinks: true } as ComponentProps<typeof Markdown>;

const answer = (text: string, at: WorkspaceIndex = index) =>
  renderToStaticMarkup(provide(createElement(Markdown, LINKING, text), at));

const fileButtons = (html: string) =>
  html.split('title="Open file"').length - 1;
const folderButtons = (html: string) =>
  html.split('title="Show in Files"').length - 1;

describe("workspace links in an answer", () => {
  it("links a code span, a bare path and a Markdown link target, keeping their rendering", () => {
    const html = answer(
      "Wrote `notes/plan.md`, /workspace/src/app.ts and [the research](./proposals/01-research.md)."
    );
    expect(fileButtons(html)).toBe(3);
    expect(html).toContain(
      '<code class="bg-muted text-ui rounded px-1 py-0.5 font-mono">notes/plan.md</code></button>'
    );
    expect(html).toContain(">the research</button>");
    expect(html).not.toContain("<a ");
  });

  it("links a folder to the Files tab", () => {
    const html = answer("Everything is in `proposals/`.");
    expect(folderButtons(html)).toBe(1);
    expect(fileButtons(html)).toBe(0);
  });

  it("links inside emphasis and list items", () => {
    expect(fileButtons(answer("- **notes/plan.md**\n- _src/app.ts_"))).toBe(2);
  });

  it("leaves fenced code untouched", () => {
    const html = answer("```\ncat notes/plan.md\n```");
    expect(fileButtons(html)).toBe(0);
    expect(html).toContain("notes/plan.md");
  });

  it("leaves other links as links, and links nothing inside them", () => {
    const html = answer(
      "[x](https://e.com/notes/plan.md) and [notes/plan.md](https://e.com)"
    );
    expect(fileButtons(html)).toBe(0);
    expect(html).toContain('href="https://e.com/notes/plan.md"');
    expect(html).toContain('href="https://e.com"');
  });

  it("leaves a link whose target is not in the workspace as it is", () => {
    const html = answer("[gone](notes/missing.md)");
    expect(fileButtons(html)).toBe(0);
    expect(html).toContain('href="notes/missing.md"');
  });

  it("keeps bare filenames and missing paths as text", () => {
    const html = answer("README.md and `notes/missing.md` and src/");
    expect(fileButtons(html)).toBe(0);
    expect(folderButtons(html)).toBe(1);
  });

  it("links nothing without a workspace, or without workspaceLinks", () => {
    expect(fileButtons(answer("`notes/plan.md`", EMPTY_INDEX))).toBe(0);
    const plain = renderToStaticMarkup(
      provide(createElement(Markdown, null, "`notes/plan.md`"))
    );
    expect(fileButtons(plain)).toBe(0);
  });
});

const entry = (id: number, message: Message): EntryRecord =>
  ({
    id,
    conversationId: 1,
    kind: "message",
    model: [message],
  }) as unknown as EntryRecord;

const transcript = (simple: boolean) =>
  renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: new QueryClient() },
      provide(
        createElement(Transcript, {
          state: {
            ...initialState,
            entries: [
              entry(1, {
                role: "user",
                content: "summarize notes/plan.md",
              } as Message),
              entry(2, {
                role: "assistant",
                content: [{ type: "text", text: "Done: `notes/plan.md`." }],
              } as Message),
            ],
          },
          conversation: 1,
          resuming: false,
          showThinking: true,
          simple,
        })
      )
    )
  );

describe("workspace links in the transcript", () => {
  it.each([false, true])(
    "links the answer, not the person's message (simple view %s)",
    (simple) => {
      const html = transcript(simple);
      expect(html).toContain("summarize notes/plan.md");
      expect(fileButtons(html)).toBe(1);
    }
  );
});
