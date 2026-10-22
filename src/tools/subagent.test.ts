import { existsSync } from "node:fs";
import path from "node:path";

// `task`: a subagent works a child conversation on the parent's machine — its own context, the parent's files,
// tools and skills — and reports back, while its gated calls wait on the root conversation's approval doc.
// Several `task` calls in one round run in parallel, bounded by MAX_SUBAGENTS. See docs/plans/subagents.md.
// Regression coverage for https://github.com/juancuiule/pi/issues/73.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type { AgentEvent, ConversationId } from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { Effect, Layer, Ref, Scope, Stream } from "effect";
import { describe, expect, it } from "vitest";

import { Agents } from "../agents/agents.ts";
import type { ApprovalPolicy } from "../approvals.ts";
import { approvalKey } from "../approvals.ts";
import type { SandboxChoice } from "../sandbox/sandbox.ts";
import { Skills } from "../skills/skills.ts";
import { SkillSource } from "../skills/source.ts";
import {
  callTool,
  echoToolResult,
  fauxAgents,
  offered,
  openSeat,
} from "../testing/faux.ts";
import { MAX_SUBAGENTS } from "./subagent.ts";
import { UPGRADE_WORKSPACE } from "./workspace.ts";

const skillsLayer = Skills.layer.pipe(
  Layer.provide(
    SkillSource.memory({
      "reviewer/SKILL.md": `---
name: reviewer
description: Review code.
---

# Reviewer
`,
    })
  )
);

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

/** Open a Seat, collect its events, and send prompts whose turns are scripted in `fauxAgents`. */
const start = (options: {
  readonly sandbox?: SandboxChoice;
  readonly approvals?: ApprovalPolicy;
}) =>
  Effect.gen(function* () {
    const agents = yield* Agents;
    const seat = yield* openSeat(options);
    const ref = yield* Ref.make<AgentEvent[]>([]);
    const events = yield* agents.events(seat.id);
    const scope = yield* Scope.Scope;
    yield* Stream.runForEach(events, (event) =>
      Ref.update(ref, (all) => [...all, event])
    ).pipe(Effect.forkIn(scope));
    return { agents, seat, ref };
  });

const hasRunEnd = (ref: Ref.Ref<AgentEvent[]>) =>
  waitUntil(
    Ref.get(ref).pipe(
      Effect.map((all) => all.some((event) => event.type === "run_end"))
    )
  );

/** The committed tool results the run produced, in order. */
const toolResults = (ref: Ref.Ref<AgentEvent[]>) =>
  Effect.map(Ref.get(ref), (all) =>
    all.flatMap((event) =>
      event.type === "tool_execution_end" && event.entry !== undefined
        ? (event.entry.model ?? []).flatMap((m) =>
            m.role === "toolResult" ? [m] : []
          )
        : []
    )
  );

const textOf = (
  message: { content: readonly { type: string }[] } | undefined
) =>
  (message?.content ?? [])
    .flatMap((c) => ("text" in c && typeof c.text === "string" ? [c.text] : []))
    .join("");

const detailsId = (details: unknown) =>
  typeof details === "object" && details !== null
    ? (details as { conversationId?: unknown }).conversationId
    : undefined;

/** The child id a `task` call published in its details — live first, or committed with the result. */
const childIdOf = (
  events: readonly AgentEvent[]
): ConversationId | undefined => {
  for (const event of events) {
    if (event.type === "tool_execution_update" && event.toolName === "task") {
      const id = detailsId(event.details);
      if (typeof id === "number") {
        return id as ConversationId;
      }
    }
    if (event.type === "tool_execution_end" && event.entry !== undefined) {
      for (const m of event.entry.model ?? []) {
        if (m.role === "toolResult") {
          const id = detailsId(m.details);
          if (typeof id === "number") {
            return id as ConversationId;
          }
        }
      }
    }
  }
  return undefined;
};

/** Die unless a child id was published; narrows the type for the caller. */
const needChild = (events: readonly AgentEvent[]) => {
  const id = childIdOf(events);
  return id === undefined
    ? Effect.die(
        new Error("no child conversation id in the task call's details")
      )
    : Effect.succeed(id);
};

const delegate = (prompt: string, id = "call-task") =>
  fauxAssistantMessage([fauxToolCall("task", { prompt }, { id })], {
    stopReason: "toolUse",
  });

describe("task", () => {
  it("returns the child's answer, publishes its conversation id, and keeps the child unlisted", async () => {
    const { faux, layer } = fauxAgents([
      delegate("Name a prime."),
      // The subagent's turn.
      fauxAssistantMessage([fauxText("7")]),
      echoToolResult,
    ]);
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { agents, seat, ref } = yield* start({});
          const answer = yield* seat.ask("Use a task to name a prime.");
          yield* hasRunEnd(ref);
          const events = yield* Ref.get(ref);
          const childId = childIdOf(events);
          const listed = (yield* agents.list).map((record) =>
            Number(record.id)
          );
          return { answer, events, childId, listed, seatId: seat.id };
        })
      ).pipe(Effect.provide(layer))
    );
    expect(result.answer).toBe("7");
    expect(result.childId).toBeDefined();
    // The child is task-owned: it never appears in the top-level list.
    expect(result.listed).toStrictEqual([Number(result.seatId)]);
    // The console attaches to the child through the call's details.
    const update = result.events.find(
      (event) =>
        event.type === "tool_execution_update" && event.toolName === "task"
    );
    expect(
      update?.type === "tool_execution_update"
        ? detailsId(update.details)
        : undefined
    ).toBe(result.childId);
    expect(faux.getPendingResponseCount()).toBe(0);
  });

  it("streams the child's transcript through its own events, as the console does", async () => {
    const { layer } = fauxAgents([
      delegate("Name a prime."),
      fauxAssistantMessage([fauxText("7")]),
      echoToolResult,
    ]);
    const childTexts = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { agents, seat, ref } = yield* start({});
          yield* seat.ask("Use a task to name a prime.");
          yield* hasRunEnd(ref);
          const childId = yield* needChild(yield* Ref.get(ref));
          const childEvents = yield* agents.events(childId);
          const [snapshot] = [
            ...(yield* childEvents.pipe(Stream.take(1), Stream.runCollect)),
          ];
          if (snapshot?.type !== "snapshot") {
            return yield* Effect.die(new Error("expected a snapshot first"));
          }
          return snapshot.entries.flatMap((entry) => {
            const message = entry.model?.[0];
            return message?.role === "assistant"
              ? message.content.flatMap((block) =>
                  block.type === "text" ? [block.text] : []
                )
              : [];
          });
        })
      ).pipe(Effect.provide(layer))
    );
    expect(childTexts).toStrictEqual(["7"]);
  });

  it("runs several in parallel and fails the fifth — at most MAX_SUBAGENTS at once", async () => {
    const storage = new MemoryStorage();
    const fanout = fauxAssistantMessage(
      [1, 2, 3, 4, 5].map((n) =>
        fauxToolCall("task", { prompt: `part ${n}` }, { id: `call-task-${n}` })
      ),
      { stopReason: "toolUse" }
    );
    const { layer } = fauxAgents(
      [
        fanout,
        // One scripted answer per admitted child; which child gets which does not matter.
        ...Array.from({ length: MAX_SUBAGENTS }, (): FauxResponseStep =>
          fauxAssistantMessage([fauxText("done")])
        ),
        echoToolResult,
      ],
      { storage }
    );
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { seat, ref } = yield* start({});
          yield* seat.ask("fan out five tasks");
          yield* hasRunEnd(ref);
          const results = yield* toolResults(ref);
          const children = yield* Effect.promise(() =>
            storage.scanConversations(
              { ownerConversationId: seat.id },
              10,
              undefined,
              BACKGROUND_CONTEXT
            )
          );
          return { results, children };
        })
      ).pipe(Effect.provide(layer))
    );
    expect(result.results).toHaveLength(MAX_SUBAGENTS + 1);
    const capped = result.results.filter((message) => message.isError);
    expect(capped).toHaveLength(1);
    expect(textOf(capped[0])).toContain("Too many subagents");
    // The capped call created no child.
    expect(result.children.items).toHaveLength(MAX_SUBAGENTS);
  });

  it("gives the child the parent's tools minus task and upgrade_workspace", async () => {
    const { layer } = fauxAgents(
      [delegate("List your tools."), offered, echoToolResult],
      { skills: skillsLayer }
    );
    const answer = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { seat } = yield* start({});
          return yield* seat.ask("delegate a tool inventory");
        })
      ).pipe(Effect.provide(layer))
    );
    const { tools, system } = JSON.parse(answer) as {
      tools: string[];
      system: { sections?: Record<string, string> }[];
    };
    expect(tools).not.toContain("task");
    expect(tools).not.toContain(UPGRADE_WORKSPACE);
    expect(tools).toContain("ask_user");
    // The parent's skills were copied into the child's SkillsDoc at creation.
    const sections: Record<string, string> = {};
    for (const message of system) {
      Object.assign(sections, message.sections ?? {});
    }
    expect(sections.skills).toContain("reviewer");
  });

  it("gates the child's calls on the parent's doc, and the child works in the parent's sandbox", async () => {
    const { layer, sandboxes } = fauxAgents([
      delegate("touch child.txt"),
      callTool("write", { path: "child.txt", content: "made by the child" }),
      echoToolResult,
      echoToolResult,
    ]);
    const dir = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { seat, ref } = yield* start({
            sandbox: "shell",
            approvals: "ask",
          });
          yield* seat.send("delegate a write");
          // The child's `write` parks on the parent conversation's doc.
          yield* waitUntil(
            seat.pendingApprovals.pipe(Effect.map((count) => count === 1))
          );
          const childId = yield* needChild(yield* Ref.get(ref));
          yield* seat.decide(approvalKey(childId, "call-write"), "approve");
          yield* hasRunEnd(ref);
          const results = yield* toolResults(ref);
          expect(
            results.find((m) => m.toolCallId === "call-task")?.isError
          ).not.toBeTruthy();
          const [mounted] = [...sandboxes.live];
          if (mounted === undefined) {
            return yield* Effect.die(new Error("no sandbox mounted"));
          }
          return mounted;
        })
      ).pipe(Effect.provide(layer))
    );
    // One sandbox exists — the parent's — and it holds the child's file.
    expect(existsSync(path.join(dir, "child.txt"))).toBeTruthy();
  });

  it("routes the child's ask_user through the parent's doc", async () => {
    const question = {
      id: "db",
      question: "Which database?",
      options: [{ label: "SQLite" }, { label: "Postgres" }],
    };
    const { layer } = fauxAgents([
      delegate("Ask which database."),
      callTool("ask_user", { questions: [question] }),
      // The child echoes the answers it got.
      echoToolResult,
      echoToolResult,
    ]);
    const answer = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { seat, ref } = yield* start({ approvals: "ask" });
          yield* seat.send("delegate a question");
          yield* waitUntil(
            seat.pendingApprovals.pipe(Effect.map((count) => count === 1))
          );
          const events = yield* Ref.get(ref);
          const childId = yield* needChild(events);
          yield* seat.answer(approvalKey(childId, "call-ask_user"), [
            { id: "db", selected: ["SQLite"] },
          ]);
          yield* hasRunEnd(ref);
          const results = yield* toolResults(ref);
          return textOf(results.find((m) => m.toolCallId === "call-task"));
        })
      ).pipe(Effect.provide(layer))
    );
    expect(answer).toContain("SQLite");
  });

  it("aborts the child when the person stops the parent", async () => {
    const { layer } = fauxAgents([
      delegate("touch later.txt"),
      callTool("write", { path: "later.txt", content: "x" }),
    ]);
    const { messages, remaining } = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { seat, ref } = yield* start({
            sandbox: "shell",
            approvals: "ask",
          });
          yield* seat.send("delegate a write");
          yield* waitUntil(
            seat.pendingApprovals.pipe(Effect.map((count) => count === 1))
          );
          yield* seat.stop;
          yield* hasRunEnd(ref);
          return {
            messages: yield* toolResults(ref),
            remaining: yield* seat.pendingApprovals,
          };
        })
      ).pipe(Effect.provide(layer))
    );
    expect(remaining).toBe(0);
    const taskResult = messages.find((m) => m.toolCallId === "call-task");
    expect(taskResult?.isError).toBeTruthy();
  });

  it("marks the child's submission with a replayable request id", async () => {
    const storage = new MemoryStorage();
    const { layer } = fauxAgents(
      [
        delegate("Name a prime."),
        fauxAssistantMessage([fauxText("7")]),
        echoToolResult,
      ],
      { storage }
    );
    const requestIds = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { seat, ref } = yield* start({});
          yield* seat.ask("delegate");
          yield* hasRunEnd(ref);
          const childId = yield* needChild(yield* Ref.get(ref));
          const submissions = yield* Effect.promise(() =>
            storage.scanSubmissions(
              { conversationId: childId },
              10,
              undefined,
              BACKGROUND_CONTEXT
            )
          );
          return submissions.items.map((record) => record.requestId);
        })
      ).pipe(Effect.provide(layer))
    );
    // A rerun of this call finds both the child and the submission it already made.
    expect(requestIds).toStrictEqual([expect.stringMatching(/^subagent:/u)]);
  });
});
