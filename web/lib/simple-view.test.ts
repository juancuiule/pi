import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { EntryRecord } from "effect-pi/api";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Transcript } from "../components/console/transcript";
import { initialState } from "./conversation-state";
import type { ConversationState } from "./conversation-state";
import { useConversationStore } from "./store";

// Server rendering reads a zustand store's initial state, never what a test sets, and a subscription opens an
// EventSource. This stands in for the child's live stream with whatever the test put in the store.
vi.mock(import("./use-conversation-events"), async () => {
  const { useConversationStore: store } = await import("./store");
  const { initialState: empty } = await import("./conversation-state");
  return {
    useConversationEvents: (id: number | undefined) =>
      id === undefined ? empty : (store.getState().byId[id] ?? empty),
  };
});

const record = (id: number, message: unknown): EntryRecord =>
  ({
    id,
    conversationId: 1,
    kind: "message",
    model: [message],
  }) as unknown as EntryRecord;

const asks = record(1, { role: "user", content: "clean up" });

const calls = (id: number, ...content: unknown[]) =>
  record(id, { role: "assistant", content });

const bash = {
  type: "toolCall",
  id: "c1",
  name: "bash",
  arguments: { command: "rm -rf build" },
};

const pending = (key: string) => ({
  name: "bash",
  status: "running",
  output: "",
  details: { approval: "pending", approvalKey: key },
});

const simple = (state: ConversationState) =>
  renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: new QueryClient() },
      createElement(Transcript, {
        state,
        conversation: 1,
        resuming: false,
        showThinking: true,
        simple: true,
      })
    )
  );

const stateOf = (
  entries: readonly EntryRecord[],
  tools: Record<string, unknown>
) =>
  ({
    ...initialState,
    running: true,
    entries,
    tools,
  }) as unknown as ConversationState;

const count = (html: string, text: string) => html.split(text).length - 1;

const taskSlot = (status: "running" | "done") => ({
  name: "task",
  status,
  output: "",
  details: { conversationId: 7 },
});

describe("the simple view's waiting calls", () => {
  afterEach(() => {
    useConversationStore.setState({ byId: {} });
  });

  it("lifts a gated call out of the collapsed Details, usable and shown once", () => {
    const html = simple(
      stateOf(
        [
          asks,
          calls(
            2,
            { type: "thinking", thinking: "Planning the cleanup" },
            bash
          ),
        ],
        { c1: pending("1:c1") }
      )
    );
    expect(html).toContain(">Details<");
    expect(html).not.toContain("Planning the cleanup");
    expect(html).toContain("rm -rf build");
    expect(count(html, "Always allow")).toBe(1);
    expect(html).toContain(">Deny<");
  });

  it("folds a decided call back into Details", () => {
    const html = simple(
      stateOf(
        [
          asks,
          calls(2, bash),
          record(3, {
            role: "toolResult",
            toolCallId: "c1",
            toolName: "bash",
            content: [{ type: "text", text: "removed" }],
            isError: false,
            details: { approval: "approved" },
          }),
        ],
        {}
      )
    );
    expect(html).toContain(">Details<");
    expect(html).not.toContain("rm -rf build");
    expect(html).not.toContain("Always allow");
  });

  it("lifts an ask_user question with its form", () => {
    const html = simple(
      stateOf(
        [
          asks,
          calls(2, {
            type: "toolCall",
            id: "q",
            name: "ask_user",
            arguments: {
              questions: [
                {
                  id: "scope",
                  question: "Remove the cache too?",
                  options: [{ label: "Keep the cache" }, { label: "Drop it" }],
                },
              ],
            },
          }),
        ],
        { q: { ...pending("1:q"), name: "ask_user" } }
      )
    );
    expect(html).toContain("Needs answers");
    expect(html).toContain("Remove the cache too?");
    expect(html).toContain("Keep the cache");
    expect(html).toContain("Other");
  });

  describe("from a subagent", () => {
    const task = {
      type: "toolCall",
      id: "t1",
      name: "task",
      arguments: { prompt: "Write the file" },
    };
    const run = [asks, calls(2, task)];
    const seedChild = () =>
      useConversationStore.setState({
        byId: {
          7: stateOf(
            [
              calls(1, {
                type: "toolCall",
                id: "c9",
                name: "write",
                arguments: { path: "src/x.ts", content: "export {};" },
              }),
            ],
            { c9: { ...pending("7:c9"), name: "write" } }
          ),
        },
      });

    it("lifts the child's waiting call under the parent run while its task runs", () => {
      seedChild();
      const html = simple(stateOf(run, { t1: taskSlot("running") }));
      expect(html).toContain("Subagent #7");
      expect(html).toContain("src/x.ts");
      expect(count(html, "Always allow")).toBe(1);
    });

    it("lifts nothing once the task call has finished", () => {
      seedChild();
      const html = simple(stateOf(run, { t1: taskSlot("done") }));
      expect(html).not.toContain("Subagent #7");
      expect(html).not.toContain("Always allow");
    });
  });
});
