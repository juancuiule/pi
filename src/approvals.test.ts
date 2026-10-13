// Approval-gated tools: an "ask" policy parks a call until `decide` commits an answer on the root
// conversation's ApprovalDoc.
import { existsSync } from "node:fs";
import path from "node:path";

import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type { AgentEvent, ConversationId } from "@earendil-works/pi-durable";
import { Effect, Exit, Layer, Ref, Scope, Stream } from "effect";
import { describe, expect, it } from "vitest";

import { Agents } from "./agents/agents.ts";
import { approvalKey, withApproval } from "./approvals.ts";
import type { SandboxChoice } from "./sandbox/sandbox.ts";
import { Conversations } from "./server/conversations.ts";
import { callTool, echoToolResult, fauxAgents } from "./testing/faux.ts";

const answer = (text: string) => fauxAssistantMessage([fauxText(text)]);

const waitUntil = (check: Effect.Effect<boolean, unknown>, timeoutMs = 8000) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < timeoutMs / 10; attempt += 1) {
      if (yield* check) {
        return;
      }
      yield* Effect.sleep("10 millis");
    }
    return yield* Effect.die(new Error("timed out waiting"));
  });

/** Start an "ask" conversation, send the prompt, and collect its events into a Ref while the run waits. */
const askConversation = (sandbox: SandboxChoice, prompt: string) =>
  Effect.gen(function* () {
    const agents = yield* Agents;
    const conversation = yield* agents.start({ sandbox, approvals: "ask" });
    const ref = yield* Ref.make<AgentEvent[]>([]);
    const events = yield* agents.events(conversation.id);
    const scope = yield* Scope.Scope;
    yield* Stream.runForEach(events, (event) =>
      Ref.update(ref, (all) => [...all, event])
    ).pipe(Effect.forkIn(scope));
    yield* conversation.send(prompt);
    return { agents, conversation, ref };
  });

/** The approvalKey reported by the first gated call's pending details, once committed. */
const pendingKey = (ref: Ref.Ref<AgentEvent[]>) =>
  Ref.get(ref).pipe(
    Effect.map((all) => {
      const update = all.find(
        (event) =>
          event.type === "tool_execution_update" &&
          typeof event.details === "object" &&
          event.details !== null &&
          "approval" in event.details &&
          (event.details as { approval?: string }).approval === "pending"
      );
      return update !== undefined && update.type === "tool_execution_update"
        ? (update.details as { approvalKey?: string }).approvalKey
        : undefined;
    })
  );

/** A minimal ToolExecutionApi stand-in for withApproval's documented surface (typed as never at call sites). */
const fakeApi = (doc: {
  policy: string;
  pending: Record<string, unknown>;
  decisions: Record<string, unknown>;
}) => ({
  conversationId: 1 as ConversationId,
  callId: "c1",
  commit: (change: (tx: { doc: () => Promise<typeof doc> }) => unknown) =>
    Promise.resolve(change({ doc: () => Promise.resolve(doc) })),
  details: () => Promise.resolve(),
  watchDoc: () =>
    Promise.resolve({
      value: doc,
      closed: Promise.withResolvers<never>().promise,
      start: () => {},
      stop: () => Promise.resolve({ reason: "stopped" }),
    }),
});

const fakeTool = (onRun: () => void) =>
  ({
    name: "fake",
    execute: () => {
      onRun();
      return Promise.resolve({ content: [] });
    },
  }) as never;

const hasRunEnd = (ref: Ref.Ref<AgentEvent[]>) =>
  Ref.get(ref).pipe(
    Effect.map((all) => all.some((event) => event.type === "run_end"))
  );

const toolResults = (ref: Ref.Ref<AgentEvent[]>) =>
  Ref.get(ref).pipe(
    Effect.map((all) =>
      all.flatMap((event) =>
        event.type === "tool_execution_end" && event.entry !== undefined
          ? (event.entry.model ?? []).flatMap((m) =>
              m.role === "toolResult" ? [m] : []
            )
          : []
      )
    )
  );

const assistantTexts = (ref: Ref.Ref<AgentEvent[]>) =>
  Ref.get(ref).pipe(
    Effect.map((all) =>
      all.flatMap((event) =>
        event.type === "message_end"
          ? (event.entry.model ?? []).flatMap((m) =>
              m.role === "assistant"
                ? m.content.flatMap((c) => (c.type === "text" ? [c.text] : []))
                : []
            )
          : []
      )
    )
  );

describe("tool approvals", () => {
  it("holds a gated call until approve, then runs it", async () => {
    const { layer, sandboxes } = fauxAgents([
      callTool("bash", { command: "touch approved.txt" }),
      echoToolResult,
    ]);

    const dir = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { agents, conversation, ref } = yield* askConversation(
            "shell",
            "touch a file"
          );
          const cwd = conversation.sandbox?.id;
          expect(cwd).toBeDefined();
          yield* waitUntil(
            agents
              .pendingApprovals(conversation.id)
              .pipe(Effect.map((count) => count === 1))
          );
          const key = yield* waitUntil(
            pendingKey(ref).pipe(Effect.map((k) => k !== undefined))
          ).pipe(Effect.andThen(pendingKey(ref)));
          expect(key).toMatch(/^\d+:call-bash$/u);
          yield* agents.decide(conversation.id, key as string, "approve");
          yield* waitUntil(hasRunEnd(ref));
          const results = yield* toolResults(ref);
          expect(results[0]?.isError).not.toBeTruthy();
          return cwd;
        })
      ).pipe(Effect.provide(layer))
    );

    expect(dir).toBeDefined();
    expect(sandboxes.live.size).toBe(0);
  });

  it("denies a gated call and the conversation continues", async () => {
    const { layer } = fauxAgents([
      callTool("bash", { command: "touch denied.txt" }),
      echoToolResult,
    ]);

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { agents, conversation, ref } = yield* askConversation(
            "shell",
            "touch a file"
          );
          const cwd = conversation.sandbox?.id ?? "";
          yield* waitUntil(
            agents
              .pendingApprovals(conversation.id)
              .pipe(Effect.map((count) => count === 1))
          );
          const key = yield* pendingKey(ref);
          yield* agents.decide(conversation.id, key as string, "deny");
          yield* waitUntil(hasRunEnd(ref));
          const results = yield* toolResults(ref);
          expect(results[0]?.isError).toBeTruthy();
          expect(JSON.stringify(results[0]?.content)).toContain("denied");
          expect(existsSync(path.join(cwd, "denied.txt"))).toBeFalsy();
          // The model got the error result and answered afterwards.
          const texts = yield* assistantTexts(ref);
          expect(texts.at(-1)).toContain("denied");
        })
      ).pipe(Effect.provide(layer))
    );
  });

  it("always flips the policy: later calls in the same run never wait", async () => {
    const { layer } = fauxAgents([
      callTool("bash", { command: "touch one.txt" }),
      callTool("bash", { command: "touch two.txt" }),
      echoToolResult,
    ]);

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { agents, conversation, ref } = yield* askConversation(
            "shell",
            "touch two files"
          );
          const cwd = conversation.sandbox?.id ?? "";
          yield* waitUntil(
            agents
              .pendingApprovals(conversation.id)
              .pipe(Effect.map((count) => count === 1))
          );
          const key = yield* pendingKey(ref);
          yield* agents.decide(conversation.id, key as string, "always");
          // The run must complete with no second pending entry: policy is now auto.
          yield* waitUntil(hasRunEnd(ref));
          expect(existsSync(path.join(cwd, "one.txt"))).toBeTruthy();
          expect(existsSync(path.join(cwd, "two.txt"))).toBeTruthy();
          expect(yield* agents.pendingApprovals(conversation.id)).toBe(0);
        })
      ).pipe(Effect.provide(layer))
    );
  });

  it("always also approves the other calls already waiting in the same round", async () => {
    const { layer } = fauxAgents([
      fauxAssistantMessage(
        [
          fauxToolCall("bash", { command: "touch one.txt" }, { id: "one" }),
          fauxToolCall("bash", { command: "touch two.txt" }, { id: "two" }),
        ],
        { stopReason: "toolUse" }
      ),
      echoToolResult,
    ]);

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { agents, conversation, ref } = yield* askConversation(
            "shell",
            "touch two files"
          );
          const cwd = conversation.sandbox?.id ?? "";
          yield* waitUntil(
            agents
              .pendingApprovals(conversation.id)
              .pipe(Effect.map((count) => count === 2))
          );
          yield* agents.decide(
            conversation.id,
            approvalKey(conversation.id, "one"),
            "always"
          );
          yield* waitUntil(hasRunEnd(ref));
          expect(existsSync(path.join(cwd, "one.txt"))).toBeTruthy();
          expect(existsSync(path.join(cwd, "two.txt"))).toBeTruthy();
        })
      ).pipe(Effect.provide(layer))
    );
  });

  it("fails decide with ApprovalNotFound for an unknown key", async () => {
    const { layer } = fauxAgents([answer("hi")]);

    const exit = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const agents = yield* Agents;
          const conversation = yield* agents.start({
            sandbox: "none",
            approvals: "ask",
          });
          return yield* Effect.exit(
            agents.decide(conversation.id, "1:nope", "approve")
          );
        })
      ).pipe(Effect.provide(layer))
    );

    expect(Exit.isFailure(exit)).toBeTruthy();
    expect(JSON.stringify(exit)).toContain("ApprovalNotFound");
  });

  it("does not run the tool when the call context is already aborted", async () => {
    const doc = { policy: "ask", pending: {}, decisions: {} };
    let ran = false;
    const api = fakeApi(doc);
    const tool = withApproval(fakeTool(() => (ran = true)));
    const controller = new AbortController();
    controller.abort();
    await expect(
      tool.execute(
        {},
        api as never,
        { abortSignal: controller.signal } as never
      )
    ).rejects.toThrow("abort");
    expect(ran).toBeFalsy();
  });

  it("fails closed when watchDoc cannot watch the approval doc", async () => {
    const doc = { policy: "ask", pending: {}, decisions: {} };
    let ran = false;
    const api = { ...fakeApi(doc), watchDoc: () => Promise.resolve() };
    const tool = withApproval(fakeTool(() => (ran = true)));
    await expect(
      tool.execute({}, api as never, { abortSignal: undefined } as never)
    ).rejects.toThrow("Could not wait for approval");
    expect(ran).toBeFalsy();
    // The failed call is not left listed as awaiting approval.
    expect(doc.pending).toStrictEqual({});
  });

  it("runs without waiting when the committed policy is auto", async () => {
    // The policy is read in the same commit that would register the call.
    const doc = { policy: "auto", pending: {}, decisions: {} };
    let ran = false;
    const tool = withApproval(fakeTool(() => (ran = true)));
    await tool.execute(
      {},
      fakeApi(doc) as never,
      { abortSignal: undefined } as never
    );
    expect(ran).toBeTruthy();
    expect(doc.pending).toStrictEqual({});
  });

  it("stops a pending call cleanly when the conversation ends", async () => {
    const agents = fauxAgents([
      callTool("bash", { command: "sleep 30" }),
      echoToolResult,
    ]);
    const layer = Conversations.layer({
      maxSandboxes: 3,
      idleTimeoutMs: 60_000,
      sweepEveryMs: 60_000,
    }).pipe(Layer.provide(agents.layer));

    await Effect.runPromise(
      Effect.gen(function* () {
        const conversations = yield* Conversations;
        const created = yield* conversations.create({
          sandbox: "shell",
          prompt: "sleep",
          approvals: "ask",
        });
        yield* waitUntil(
          conversations.list.pipe(
            Effect.map((all) => all[0]?.pendingApprovals === 1)
          )
        );
        yield* conversations.end(created.id);
        const listed = yield* conversations.list;
        expect(listed[0]?.status).toBe("ended");
        expect(listed[0]?.pendingApprovals).toBe(0);
        // The pending doc entry was cleaned up too.
        const agentsService = yield* Agents;
        expect(
          yield* agentsService.pendingApprovals(created.id as ConversationId)
        ).toBe(0);
      }).pipe(Effect.provide(Layer.merge(layer, agents.layer)))
    );
  }, 30_000);
});
