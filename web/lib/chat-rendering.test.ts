import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AssistantMessage, EntryRecord, Message } from "effect-pi/api";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Markdown } from "../components/console/markdown";
import { ToolCall } from "../components/console/tool-call";
import type { ToolCallBlock } from "../components/console/tool-call";
import { Transcript } from "../components/console/transcript";
import { initialState } from "./conversation-state";
import type { ConversationState, ToolRun } from "./conversation-state";

const call = {
  type: "toolCall",
  id: "c1",
  name: "bash",
  arguments: { command: "pwd" },
} as unknown as ToolCallBlock;

const tool: ToolRun = {
  callId: call.id,
  name: call.name,
  output: "",
  details: undefined,
  status: "running",
};

const entry = (message: Message, data?: unknown): EntryRecord =>
  ({
    id: 1,
    conversationId: 1,
    kind: "message",
    model: [message],
    ...(data === undefined ? {} : { data }),
  }) as unknown as EntryRecord;

const entryId = (id: number, message: Message): EntryRecord =>
  ({ ...entry(message), id }) as EntryRecord;

const assistant = (thinking: string): AssistantMessage =>
  ({
    role: "assistant",
    content: [{ type: "thinking", thinking }],
  }) as unknown as AssistantMessage;

/** A `pi.compaction` head marker, as pi-durable writes it (the wrapped summary as a user message). */
const compaction = (reason: string): EntryRecord =>
  ({
    id: 4,
    conversationId: 1,
    kind: "pi.compaction",
    head: 3,
    data: { reason },
    model: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "The conversation history before this point was compacted into the following summary:\n\n<summary>\nsummarized so far\n</summary>",
          },
        ],
      },
    ],
  }) as unknown as EntryRecord;

// The assistant rows' feedback controls read /api/info through useInfo; a bare client never fetches
// during SSR rendering, so `tracing` stays unset and they hide.
const transcript = (
  state: ConversationState,
  resuming = false,
  showThinking = true,
  simple = false
) =>
  renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: new QueryClient() },
      createElement(Transcript, {
        state,
        conversation: 1,
        resuming,
        showThinking,
        simple,
      })
    )
  );
const toolCall = (state: ConversationState) =>
  renderToStaticMarkup(createElement(ToolCall, { call, state }));

const queuedItem = (id: number, text: string) =>
  ({ id, mode: "followUp", text }) as ConversationState["queue"][number];

const simpleMessages = (): ConversationState => ({
  ...initialState,
  entries: [
    entryId(1, { role: "user", content: "first" } as Message),
    entryId(2, {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "hmm" },
        { type: "text", text: "the answer" },
      ],
    } as Message),
    entryId(3, { role: "user", content: "second" } as Message),
    entryId(4, {
      role: "assistant",
      content: [{ type: "text", text: "next answer" }],
    } as Message),
  ],
});

describe("chat traces", () => {
  it("opens live thinking and renders it as a running trace", () => {
    const html = transcript({
      ...initialState,
      running: true,
      streaming: assistant("Considering the request"),
    });
    expect(html).toContain('data-slot="trace-line"');
    expect(html).toContain('data-status="running"');
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("Considering the request");
  });

  it("does not offer an empty reasoning disclosure", () => {
    const html = transcript({
      ...initialState,
      running: true,
      streaming: assistant(""),
    });
    expect(html).toContain("Thinking");
    expect(html).not.toContain('data-slot="trace-collapsible-trigger"');
  });

  it("collapses completed thinking and labels it Thought", () => {
    const html = transcript({
      ...initialState,
      entries: [entry(assistant("Done thinking"))],
    });
    expect(html).toContain(">Thought<");
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('data-status="running"');
  });

  it("hides thinking when showThinking is false, keeping text and tool calls", () => {
    const message = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "hmm" },
        { type: "text", text: "the answer" },
        { type: "thinking", thinking: "more" },
        call,
      ],
    } as unknown as AssistantMessage;
    const state = { ...initialState, entries: [entry(message)] };
    expect(transcript(state)).toContain(">Thought<");
    const html = transcript(state, false, false);
    expect(html).not.toContain(">Thought<");
    expect(html).toContain("the answer");
    expect(html).toContain(">bash<");
  });

  it("keeps the Working… line when thinking is hidden and only thinking is streaming", () => {
    const html = transcript(
      { ...initialState, running: true, streaming: assistant("hmm") },
      false,
      false
    );
    expect(html).toContain("Working…");
    expect(html).not.toContain("Thinking");
  });

  it("uses a running trace for the trailing Working line", () => {
    const html = transcript({ ...initialState, running: true });
    expect(html).toContain('data-status="running"');
    expect(html).toContain("Working…");
    expect(transcript(initialState)).not.toContain("Working…");
  });

  it("reads Resuming… instead of Working… while a resume is in flight", () => {
    const html = transcript({ ...initialState, running: true }, true);
    expect(html).toContain("Resuming…");
    expect(html).not.toContain("Working…");
  });

  it("shows a running tool as a trace line with its input in a code block", () => {
    const html = toolCall({
      ...initialState,
      running: true,
      tools: { c1: tool },
    });
    expect(html).toContain('data-slot="trace-line"');
    expect(html).toContain('data-status="running"');
    expect(html).toContain("Running");
    expect(html).toContain('data-slot="code-block"');
    expect(html).toContain("pwd");
  });

  it("shows the Input section when the call has arguments", () => {
    const html = toolCall({
      ...initialState,
      running: true,
      tools: { c1: tool },
    });
    expect(html).toContain(">Input<");
  });

  it.each([{}, undefined])(
    "hides the Input section when arguments are %s",
    (args) => {
      const bare = {
        type: "toolCall",
        id: "c1",
        name: "bash",
        arguments: args,
      } as unknown as ToolCallBlock;
      const html = renderToStaticMarkup(
        createElement(ToolCall, {
          call: bare,
          state: { ...initialState, running: true, tools: { c1: tool } },
        })
      );
      expect(html).not.toContain(">Input<");
    }
  );

  it("renders <harness> diagnostics as notes, dropping the model-facing markup", () => {
    const result = {
      role: "toolResult",
      toolCallId: "c1",
      toolName: "bash",
      content: [
        { type: "text", text: "ls: missing: No such file" },
        {
          type: "text",
          text: "<harness>\n[error] Command exited with code 2\n</harness>",
        },
      ],
      isError: true,
    } as unknown as Message;
    const html = toolCall({
      ...initialState,
      entries: [
        entry(result, {
          diagnostics: [
            { severity: "error", message: "Command exited with code 2" },
          ],
        }),
      ],
    });
    expect(html).toContain("ls: missing: No such file");
    expect(html).toContain("Command exited with code 2");
    expect(html).not.toContain("<harness>");
    expect(html).not.toContain("&lt;harness&gt;");
  });

  it("shows a write call as a file preview instead of a JSON blob", () => {
    const write = {
      type: "toolCall",
      id: "c1",
      name: "write",
      arguments: {
        path: "/workspace/factorial.py",
        content: "def factorial(n):\n    return 1\n",
      },
    } as unknown as ToolCallBlock;
    const html = renderToStaticMarkup(
      createElement(ToolCall, {
        call: write,
        state: {
          ...initialState,
          running: true,
          tools: { c1: { ...tool, name: "write" } },
        },
      })
    );
    expect(html).toContain("<diffs-container");
    expect(html).not.toContain("&quot;content&quot;");
  });

  it("shows an edit call's hunks as a diff", () => {
    const edit = {
      type: "toolCall",
      id: "c1",
      name: "edit",
      arguments: {
        path: "/x.py",
        edits: [{ oldText: "a = 1", newText: "a = 2" }],
      },
    } as unknown as ToolCallBlock;
    const html = renderToStaticMarkup(
      createElement(ToolCall, {
        call: edit,
        state: {
          ...initialState,
          running: true,
          tools: { c1: { ...tool, name: "edit" } },
        },
      })
    );
    expect(html).toContain("<diffs-container");
    expect(html).not.toContain("&quot;edits&quot;");
  });

  it("renders a finished edit's details.patch instead of its boilerplate text", () => {
    const edit = {
      type: "toolCall",
      id: "c1",
      name: "edit",
      arguments: {
        path: "/x.py",
        edits: [{ oldText: "a = 1", newText: "a = 2" }],
      },
    } as unknown as ToolCallBlock;
    // isError keeps the line expanded so the result content is mounted.
    const result = {
      role: "toolResult",
      toolCallId: "c1",
      toolName: "edit",
      content: [
        { type: "text", text: "Successfully replaced 1 block(s) in /x.py." },
      ],
      details: {
        patch:
          "--- /x.py\n+++ /x.py\n@@ -1,3 +1,3 @@\n const x = 0\n-a = 1\n+a = 2\n print(a)",
      },
      isError: true,
    } as unknown as Message;
    const html = renderToStaticMarkup(
      createElement(ToolCall, {
        call: edit,
        state: { ...initialState, entries: [entry(result)] },
      })
    );
    expect(html).toContain("<diffs-container");
    expect(html).not.toContain("Successfully replaced");
    // The patch supersedes the requested-hunks diff: one diff total, and Input falls back to the raw arguments.
    expect(html.match(/<diffs-container/gu)).toHaveLength(1);
    expect(html).toContain("&quot;edits&quot;");
  });

  it("keeps the Output section when diagnostics are the result's only content", () => {
    const result = {
      role: "toolResult",
      toolCallId: "c1",
      toolName: "bash",
      content: [
        {
          type: "text",
          text: "<harness>\n[error] Command exited with code 2\n</harness>",
        },
      ],
      isError: true,
    } as unknown as Message;
    const html = toolCall({
      ...initialState,
      entries: [
        entry(result, {
          diagnostics: [
            { severity: "error", message: "Command exited with code 2" },
          ],
        }),
      ],
    });
    expect(html).toContain(">Output<");
    expect(html).toContain("Command exited with code 2");
    expect(html).not.toContain("&lt;harness&gt;");
  });

  it("renders live output in a code block and hides an empty Output section", () => {
    const state = {
      ...initialState,
      running: true,
      tools: { c1: { ...tool, output: "/workspace" } },
    };
    const html = toolCall(state);
    expect(html).toContain("Output");
    expect(html).toContain("/workspace");
    expect(
      toolCall({ ...initialState, running: true, tools: { c1: tool } })
    ).not.toContain(">Output<");
  });

  it("keeps approval actions visible and marks the call pending, not running", () => {
    const state = {
      ...initialState,
      running: true,
      tools: {
        c1: {
          ...tool,
          details: { approval: "pending", approvalKey: "1:c1" },
        },
      },
    };
    const html = toolCall(state);
    expect(html).toContain('data-status="pending"');
    expect(html).toContain("Needs approval");
    expect(html).toContain("Always allow");
    expect(html).toContain(">Deny<");
    expect(transcript(state)).not.toContain("Working…");
  });

  it.each([
    [undefined, "Failed", true],
    ["denied", "Denied", false],
    ["stopped", "Stopped", false],
  ] as const)(
    "renders a failed result with approval %s as %s",
    (approval, label, destructive) => {
      const result = {
        role: "toolResult",
        toolCallId: "c1",
        toolName: "bash",
        content: [{ type: "text", text: "Unable to run" }],
        isError: true,
        details: { approval },
      } as unknown as Message;
      const html = toolCall({ ...initialState, entries: [entry(result)] });
      expect(html).toContain(label);
      expect(html.includes('data-status="error"')).toBe(destructive);
      expect(html).not.toContain('data-status="running"');
      expect(html).toContain("Unable to run");
    }
  );

  it("shows a finished call's duration from the result's durationMs", () => {
    const result = {
      role: "toolResult",
      toolCallId: "c1",
      toolName: "bash",
      content: [{ type: "text", text: "ok" }],
      durationMs: 2400,
      timestamp: 0,
    } as unknown as Message;
    const html = toolCall({
      ...initialState,
      entries: [entry(result)],
      tools: { c1: { ...tool, status: "done" } },
    });
    expect(html).toContain("2.4s");
    expect(html).not.toContain("Running");
  });

  it("subtracts the approval wait from a gated call's duration", () => {
    const result = {
      role: "toolResult",
      toolCallId: "c1",
      toolName: "bash",
      content: [{ type: "text", text: "ok" }],
      durationMs: 2400,
      details: { approval: "approved", approvalWaitMs: 2000 },
      timestamp: 0,
    } as unknown as Message;
    const html = toolCall({
      ...initialState,
      entries: [entry(result)],
      tools: { c1: { ...tool, status: "done" } },
    });
    expect(html).toContain("0.4s");
    expect(html).not.toContain("2.4s");
  });

  it("shows no duration for a denied call, which never ran", () => {
    const result = {
      role: "toolResult",
      toolCallId: "c1",
      toolName: "bash",
      content: [{ type: "text", text: "The user denied this tool call." }],
      isError: true,
      durationMs: 30_000,
      details: { approval: "denied" },
      timestamp: 0,
    } as unknown as Message;
    const html = toolCall({ ...initialState, entries: [entry(result)] });
    expect(html).toContain("Denied");
    expect(html).not.toContain("30s");
  });

  it("does not leave an interrupted tool shimmering", () => {
    const html = toolCall({ ...initialState, tools: { c1: tool } });
    expect(html).toContain("Stopped");
    expect(html).not.toContain('data-status="running"');
  });
});

describe("Markdown code blocks", () => {
  it.each(["```ts\nconst x = 1;\n```", "```\nplain output\n```"])(
    "renders fenced code with a copy action: %s",
    (children) => {
      const html = renderToStaticMarkup(
        createElement(Markdown, null, children)
      );
      expect(html).toContain('data-slot="code-block"');
      expect(html).toContain('data-slot="code-block-copy-button"');
      expect(html).toContain('dir="ltr"');
      expect(html).not.toContain("<code><code");
    }
  );

  it("renders a mermaid fence as a diagram with a source toggle, source hidden until drawn", () => {
    const html = renderToStaticMarkup(
      createElement(Markdown, null, "```mermaid\na --> b\n```")
    );
    expect(html).toContain('aria-label="Show source"');
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain('data-slot="code-block-copy-button"');
    // The diagram draws on the client; the source stays out until asked for.
    expect(html).toContain("Drawing the diagram…");
    expect(html).not.toContain("a --&gt; b");
  });

  it("keeps inline code inline and escapes HTML", () => {
    const html = renderToStaticMarkup(
      createElement(
        Markdown,
        null,
        "Use `pwd`.\n\n```html\n<script>alert(1)</script>\n```"
      )
    );
    expect(html).toContain(">pwd</code>");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("Markdown images", () => {
  it("renders an image in assistant text inline, wrapped in a link to its URL", () => {
    const message = {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "Here it is: ![a cat](https://example.com/cat.png)",
        },
      ],
    } as unknown as AssistantMessage;
    const html = transcript({ ...initialState, entries: [entry(message)] });
    expect(html).toContain('<img src="https://example.com/cat.png"');
    expect(html).toContain('referrerPolicy="no-referrer"');
    expect(html).toContain('href="https://example.com/cat.png"');
  });

  it("shows a label instead of an img for a URL react-markdown strips", () => {
    const message = {
      role: "assistant",
      content: [{ type: "text", text: "![x](javascript:alert(1))" }],
    } as unknown as AssistantMessage;
    const html = transcript({ ...initialState, entries: [entry(message)] });
    expect(html).not.toContain("<img");
    expect(html).not.toContain("alert(1)");
    expect(html).toContain("[image: x]");
  });
});

describe("head markers and earlier history", () => {
  it("renders a compaction as a collapsed boundary row, not a user bubble", () => {
    const html = transcript({
      ...initialState,
      entries: [compaction("threshold")],
    });
    expect(html).toContain("Context compacted (threshold)");
    expect(html).toContain('aria-expanded="false"');
    // Neither the model-facing wrapper nor a user bubble.
    expect(html).not.toContain("compacted into the following summary");
    expect(html).not.toContain("ml-auto");
  });

  it("renders a reset with its handoff under the fold", () => {
    const reset = {
      id: 4,
      conversationId: 1,
      kind: "pi.reset",
      head: 4,
      model: [{ role: "user", content: "carry on" }],
    } as unknown as EntryRecord;
    const html = transcript({ ...initialState, entries: [reset] });
    expect(html).toContain("Conversation reset");
    expect(html).not.toContain("ml-auto");
  });

  it("offers to show earlier entries, then keeps them above the transcript once paged out", () => {
    const user = {
      role: "user",
      content: [{ type: "text", text: "newest" }],
    } as Message;
    const active = { ...entry(user), id: 6 } as EntryRecord;
    const withGate = transcript({
      ...initialState,
      entries: [active],
      earlier: {
        entries: [],
        frontier: undefined,
        bound: 5,
        hasMore: true,
        loading: false,
      },
    });
    expect(withGate).toContain("Show earlier entries");

    const older = {
      ...entry({
        role: "user",
        content: [{ type: "text", text: "oldest" }],
      } as Message),
      id: 2,
    } as EntryRecord;
    const paged = transcript({
      ...initialState,
      entries: [active],
      earlier: {
        entries: [older],
        frontier: 2,
        bound: 5,
        hasMore: false,
        loading: false,
      },
    });
    // Exhausted: no gate, but the loaded entry renders, above the active transcript.
    expect(paged).not.toContain("Show earlier entries");
    expect(paged.indexOf("oldest")).toBeLessThan(paged.indexOf("newest"));

    const loading = transcript({
      ...initialState,
      earlier: {
        entries: [],
        frontier: undefined,
        bound: 5,
        hasMore: true,
        loading: true,
      },
    });
    expect(loading).toContain("Loading earlier entries…");
  });
});

const transcriptWithInfo = (state: ConversationState, tracing: boolean) => {
  const client = new QueryClient();
  client.setQueryData(["info"], {
    model: "faux/faux-1",
    apiUrl: "http://127.0.0.1:3000",
    tracing,
  });
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client },
      createElement(Transcript, {
        state,
        conversation: 1,
        resuming: false,
        showThinking: true,
      })
    )
  );
};
const answeredEntry = (): ConversationState => ({
  ...initialState,
  entries: [
    entry({
      role: "assistant",
      content: [{ type: "text", text: "42" }],
      timestamp: 0,
    } as Message),
  ],
});

describe("feedback controls", () => {
  it("shows thumbs and report on an assistant message when the server traces", () => {
    const html = transcriptWithInfo(answeredEntry(), true);
    expect(html).toContain('aria-label="Good answer"');
    expect(html).toContain('aria-label="Bad answer"');
    expect(html).toContain('aria-label="Report this answer"');
  });

  it("hides them when the server does not trace, or info has not loaded", () => {
    const untraced = transcriptWithInfo(answeredEntry(), false);
    expect(untraced).not.toContain("Good answer");
    expect(untraced).not.toContain("Report this answer");
    expect(transcript(answeredEntry())).not.toContain("Report this answer");
  });

  it("shows none on a user message even when the server traces", () => {
    const html = transcriptWithInfo(
      {
        ...initialState,
        entries: [
          entry({
            role: "user",
            content: [{ type: "text", text: "hi" }],
            timestamp: 0,
          } as Message),
        ],
      },
      true
    );
    expect(html).not.toContain("Good answer");
  });
});

describe("attachments in the transcript", () => {
  it("shows sent files as chips that open them, instead of their text", () => {
    const id = `att_${"c".repeat(32)}`;
    const html = transcript({
      ...initialState,
      entries: [
        entry({
          role: "user",
          content: `Read it.\n\n<attachment id="${id}" name="plan.md" type="text" status="ready" size="1 lines">\n1: secret plan\n</attachment>`,
          timestamp: 0,
        } as Message),
      ],
    });
    expect(html).toContain('title="View plan.md"');
    expect(html).not.toContain("secret plan");
  });

  it("does not repeat an attached image in full under its chip", () => {
    const id = `att_${"d".repeat(32)}`;
    const html = transcript({
      ...initialState,
      entries: [
        entry({
          role: "user",
          content: [
            {
              type: "text",
              text: `What is this?\n\n<attachment id="${id}" name="factura.png" type="image" status="ready" width="10" height="10">\n[The image follows this message's text.]\n</attachment>`,
            },
            { type: "image", data: "AAAA", mimeType: "image/png" },
          ],
          timestamp: 0,
        } as Message),
      ],
    });
    expect(html).toContain(`/api/attachments/${id}/thumbnail?conversation=1`);
    expect(html).not.toContain("data:image/png;base64,AAAA");
  });
});

describe("message metadata", () => {
  it("offers to copy a person's message, and an assistant's text", () => {
    const html = transcript({
      ...initialState,
      entries: [
        entryId(1, { role: "user", content: "the question" } as Message),
        entryId(2, {
          role: "assistant",
          content: [{ type: "text", text: "the answer" }],
        } as Message),
      ],
    });
    expect(html.match(/aria-label="Copy message"/gu)).toHaveLength(2);
  });

  it("shows a message's clock time from its timestamp, nothing for timestamp 0", () => {
    const html = transcript({
      ...initialState,
      entries: [
        entryId(1, {
          role: "user",
          content: "earlier",
          timestamp: new Date(2025, 5, 14, 9, 5).getTime(),
        } as Message),
        entryId(2, {
          role: "assistant",
          content: [{ type: "text", text: "no time" }],
          timestamp: 0,
        } as Message),
      ],
    });
    expect(html.match(/<time/gu)).toHaveLength(1);
    expect(html).toContain("Jun 14");
  });
});

describe("the send queue", () => {
  it("shows a queued send as a bubble that can be withdrawn", () => {
    const html = transcript({
      ...initialState,
      queue: [queuedItem(7, "hold on a second")],
    });
    expect(html).toContain("hold on a second");
    expect(html).toContain(">Queued<");
    expect(html).toContain('aria-label="Withdraw queued message"');
  });

  it("renders a queued write as a muted line, not a bubble", () => {
    const html = transcript({
      ...initialState,
      queue: [
        { id: 7, mode: "write", text: "", kind: "app.settings" } as never,
      ],
    });
    expect(html).toContain("Queued: app.settings");
    expect(html).not.toContain("ml-auto");
  });

  it("shows this client's own queued send once — as its pending bubble, not again from the inbox", () => {
    const html = transcript({
      ...initialState,
      pending: [
        {
          requestId: "r1",
          prompt: "mine",
          attachments: [],
          submission: 7,
        },
      ],
      queue: [queuedItem(7, "mine"), queuedItem(8, "from another tab")],
    });
    expect(html.match(/>mine</gu)).toHaveLength(1);
    expect(html).toContain("from another tab");
    expect(html.match(/aria-label="Withdraw queued message"/gu)).toHaveLength(
      2
    );
  });
});

describe("the simple view", () => {
  it("folds a run's steps under Details, keeping the person's messages and each answer", () => {
    const html = transcript(simpleMessages(), false, true, true);
    expect(
      ["first", "second", "the answer", "next answer"].every((s) =>
        html.includes(s)
      )
    ).toBeTruthy();
    // The folded run's thinking is inside a collapsed disclosure, not shown by default.
    expect(html).toContain('aria-expanded="false"');
    // A run that was only its answer has nothing to fold.
    expect(html.match(/>Details</gu)).toHaveLength(1);
  });

  it("shows every step in the full view", () => {
    const html = transcript(simpleMessages());
    expect(html).not.toContain(">Details<");
    // The run's thinking is its own fold, not hidden under one "Details" line.
    expect(html).toContain(">Thought<");
  });
});
