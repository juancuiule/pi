# Agent Console Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local web UI (Next.js + shadcn + Tailwind) to run several effect-pi agent conversations at once and watch every event of every turn live, backed by a new Effect HTTP server.

**Architecture:** A long-running Effect server (`server.ts`, `:4000`) owns the pi-durable harness through the existing `Agents` service and a new `Conversations` registry (one `Scope` per conversation). It exposes a schema-first `HttpApi` under `/api`. Events are pi-durable's `AgentEvent`s from `watchEvents`, relayed as SSE. `web/` is a Next.js App Router package (`:3001`). It proxies `/api/*` to the server, calls it through a typed `HttpApiClient` derived from the shared API definition, keeps REST state in TanStack Query, and folds SSE events into a Zustand store with a pure `applyEvent`.

**Tech Stack:**

- Server: Effect 4.0.2 (`effect/http`, `effect/http-api`), `@effect/platform-node` 4.0.2, pi-durable 1.1.0, vitest 5.
- Web: Next.js 16.4, React 19, Tailwind 4, shadcn/ui, TanStack Query 5, Zustand 5, `@xterm/xterm` 6, `next-themes`.

**Spec:** `docs/superpowers/specs/2026-10-11-agent-console-design.md`

## Global Constraints

- Use pnpm, never npm or yarn. Pin new direct dependencies to exact versions.
- Before writing Effect code, read `repos/effect/LLMS.md`. Effect HTTP reference: `repos/effect/packages/effect/HTTPAPI.md` and `repos/effect/packages/platform/node/test/HttpApi.test.ts`. If an Effect API name in this plan does not typecheck, find the real one in `repos/effect/packages/effect/src/` instead of guessing.
- pi-durable reference: `repos/pi/packages/durable/src/harness/events.ts` (`watchEvents`, `AgentEvent`), `repos/pi/packages/durable/src/harness/types.ts` (`Conversation.submit`, `whenBusy`).
- Do not edit anything under `repos/`. Do not import from `repos/`.
- Root code: Node strip-only TypeScript (erasable syntax only), `.ts` extensions in imports, top-level imports only.
- Server port `4000`, web port `3001` (Langfuse uses `3000`). The web app reaches the server only through `/api/*` rewrites.
- Sandbox cap default: `3` live sandboxed conversations. Idle timeout default: 30 minutes. Sweep interval: 1 minute.
- Title: the first prompt, truncated to 60 characters (59 characters + `…` when longer).
- Wire format: one pi-durable `AgentEvent` per SSE message, JSON in `data`. The first event of every stream is `snapshot`.
- Tests never call a real model: faux provider and `localSandboxes()` only (`src/testing/`).
- Run `pnpm check` after each task. It must pass before committing. Lefthook runs format, lint, typecheck and tests on commit. Never skip hooks.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **SSE through the Next proxy.** Events must arrive incrementally at `:3001/api/.../events`, not buffered until the stream ends. Next compression can buffer, so set `compress: false`. Task 4 pins this with a `curl -N` check, and Task 3 tests the stream end to end.
2. **Concurrent creates beyond the sandbox cap.** Two "New shell" clicks at once must not both pass the cap check while the first sandbox is still being created. Task 2 tests concurrent creates with `maxSandboxes: 1`.
3. **A busy conversation is never swept as idle.** A long `bash` call emits no events for minutes, so the idle sweep must skip `running` conversations. Task 2 tests a running conversation surviving past the timeout.
4. **Reconnect after refresh or a server restart.** A new SSE connection must rebuild state from `snapshot` without duplicating entries. A 404 after a server restart must show "conversation ended", not retry forever. Task 5 tests `snapshot` resetting state and `entry_appended`/`message_end` deduplication.
5. **Shutdown leaves no containers.** Ctrl-C on `pnpm server` (or `node --watch` restarting it) must remove every sandbox. Task 2 tests that tearing the layer down removes all local sandboxes, and Task 3 runs the server through `NodeRuntime.runMain`, which runs finalizers on SIGINT/SIGTERM.

---

## File Structure

Root (server):

| File | Responsibility |
| --- | --- |
| `src/errors.ts` (create) | Dependency-free tagged errors shared by the server and the API definition: `ConversationNotFound`, `SandboxLimitReached` |
| `src/agents.ts` (modify) | `Agents.events(id)`, `AgentConversation.send(prompt)`; the `subagent` tool reports its child's id as `details` |
| `src/agents.events.test.ts` (create) | Tests for events, send, and subagent details |
| `src/server/conversations.ts` (create) | `Conversations` service: the registry of live conversations, status tracking, sandbox cap, idle sweep, end |
| `src/server/conversations.test.ts` (create) | Its tests |
| `src/server/api.ts` (create) | `HttpApi` definition + schemas + re-exported pi types. Imported by `web/`, so it must not import runtime code from pi-durable or `src/agents.ts` |
| `src/server/handlers.ts` (create) | `HttpApiBuilder` groups and `apiLayer` |
| `src/server/faux.ts` (create) | Echo faux model for running without a configured model |
| `src/server/server.test.ts` (create) | HTTP integration tests through `HttpApiClient` |
| `server.ts` (create) | Entry: env model or faux, Docker sandboxes, Langfuse, `NodeHttpServer` on `:4000` |
| `package.json`, `pnpm-workspace.yaml`, `tsconfig.json`, `oxlint.config.ts`, `oxfmt.config.ts`, `lefthook.yml`, `.gitignore`, `AGENTS.md` (modify) | Workspace, scripts, exports, tooling |

Web (`web/`):

| File | Responsibility |
| --- | --- |
| `web/next.config.ts` | Rewrites `/api/*` → `:4000`, `transpilePackages`, `compress: false` |
| `web/lib/api.ts` | Typed client + `runApi` |
| `web/lib/queries.ts` | TanStack Query hooks |
| `web/lib/conversation-state.ts` (+ `.test.ts`) | Pure `applyEvent` and transcript helpers |
| `web/lib/store.ts` | Zustand store keyed by conversation id |
| `web/lib/use-conversation-events.ts` | SSE subscription hook with reconnect |
| `web/lib/terminal.ts` (+ `.test.ts`) | Pure bash-log rendering for the shell panel |
| `web/lib/vnc.ts` (+ `.test.ts`) | Pure view-only URL helper |
| `web/app/layout.tsx`, `web/app/providers.tsx`, `web/app/page.tsx` | Shell, providers, the console page |
| `web/components/console/*.tsx` | Sidebar, new conversation, header, transcript, tool call, subagent, input, desktop panel, terminal panel |

---

### Task 1: Events, follow-ups and subagent ids in `Agents`

**Files:**

- Create: `src/errors.ts`
- Modify: `src/agents.ts`
- Test: `src/agents.events.test.ts`

**Interfaces:**

- Consumes: `fauxAgents`, `callTool`, `echoToolResult` from `src/testing/faux.ts` (existing).
- Produces:
  - `src/errors.ts`: `class ConversationNotFound extends Schema.TaggedError` with `{ id: number }`.
  - `AgentConversation.send(prompt: string): Effect.Effect<void, AgentError>`, which submits with `whenBusy: "followUp"` and does not wait.
  - `Agents` service method `events(id: ConversationId): Effect.Effect<Stream.Stream<AgentEvent, AgentError>, AgentError | ConversationNotFound>`. The stream's first element is the `snapshot`, followed by every event of later commits.
  - The `subagent` tool calls `api.details({ conversationId: child })` as soon as the child exists, so a `tool_execution_update` with `details.conversationId` (a number) reaches the parent's stream.

- [ ] **Step 1: Write the failing tests**

`src/agents.events.test.ts`:

```ts
import {
  fauxAssistantMessage,
  fauxText,
} from "@earendil-works/pi-ai/providers/faux";
import type { AgentEvent } from "@earendil-works/pi-durable";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Effect, Exit, Stream } from "effect";
import { describe, expect, it } from "vitest";

import { Agents } from "./agents.ts";
import { callTool, echoToolResult, fauxAgents } from "./testing/faux.ts";

const assistantTexts = (events: readonly AgentEvent[]) =>
  events.flatMap((event) => {
    if (event.type !== "message_end") {
      return [];
    }
    const message = event.entry.model?.[0];
    return message?.role === "assistant"
      ? [
          message.content
            .flatMap((c) => (c.type === "text" ? [c.text] : []))
            .join(""),
        ]
      : [];
  });

describe("Agents.events", () => {
  it("starts with a snapshot and streams the run a prompt starts", async () => {
    const { layer } = fauxAgents([fauxAssistantMessage([fauxText("Paris.")])]);

    const events = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const agents = yield* Agents;
          const conversation = yield* agents.start({ sandbox: "none" });
          const stream = yield* agents.events(conversation.id);
          yield* conversation.send("Capital of France?");
          return yield* stream.pipe(
            Stream.takeUntil((event) => event.type === "run_end"),
            Stream.runCollect
          );
        })
      ).pipe(Effect.provide(layer))
    );

    const types = Array.from(events, (event) => event.type);
    expect(types[0]).toBe("snapshot");
    expect(types).toContain("run_start");
    expect(types.at(-1)).toBe("run_end");
    expect(assistantTexts(Array.from(events))).toEqual(["Paris."]);
  });

  it("queues a prompt sent while the agent runs and answers both", async () => {
    const { layer } = fauxAgents([
      fauxAssistantMessage([fauxText("one")]),
      fauxAssistantMessage([fauxText("two")]),
    ]);

    const texts = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const agents = yield* Agents;
          const conversation = yield* agents.start({ sandbox: "none" });
          const stream = yield* agents.events(conversation.id);
          yield* conversation.send("first");
          yield* conversation.send("second");
          const seen: AgentEvent[] = [];
          yield* stream.pipe(
            Stream.takeUntil((event) => {
              seen.push(event);
              return assistantTexts(seen).length === 2;
            }),
            Stream.runDrain
          );
          return assistantTexts(seen);
        })
      ).pipe(Effect.provide(layer))
    );

    expect(texts).toEqual(["one", "two"]);
  });

  it("fails with ConversationNotFound for an unknown id", async () => {
    const { layer } = fauxAgents([]);

    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const agents = yield* Agents;
        return yield* agents.events(999_999 as ConversationId);
      }).pipe(Effect.provide(layer))
    );

    expect(Exit.isFailure(exit)).toBe(true);
    expect(JSON.stringify(exit)).toContain("ConversationNotFound");
  });

  it("reports a subagent's conversation id, whose events can be watched", async () => {
    const { layer } = fauxAgents([
      callTool("subagent", { task: "Name a prime." }),
      fauxAssistantMessage([fauxText("7")]),
      echoToolResult,
    ]);

    const childTexts = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const agents = yield* Agents;
          const conversation = yield* agents.start({ sandbox: "none" });
          const stream = yield* agents.events(conversation.id);
          yield* conversation.send("Use a subagent to name a prime.");
          const events = Array.from(
            yield* stream.pipe(
              Stream.takeUntil((event) => event.type === "run_end"),
              Stream.runCollect
            )
          );
          const child = events.flatMap((event) =>
            event.type === "tool_execution_update" &&
            typeof event.details === "object" &&
            event.details !== null &&
            "conversationId" in event.details
              ? [event.details.conversationId]
              : []
          )[0];
          expect(typeof child).toBe("number");
          const childStream = yield* agents.events(child as ConversationId);
          const [snapshot] = Array.from(
            yield* childStream.pipe(Stream.take(1), Stream.runCollect)
          );
          if (snapshot?.type !== "snapshot") {
            throw new Error("expected a snapshot first");
          }
          return snapshot.entries.flatMap((entry) => {
            const message = entry.model?.[0];
            return message?.role === "assistant"
              ? message.content.flatMap((c) =>
                  c.type === "text" ? [c.text] : []
                )
              : [];
          });
        })
      ).pipe(Effect.provide(layer))
    );

    expect(childTexts).toEqual(["7"]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/agents.events.test.ts` Expected: FAIL. TypeScript/vitest reports `agents.events` and `conversation.send` do not exist.

- [ ] **Step 3: Create `src/errors.ts`**

```ts
// Errors the server reports to clients. Kept free of runtime dependencies so web/ can import them through the API
// definition.
import { Schema } from "effect";

export class ConversationNotFound extends Schema.TaggedError<ConversationNotFound>()(
  "ConversationNotFound",
  { id: Schema.Number }
) {}
```

- [ ] **Step 4: Report the child id from the `subagent` tool**

In `src/agents.ts`, inside `Subagent`'s `execute`, right after the `const child = await api.commit(...)` block and before `api.conversation(child, ...)`:

```ts
// Lets a UI find and watch the child conversation while it works.
await api.details({ conversationId: child }, callContext);
```

- [ ] **Step 5: Add `send` and `events`**

In `src/agents.ts`:

1. Extend the imports:
   - From `@earendil-works/pi-durable`, add `watchEvents` to the value imports and `AgentEvent` to the type imports.
   - From `effect`, add `Queue` and `Stream`.
   - Add `import { ConversationNotFound } from "./errors.ts";`.
2. Add the `send` helper next to `askIn`:

```ts
const sendIn = (conversation: Conversation, tracing: AgentTracing) =>
  Effect.fn("AgentConversation.send")(function* (prompt: string) {
    yield* Effect.annotateCurrentSpan({
      "langfuse.observation.type": "agent",
      "langfuse.observation.input": prompt,
      "langfuse.session.id": String(conversation.id),
    });
    // Admitted without waiting: a busy conversation queues it as a follow-up, and the answer arrives as events.
    yield* tracing.traced(
      conversation.id,
      Effect.tryPromise({
        try: () =>
          conversation.submit(
            { type: "input", content: prompt, whenBusy: "followUp" },
            context
          ),
        catch: (cause) => new AgentError({ cause }),
      })
    );
  });
```

3. Add `send` to `AgentConversation`:

```ts
  /** Send a prompt without waiting for the answer; it is queued as a follow-up while the agent runs. */
  send(prompt: string): Effect.Effect<void, AgentError>;
```

4. Add to the `Agents` service shape, after `start`:

```ts
    /**
     * Watch a conversation, including a subagent's: a `snapshot` first, then the events of every later commit.
     * Interrupting the stream stops the watch.
     */
    events(
      id: ConversationId
    ): Effect.Effect<
      Stream.Stream<AgentEvent, AgentError>,
      AgentError | ConversationNotFound
    >;
```

5. Inside `Layer.effect`, after `start`:

```ts
const events = Effect.fn("Agents.events")(function* (id: ConversationId) {
  const handle = yield* Effect.tryPromise({
    try: () => harness.conversation(id, context),
    catch: (cause) => new AgentError({ cause }),
  });
  if (handle === undefined) {
    return yield* new ConversationNotFound({ id: Number(id) });
  }
  return Stream.callback<AgentEvent, AgentError>((queue) =>
    Effect.acquireRelease(
      Effect.tryPromise({
        try: async () => {
          const watch = await watchEvents(harness, id, context);
          Queue.offerUnsafe(queue, watch.snapshot);
          watch.start(async (batch) => {
            Queue.offerAllUnsafe(queue, batch);
          });
          void watch.closed.then(() => Queue.endUnsafe(queue));
          return watch;
        },
        catch: (cause) => new AgentError({ cause }),
      }),
      (watch) => Effect.promise(() => watch.stop())
    )
  );
});
```

Return `Agents.of({ start, events })`. In `start`'s result, add `send: sendIn(conversation, tracing),`. If `harness.conversation` or `watchEvents` reject the `harness` type, check `Harness.open`'s return type in `repos/pi/packages/durable/src/harness/harness.ts`. If `Queue.offerAllUnsafe` doesn't exist, check `repos/effect/packages/effect/src/Queue.ts`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm vitest run src/agents.events.test.ts src/agents.test.ts` Expected: PASS (all tests, including the existing ones).

- [ ] **Step 7: Run `pnpm check` and commit**

```bash
pnpm check
git add src/errors.ts src/agents.ts src/agents.events.test.ts
git commit -m "Stream agent events and send follow-ups from Agents

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: `Conversations` registry

**Files:**

- Modify: `src/errors.ts`
- Create: `src/server/conversations.ts`
- Test: `src/server/conversations.test.ts`

**Interfaces:**

- Consumes: `Agents.start`, `Agents.events`, `AgentConversation.send` (Task 1); `ConversationNotFound` (Task 1).
- Produces:
  - `src/errors.ts`: `class SandboxLimitReached extends Schema.TaggedError` with `{ limit: number }`.
  - `src/server/conversations.ts`:

```ts
export type ConversationStatus = "running" | "idle";
export interface ConversationSummary {
  readonly id: number;
  readonly sandbox: SandboxChoice;
  readonly sandboxId?: string;
  readonly vncUrl?: string;
  readonly title: string;
  readonly status: ConversationStatus;
  readonly createdAt: number;
}
export const titleOf: (prompt: string) => string;
export class Conversations extends Context.Service<Conversations, {
  create(input: { readonly sandbox: SandboxChoice; readonly prompt: string }):
    Effect.Effect<ConversationSummary, AgentError | SandboxError | SandboxLimitReached>;
  readonly list: Effect.Effect<readonly ConversationSummary[]>;
  send(id: number, prompt: string): Effect.Effect<void, AgentError | ConversationNotFound>;
  events(id: number): Effect.Effect<Stream.Stream<AgentEvent, AgentError>, AgentError | ConversationNotFound>;
  end(id: number): Effect.Effect<void, ConversationNotFound>;
}>()("effect-pi/Conversations") {
  static readonly layer: (options: {
    readonly maxSandboxes: number;
    readonly idleTimeoutMs: number;
    readonly sweepEveryMs: number;
  }) => Layer.Layer<Conversations, never, Agents>;
}
```

- [ ] **Step 1: Write the failing tests**

`src/server/conversations.test.ts`:

```ts
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxText,
} from "@earendil-works/pi-ai/providers/faux";
import { Effect, Exit, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { callTool, echoToolResult, fauxAgents } from "../testing/faux.ts";
import { Conversations, titleOf } from "./conversations.ts";

const defaults = {
  maxSandboxes: 3,
  idleTimeoutMs: 60_000,
  sweepEveryMs: 60_000,
};

const setup = (
  responses: FauxResponseStep[],
  options: Partial<typeof defaults> = {}
) => {
  const agents = fauxAgents(responses);
  return {
    ...agents,
    layer: Conversations.layer({ ...defaults, ...options }).pipe(
      Layer.provide(agents.layer)
    ),
  };
};

/** Poll `check` until it returns true, failing after 3 seconds. */
const waitUntil = (check: Effect.Effect<boolean>) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 300; attempt++) {
      if (yield* check) {
        return;
      }
      yield* Effect.sleep("10 millis");
    }
    return yield* Effect.die(new Error("timed out waiting"));
  });

const answer = (text: string) => fauxAssistantMessage([fauxText(text)]);

describe(Conversations, () => {
  it("truncates long titles", () => {
    expect(titleOf("short")).toBe("short");
    expect(titleOf("x".repeat(80))).toBe(`${"x".repeat(59)}…`);
  });

  it("creates a conversation that runs its first prompt, then lists it as idle", async () => {
    const { layer } = setup([answer("hi")]);

    const listed = await Effect.runPromise(
      Effect.gen(function* () {
        const conversations = yield* Conversations;
        const created = yield* conversations.create({
          sandbox: "none",
          prompt: "Say hi",
        });
        expect(created.title).toBe("Say hi");
        yield* waitUntil(
          conversations.list.pipe(
            Effect.map((all) => all[0]?.status === "idle")
          )
        );
        return yield* conversations.list;
      }).pipe(Effect.provide(layer))
    );

    expect(listed).toHaveLength(1);
    expect(listed[0]?.sandbox).toBe("none");
  });

  it("ends a conversation, removing its sandbox", async () => {
    const { layer, sandboxes } = setup([answer("ok")]);

    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const conversations = yield* Conversations;
        const created = yield* conversations.create({
          sandbox: "shell",
          prompt: "hello",
        });
        expect(sandboxes.live.size).toBe(1);
        yield* conversations.end(created.id);
        expect(sandboxes.live.size).toBe(0);
        expect(yield* conversations.list).toHaveLength(0);
        return yield* Effect.exit(conversations.send(created.id, "again"));
      }).pipe(Effect.provide(layer))
    );

    expect(Exit.isFailure(exit)).toBe(true);
    expect(JSON.stringify(exit)).toContain("ConversationNotFound");
  });

  it("refuses sandboxes past the cap, even when created concurrently", async () => {
    const { layer } = setup([answer("a"), answer("b"), answer("c")], {
      maxSandboxes: 1,
    });

    const exits = await Effect.runPromise(
      Effect.gen(function* () {
        const conversations = yield* Conversations;
        const shells = yield* Effect.all(
          [
            Effect.exit(
              conversations.create({ sandbox: "shell", prompt: "1" })
            ),
            Effect.exit(
              conversations.create({ sandbox: "shell", prompt: "2" })
            ),
          ],
          { concurrency: "unbounded" }
        );
        // Conversations without a sandbox don't count.
        const none = yield* Effect.exit(
          conversations.create({ sandbox: "none", prompt: "3" })
        );
        return [...shells, none];
      }).pipe(Effect.provide(layer))
    );

    const failures = exits.filter(Exit.isFailure);
    expect(failures).toHaveLength(1);
    expect(JSON.stringify(failures[0])).toContain("SandboxLimitReached");
    expect(Exit.isSuccess(exits[2]!)).toBe(true);
  });

  it("sweeps idle conversations but never a running one", async () => {
    const { layer, sandboxes } = setup(
      [callTool("bash", { command: "sleep 0.4" }), echoToolResult],
      { idleTimeoutMs: 50, sweepEveryMs: 10 }
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const conversations = yield* Conversations;
        yield* conversations.create({ sandbox: "shell", prompt: "sleep" });
        // Past the idle timeout, but the bash call is still running.
        yield* Effect.sleep("200 millis");
        expect(yield* conversations.list).toHaveLength(1);
        yield* waitUntil(
          conversations.list.pipe(Effect.map((all) => all.length === 0))
        );
        expect(sandboxes.live.size).toBe(0);
      }).pipe(Effect.provide(layer))
    );
  });

  it("removes every sandbox when the layer is torn down", async () => {
    const { layer, sandboxes } = setup([answer("a"), answer("b")]);

    await Effect.runPromise(
      Effect.gen(function* () {
        const conversations = yield* Conversations;
        yield* conversations.create({ sandbox: "shell", prompt: "1" });
        yield* conversations.create({ sandbox: "shell", prompt: "2" });
        expect(sandboxes.live.size).toBe(2);
      }).pipe(Effect.provide(layer))
    );

    expect(sandboxes.live.size).toBe(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/server/conversations.test.ts` Expected: FAIL. `./conversations.ts` cannot be resolved.

- [ ] **Step 3: Add `SandboxLimitReached` to `src/errors.ts`**

```ts
export class SandboxLimitReached extends Schema.TaggedError<SandboxLimitReached>()(
  "SandboxLimitReached",
  { limit: Schema.Number }
) {}
```

- [ ] **Step 4: Implement `src/server/conversations.ts`**

```ts
// The server's live conversations. Each one owns a Scope holding its sandbox and the fiber that tracks its status;
// ending it, sweeping it after an idle timeout, or tearing down the layer closes that scope.
import type { AgentEvent, ConversationId } from "@earendil-works/pi-durable";
import {
  Clock,
  Context,
  Effect,
  Exit,
  Layer,
  Schedule,
  Scope,
  Stream,
} from "effect";

import { Agents } from "../agents.ts";
import type { AgentConversation, AgentError } from "../agents.ts";
import { ConversationNotFound, SandboxLimitReached } from "../errors.ts";
import type { SandboxChoice, SandboxError } from "../sandbox/sandbox.ts";

export type ConversationStatus = "running" | "idle";

export interface ConversationSummary {
  readonly id: number;
  readonly sandbox: SandboxChoice;
  readonly sandboxId?: string;
  readonly vncUrl?: string;
  readonly title: string;
  readonly status: ConversationStatus;
  readonly createdAt: number;
}

const TITLE_LENGTH = 60;

export const titleOf = (prompt: string): string => {
  const line = prompt.trim().replaceAll(/\s+/g, " ");
  return line.length <= TITLE_LENGTH
    ? line
    : `${line.slice(0, TITLE_LENGTH - 1)}…`;
};

interface Live {
  readonly conversation: AgentConversation;
  readonly scope: Scope.Closeable;
  readonly sandbox: SandboxChoice;
  readonly title: string;
  readonly createdAt: number;
  status: ConversationStatus;
  lastActivity: number;
}

const summaryOf = (id: number, live: Live): ConversationSummary => ({
  id,
  sandbox: live.sandbox,
  ...(live.conversation.sandbox === undefined
    ? {}
    : { sandboxId: live.conversation.sandbox.id }),
  ...(live.conversation.sandbox?.vncUrl === undefined
    ? {}
    : { vncUrl: live.conversation.sandbox.vncUrl }),
  title: live.title,
  status: live.status,
  createdAt: live.createdAt,
});

const statusAfter = (
  status: ConversationStatus,
  event: AgentEvent
): ConversationStatus => {
  switch (event.type) {
    case "snapshot": {
      return event.run === undefined ? "idle" : "running";
    }
    case "run_start": {
      return "running";
    }
    case "run_end": {
      return "idle";
    }
    default: {
      return status;
    }
  }
};

export class Conversations extends Context.Service<
  Conversations,
  {
    /** Start a conversation in a new sandbox and send its first prompt. */
    create(input: {
      readonly sandbox: SandboxChoice;
      readonly prompt: string;
    }): Effect.Effect<
      ConversationSummary,
      AgentError | SandboxError | SandboxLimitReached
    >;
    readonly list: Effect.Effect<readonly ConversationSummary[]>;
    send(
      id: number,
      prompt: string
    ): Effect.Effect<void, AgentError | ConversationNotFound>;
    /** Events of any conversation the harness knows, including a subagent's. */
    events(
      id: number
    ): Effect.Effect<
      Stream.Stream<AgentEvent, AgentError>,
      AgentError | ConversationNotFound
    >;
    /** End a conversation and remove its sandbox. */
    end(id: number): Effect.Effect<void, ConversationNotFound>;
  }
>()("effect-pi/Conversations") {
  static readonly layer = (options: {
    readonly maxSandboxes: number;
    readonly idleTimeoutMs: number;
    readonly sweepEveryMs: number;
  }) =>
    Layer.effect(
      Conversations,
      Effect.gen(function* () {
        const agents = yield* Agents;
        const live = new Map<number, Live>();
        // Sandboxes being created count against the cap, so concurrent creates cannot overshoot it.
        let creating = 0;

        const close = (id: number) =>
          Effect.suspend(() => {
            const entry = live.get(id);
            if (entry === undefined) {
              return Effect.void;
            }
            live.delete(id);
            return Scope.close(entry.scope, Exit.void);
          });

        yield* Effect.addFinalizer(() =>
          Effect.forEach([...live.keys()], close, { discard: true })
        );

        const reserveSandbox = (sandbox: SandboxChoice) =>
          Effect.suspend(() => {
            if (sandbox === "none") {
              return Effect.succeed(false);
            }
            const used = [...live.values()].filter(
              (entry) => entry.sandbox !== "none"
            ).length;
            if (used + creating >= options.maxSandboxes) {
              return Effect.fail(
                new SandboxLimitReached({ limit: options.maxSandboxes })
              );
            }
            creating += 1;
            return Effect.succeed(true);
          });

        const create = Effect.fn("Conversations.create")(function* (input: {
          readonly sandbox: SandboxChoice;
          readonly prompt: string;
        }) {
          const reserved = yield* reserveSandbox(input.sandbox);
          const scope = yield* Scope.make();
          const conversation = yield* agents
            .start({ sandbox: input.sandbox })
            .pipe(
              Scope.provide(scope),
              Effect.onError(() => Scope.close(scope, Exit.void)),
              Effect.ensuring(
                Effect.sync(() => {
                  if (reserved) {
                    creating -= 1;
                  }
                })
              )
            );
          const id = Number(conversation.id);
          const now = yield* Clock.currentTimeMillis;
          const entry: Live = {
            conversation,
            scope,
            sandbox: input.sandbox,
            title: titleOf(input.prompt),
            createdAt: now,
            status: "idle",
            lastActivity: now,
          };
          live.set(id, entry);
          const events = yield* agents.events(conversation.id);
          yield* events.pipe(
            Stream.runForEach((event) =>
              Effect.map(Clock.currentTimeMillis, (time) => {
                entry.status = statusAfter(entry.status, event);
                entry.lastActivity = time;
              })
            ),
            Effect.ignore,
            Effect.forkIn(scope)
          );
          yield* conversation.send(input.prompt);
          return summaryOf(id, entry);
        });

        const find = (id: number) =>
          Effect.suspend(() => {
            const entry = live.get(id);
            return entry === undefined
              ? Effect.fail(new ConversationNotFound({ id }))
              : Effect.succeed(entry);
          });

        const sweep = Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const idle = [...live.entries()].flatMap(([id, entry]) =>
            entry.status === "idle" &&
            now - entry.lastActivity >= options.idleTimeoutMs
              ? [id]
              : []
          );
          yield* Effect.forEach(idle, close, { discard: true });
        });
        yield* sweep.pipe(
          Effect.repeat(Schedule.spaced(options.sweepEveryMs)),
          Effect.forkScoped
        );

        return Conversations.of({
          create,
          list: Effect.sync(() =>
            [...live.entries()].map(([id, entry]) => summaryOf(id, entry))
          ),
          send: (id, prompt) =>
            find(id).pipe(
              Effect.flatMap((entry) => entry.conversation.send(prompt))
            ),
          events: (id) => agents.events(id as ConversationId),
          end: (id) => find(id).pipe(Effect.flatMap(() => close(id))),
        });
      })
    );
}
```

Notes for the implementer:

- `Schedule.spaced` takes a `Duration.Input`. If a bare number doesn't typecheck, use `Duration.millis(options.sweepEveryMs)`.
- `Scope.provide(scope)` provides the conversation's own scope to `start`. If the name differs, check `repos/effect/packages/effect/src/Scope.ts:317`.
- `Effect.forkScoped` inside `Layer.effect` ties the sweeper to the layer's lifetime. Confirm against `repos/effect/LLMS.md`, and use `Layer.effectDiscard` + `Layer.merge` if layers aren't scoped.
- The tracking fiber's first event (`snapshot`) is processed asynchronously after `create` returns. The `send` that follows produces `run_start`, so status becomes `running` shortly after create.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run src/server/conversations.test.ts` Expected: PASS (6 tests).

- [ ] **Step 6: Run `pnpm check` and commit**

```bash
pnpm check
git add src/errors.ts src/server/conversations.ts src/server/conversations.test.ts
git commit -m "Add a Conversations registry with a sandbox cap and idle sweep

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: The HTTP API, server entry and echo model

**Files:**

- Modify: `package.json` (add `@effect/platform-node`, scripts, exports)
- Create: `src/server/api.ts`, `src/server/handlers.ts`, `src/server/faux.ts`, `server.ts`
- Test: `src/server/server.test.ts`

**Interfaces:**

- Consumes: `Conversations` (Task 2), `ConversationNotFound`, `SandboxLimitReached` (`src/errors.ts`), `modelFromEnv` (`src/models.ts`), `langfuseLayer` (`src/langfuse.ts`), `DockerSandboxes.layer()`, `loadSkills`, `saveScreenshotsTo` (as in `index.ts`).
- Produces:
  - `src/server/api.ts` exports:
    - `Api`: an `HttpApi` with prefix `/api`.
      - Group `conversations`: `list`, `create`, `send`, `events`, `end`.
      - Group `info`: `get`.
    - `SandboxChoice`, `ConversationSummary` (schema + type).
    - Type re-exports: `AgentEvent`, `EntryRecord`, `MessageChange`, `UsageState`, `ToolSlot` (pi-durable), `AssistantMessage`, `Message`, `Usage` (pi-ai).
  - Package export `effect-pi/api` → `./src/server/api.ts`.
  - `src/server/handlers.ts` exports `apiLayer(info: { readonly model: string })`, which requires `Conversations`.
  - `src/server/faux.ts` exports `echoModel(): { models: MutableModels; model: AgentModel }`.
  - Scripts: `pnpm server` (`:4000`), `pnpm dev:server` (watch mode).

- [ ] **Step 1: Add the dependency**

Run: `pnpm add --save-exact @effect/platform-node@4.0.2` Expected: `package.json` lists `"@effect/platform-node": "4.0.2"`.

- [ ] **Step 2: Write the failing tests**

`src/server/server.test.ts`:

```ts
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxText,
} from "@earendil-works/pi-ai/providers/faux";
import { NodeHttpServer } from "@effect/platform-node";
import { Effect, Exit, Layer, Stream } from "effect";
import { HttpRouter } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import { describe, expect, it } from "vitest";

import { Agents } from "../agents.ts";
import { fauxAgents } from "../testing/faux.ts";
import { localSandboxes } from "../testing/sandboxes.ts";
import { Api } from "./api.ts";
import { Conversations } from "./conversations.ts";
import { echoModel } from "./faux.ts";
import { apiLayer } from "./handlers.ts";

const serverWith = (agents: Layer.Layer<Agents>, maxSandboxes = 3) =>
  HttpRouter.serve(apiLayer({ model: "faux/faux-1" }), {
    disableListenLog: true,
    disableLogger: true,
  }).pipe(
    Layer.provide(
      Conversations.layer({
        maxSandboxes,
        idleTimeoutMs: 60_000,
        sweepEveryMs: 60_000,
      })
    ),
    Layer.provide(agents),
    Layer.provideMerge(NodeHttpServer.layerTest)
  );

const server = (responses: FauxResponseStep[], maxSandboxes = 3) =>
  serverWith(fauxAgents(responses).layer, maxSandboxes);

describe("HTTP API", () => {
  it("creates a conversation and streams its events over SSE", async () => {
    const events = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* HttpApiClient.make(Api);
        const created = yield* client.conversations.create({
          payload: { sandbox: "none", prompt: "Capital of France?" },
        });
        const stream = yield* client.conversations.events({
          params: { id: created.id },
        });
        return Array.from(
          yield* stream.pipe(
            Stream.takeUntil(
              (event) =>
                typeof event === "object" &&
                event !== null &&
                "type" in event &&
                event.type === "run_end"
            ),
            Stream.runCollect
          )
        );
      }).pipe(
        Effect.provide(server([fauxAssistantMessage([fauxText("Paris.")])]))
      )
    );

    expect(events[0]).toMatchObject({ type: "snapshot" });
    expect(JSON.stringify(events)).toContain("Paris.");
  });

  it("lists, sends to and ends conversations", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* HttpApiClient.make(Api);
        const created = yield* client.conversations.create({
          payload: { sandbox: "shell", prompt: "hello" },
        });
        const listed = yield* client.conversations.list();
        expect(listed.map((c) => c.id)).toEqual([created.id]);
        expect(listed[0]?.title).toBe("hello");
        yield* client.conversations.send({
          params: { id: created.id },
          payload: { prompt: "again" },
        });
        yield* client.conversations.end({ params: { id: created.id } });
        expect(yield* client.conversations.list()).toEqual([]);
        const info = yield* client.info.get();
        expect(info.model).toBe("faux/faux-1");
      }).pipe(
        Effect.provide(
          server([
            fauxAssistantMessage([fauxText("one")]),
            fauxAssistantMessage([fauxText("two")]),
          ])
        )
      )
    );
  });

  it("answers 404 for unknown conversations and 409 past the sandbox cap", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* HttpApiClient.make(Api);
        const missing = yield* Effect.exit(
          client.conversations.end({ params: { id: 424_242 } })
        );
        expect(Exit.isFailure(missing)).toBe(true);
        expect(JSON.stringify(missing)).toContain("ConversationNotFound");
        const missingEvents = yield* Effect.exit(
          client.conversations.events({ params: { id: 424_242 } })
        );
        expect(JSON.stringify(missingEvents)).toContain("ConversationNotFound");

        yield* client.conversations.create({
          payload: { sandbox: "shell", prompt: "1" },
        });
        const second = yield* Effect.exit(
          client.conversations.create({
            payload: { sandbox: "shell", prompt: "2" },
          })
        );
        expect(JSON.stringify(second)).toContain("SandboxLimitReached");
      }).pipe(
        Effect.provide(server([fauxAssistantMessage([fauxText("a")])], 1))
      )
    );
  });

  it("the echo model answers every prompt", async () => {
    const { models, model } = echoModel();
    const sandboxes = localSandboxes();
    const agents = Agents.layer({ models, model }).pipe(
      Layer.provide(sandboxes.layer)
    );

    const text = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* HttpApiClient.make(Api);
        const created = yield* client.conversations.create({
          payload: { sandbox: "none", prompt: "ping" },
        });
        yield* client.conversations.send({
          params: { id: created.id },
          payload: { prompt: "pong" },
        });
        const stream = yield* client.conversations.events({
          params: { id: created.id },
        });
        const seen: unknown[] = [];
        yield* stream.pipe(
          Stream.takeUntil((event) => {
            seen.push(event);
            return JSON.stringify(seen).includes("echo: pong");
          }),
          Stream.runDrain
        );
        return JSON.stringify(seen);
      }).pipe(Effect.provide(serverWith(agents)))
    );

    expect(text).toContain("echo: ping");
    expect(text).toContain("echo: pong");
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm vitest run src/server/server.test.ts` Expected: FAIL. `./api.ts`, `./handlers.ts` and `./faux.ts` cannot be resolved.

- [ ] **Step 4: Write `src/server/api.ts`**

```ts
// The HTTP API, shared by the server and web/. Only type imports from pi packages: web/ bundles this file.
import { Schema } from "effect";
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
} from "effect/http-api";

import { ConversationNotFound, SandboxLimitReached } from "../errors.ts";

export type { AssistantMessage, Message, Usage } from "@earendil-works/pi-ai";
export type {
  AgentEvent,
  EntryRecord,
  MessageChange,
  ToolSlot,
  UsageState,
} from "@earendil-works/pi-durable";
export { ConversationNotFound, SandboxLimitReached };

export const SandboxChoice = Schema.Literals(["none", "shell", "desktop"]);
export type SandboxChoice = typeof SandboxChoice.Type;

export const ConversationSummary = Schema.Struct({
  id: Schema.Number,
  sandbox: SandboxChoice,
  sandboxId: Schema.optionalKey(Schema.String),
  vncUrl: Schema.optionalKey(Schema.String),
  title: Schema.String,
  status: Schema.Literals(["running", "idle"]),
  createdAt: Schema.Number,
});
export type ConversationSummary = typeof ConversationSummary.Type;

const NotFound = ConversationNotFound.pipe(HttpApiSchema.status(404));
const ById = { id: Schema.Int };

export const Api = HttpApi.make("effect-pi")
  .add(
    HttpApiGroup.make("conversations").add(
      HttpApiEndpoint.get("list", "/conversations", {
        success: Schema.Array(ConversationSummary),
      }),
      HttpApiEndpoint.post("create", "/conversations", {
        payload: Schema.Struct({
          sandbox: SandboxChoice,
          prompt: Schema.NonEmptyString,
        }),
        success: ConversationSummary.pipe(HttpApiSchema.status(201)),
        error: SandboxLimitReached.pipe(HttpApiSchema.status(409)),
      }),
      HttpApiEndpoint.post("send", "/conversations/:id/messages", {
        params: ById,
        payload: Schema.Struct({ prompt: Schema.NonEmptyString }),
        error: NotFound,
      }),
      // One pi-durable AgentEvent per SSE message: a snapshot first, then each commit's events.
      HttpApiEndpoint.get("events", "/conversations/:id/events", {
        params: ById,
        success: HttpApiSchema.StreamSse({ data: Schema.Json }),
        error: NotFound,
      }),
      HttpApiEndpoint.delete("end", "/conversations/:id", {
        params: ById,
        error: NotFound,
      })
    )
  )
  .add(
    HttpApiGroup.make("info").add(
      HttpApiEndpoint.get("get", "/info", {
        success: Schema.Struct({ model: Schema.String }),
      })
    )
  )
  .prefix("/api");
```

- [ ] **Step 5: Write `src/server/handlers.ts`**

```ts
// Handlers for the API in api.ts. Agent and sandbox failures are defects: they surface as 500s.
import type { AgentEvent } from "@earendil-works/pi-durable";
import { Effect, Layer, Schema, Stream } from "effect";
import { HttpApiBuilder } from "effect/http-api";

import { Api } from "./api.ts";
import { Conversations } from "./conversations.ts";

// AgentEvents are plain JSON (they are what pi-durable commits); the cast only names that for the SSE schema.
const asJson = (event: AgentEvent) => event as unknown as Schema.Json;

const ConversationsHandlers = HttpApiBuilder.group(
  Api,
  "conversations",
  Effect.fnUntraced(function* (handlers) {
    const conversations = yield* Conversations;
    return handlers
      .handle("list", () => conversations.list)
      .handle("create", ({ payload }) =>
        conversations
          .create(payload)
          .pipe(
            Effect.catchTags({
              AgentError: Effect.die,
              SandboxError: Effect.die,
            })
          )
      )
      .handle("send", ({ params, payload }) =>
        conversations
          .send(params.id, payload.prompt)
          .pipe(Effect.catchTag("AgentError", Effect.die))
      )
      .handle("events", ({ params }) =>
        conversations.events(params.id).pipe(
          Effect.map((events) => events.pipe(Stream.map(asJson), Stream.orDie)),
          Effect.catchTag("AgentError", Effect.die)
        )
      )
      .handle("end", ({ params }) => conversations.end(params.id));
  })
);

const infoHandlers = (info: { readonly model: string }) =>
  HttpApiBuilder.group(Api, "info", (handlers) =>
    handlers.handle("get", () => Effect.succeed(info))
  );

export const apiLayer = (info: { readonly model: string }) =>
  HttpApiBuilder.layer(Api).pipe(
    Layer.provide(Layer.mergeAll(ConversationsHandlers, infoHandlers(info)))
  );
```

If `Stream.orDie` or `Effect.catchTags` differ in name, look them up in `repos/effect/packages/effect/src/Stream.ts` and `Effect.ts`.

- [ ] **Step 6: Write `src/server/faux.ts`**

```ts
// A faux model for running the server without one configured: it answers every prompt with `echo: <prompt>`.
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
} from "@earendil-works/pi-ai/providers/faux";

export const echoModel = () => {
  const models = createModels();
  const faux = fauxProvider();
  models.setProvider(faux.provider);
  // Faux responses are a queue; each answer queues the next one.
  const echo: FauxResponseStep = (request) => {
    faux.appendResponses([echo]);
    const last = request.messages.findLast((m) => m.role === "user");
    const text =
      typeof last?.content === "string"
        ? last.content
        : (last?.content ?? [])
            .flatMap((c) => (c.type === "text" ? [c.text] : []))
            .join("");
    return fauxAssistantMessage([fauxText(`echo: ${text}`)]);
  };
  faux.setResponses([echo]);
  return { models, model: { provider: "faux", modelId: "faux-1" } };
};
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm vitest run src/server/server.test.ts` Expected: PASS (4 tests).

- [ ] **Step 8: Write the entry `server.ts`**

```ts
// The agent console's server: the HTTP API in src/server/ on http://localhost:4000.
// The model comes from the environment (see src/models.ts); without one, an echo model answers.
// Run: pnpm server
import { createServer } from "node:http";

import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { HttpRouter } from "effect/http";

import { Agents } from "./src/agents.ts";
import { langfuseLayer } from "./src/langfuse.ts";
import { modelFromEnv } from "./src/models.ts";
import * as DockerSandboxes from "./src/sandbox/docker.ts";
import { saveScreenshotsTo } from "./src/screenshots.ts";
import { Conversations } from "./src/server/conversations.ts";
import { echoModel } from "./src/server/faux.ts";
import { apiLayer } from "./src/server/handlers.ts";
import { loadSkills } from "./src/skills.ts";

const PORT = 4000;

const { skills, problems } = loadSkills("skills");
for (const problem of problems) {
  console.warn(`skipped skill ${problem}`);
}

const configured = await Effect.runPromise(modelFromEnv(process.env));
const setup = configured ?? echoModel();
if (configured === undefined) {
  console.warn("No model configured, the echo model answers");
}
const modelName = `${setup.model.provider}/${setup.model.modelId}`;

const AgentsLive = Agents.layer({
  ...setup,
  saveScreenshot: saveScreenshotsTo("screenshots"),
  skills,
}).pipe(Layer.provide(DockerSandboxes.layer()));

const ConversationsLive = Conversations.layer({
  maxSandboxes: 3,
  idleTimeoutMs: 30 * 60 * 1000,
  sweepEveryMs: 60 * 1000,
}).pipe(Layer.provide(AgentsLive));

const ServerLive = HttpRouter.serve(apiLayer({ model: modelName })).pipe(
  Layer.provide(ConversationsLive),
  Layer.provide(
    NodeHttpServer.layer(createServer, { port: PORT, host: "127.0.0.1" })
  ),
  Layer.provide(langfuseLayer(process.env))
);

// runMain runs every finalizer on SIGINT/SIGTERM, so stopping the server removes all sandboxes.
Layer.launch(ServerLive).pipe(NodeRuntime.runMain);
```

If `modelFromEnv` needs the Langfuse tracer the way `index.ts` builds it, mirror `index.ts`'s `Layer.unwrap` instead of the top-level `await`.

- [ ] **Step 9: Package scripts and export**

In `package.json`:

- Add `"exports": { "./api": "./src/server/api.ts" }`.
- Add these scripts:
  - `"server": "node --env-file-if-exists=.env server.ts"`
  - `"dev:server": "node --watch --env-file-if-exists=.env server.ts"`

- [ ] **Step 10: Smoke-test the real server**

Run: `pnpm server` in the background. Then run:

```bash
curl -s -X POST localhost:4000/api/conversations -H 'content-type: application/json' -d '{"sandbox":"none","prompt":"ping"}'
curl -sN localhost:4000/api/conversations/<id>/events
```

Expected:

- `POST` returns a 201 JSON summary.
- `curl -N` prints `data: {"type":"snapshot",...}` immediately, then stays open.
- Stopping the server with Ctrl-C exits cleanly.
- Without a model configured, the snapshot entries contain `echo: ping`.

- [ ] **Step 11: Run `pnpm check` and commit**

```bash
pnpm check
git add package.json pnpm-lock.yaml server.ts src/server/api.ts src/server/handlers.ts src/server/faux.ts src/server/server.test.ts
git commit -m "Serve conversations over an Effect HttpApi with SSE events

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Workspace and Next.js scaffold

**Files:**

- Modify: `pnpm-workspace.yaml`, root `package.json`, `tsconfig.json`, `oxlint.config.ts`, `oxfmt.config.ts`, `lefthook.yml`, `.gitignore`
- Create: `web/` (Next app), `web/next.config.ts`, `web/vitest.config.ts`, `web/lib/api.ts`, `web/app/providers.tsx`

**Interfaces:**

- Consumes: `effect-pi/api` (`Api`, types) from Task 3.
- Produces:
  - `web/lib/api.ts` exports `runApi<A>(f: (client: ApiClient) => Effect.Effect<A, unknown>): Promise<A>`, `ApiClient` (type), and `apiError(error: unknown): string`.
  - Root `pnpm dev` runs server + web.
  - `pnpm check` also checks web.

- [ ] **Step 1: Create the Next app**

```bash
pnpm dlx create-next-app@16.4.0 web --ts --tailwind --app --no-src-dir --import-alias "@/*" --use-pnpm --skip-install
```

- If prompted for a linter, choose none (the root oxlint covers `web/`).
- Delete `web/pnpm-workspace.yaml` and `web/pnpm-lock.yaml` if the generator created them.
- Set `web/package.json` `"name": "web"`, and pin every dependency it wrote to an exact version (remove `^`).

- [ ] **Step 2: Wire the workspace**

`pnpm-workspace.yaml`: add at the top

```yaml
packages:
  - "."
  - web
```

`web/package.json`:

- Scripts: `"dev": "next dev --port 3001"`, `"build": "next build"`, `"typecheck": "tsc --noEmit"`, `"test": "vitest run"`, `"check": "pnpm typecheck && pnpm test"`.
- Dependencies: add `"effect-pi": "workspace:*"`.

Then from `web/`:

```bash
pnpm add --save-exact effect@4.0.2 @tanstack/react-query@5.104.1 zustand@5.0.15 next-themes @xterm/xterm@6.0.0
pnpm add --save-exact -D vitest@<root's vitest version>
```

Root `package.json` scripts:

- `"dev:web": "pnpm --filter web dev"`
- `"dev": "pnpm run --parallel \"/^dev:(server|web)$/\""`
- `"check": "pnpm typecheck && pnpm lint && pnpm format:check && pnpm test && pnpm --filter web check"`

Root `tsconfig.json`: `"exclude": ["node_modules", "repos", "web"]`.

`.gitignore`: add `web/.next/`, `web/next-env.d.ts`.

`web/tsconfig.json`: add `"allowImportingTsExtensions": true` (the shared `api.ts` imports `../errors.ts`). Keep `"noEmit": true`.

- [ ] **Step 3: Next config**

`web/next.config.ts`:

```ts
import type { NextConfig } from "next";

const API_URL = process.env.API_URL ?? "http://localhost:4000";

const nextConfig: NextConfig = {
  // effect-pi/api is TypeScript source in the workspace
  transpilePackages: ["effect-pi"],
  // Compression buffers responses, which would hold SSE events back
  compress: false,
  rewrites: async () => [
    { source: "/api/:path*", destination: `${API_URL}/api/:path*` },
  ],
};

export default nextConfig;
```

- [ ] **Step 4: Lint, format and hooks**

`oxlint.config.ts`:

- Import `next`, `react` and `shadcn` from `ultracite/oxlint/next`, `ultracite/oxlint/react` and `ultracite/oxlint/shadcn`. Add them to `extends` after `core`.
- Add `"web/.next/**"` and `"web/next-env.d.ts"` to `ignorePatterns`.

`oxfmt.config.ts`: add `"web/.next/**"` to `ignorePatterns`.

`lefthook.yml`:

- Add `tsx,jsx` to the format and lint globs.
- Add a `web` job to the parallel `checks` group: `run: pnpm --filter web check`.

- [ ] **Step 5: shadcn**

From `web/`:

```bash
pnpm dlx shadcn@latest init --base-color neutral
pnpm dlx shadcn@latest add button badge card collapsible scroll-area select separator sonner textarea toggle tooltip resizable
```

- [ ] **Step 6: The API client**

`web/lib/api.ts`:

```ts
import { Cause, Effect, Exit } from "effect";
// The typed client for the effect-pi server, derived from its HttpApi definition. Requests go to /api on this
// origin; next.config.ts rewrites them to the server.
import { Api } from "effect-pi/api";
import { FetchHttpClient } from "effect/http";
import { HttpApiClient } from "effect/http-api";

const makeClient = Effect.suspend(() =>
  HttpApiClient.make(Api, { baseUrl: window.location.origin })
);

export type ApiClient = Effect.Success<typeof makeClient>;

/** A message for a failure from the API, for toasts and inline errors. */
export const apiError = (error: unknown): string => {
  if (typeof error === "object" && error !== null && "_tag" in error) {
    switch (error._tag) {
      case "SandboxLimitReached": {
        const limit = "limit" in error ? String(error.limit) : "a few";
        return `At most ${limit} sandboxes can run at once. End one first.`;
      }
      case "ConversationNotFound": {
        return "This conversation has ended.";
      }
      default: {
        return String(error._tag);
      }
    }
  }
  return error instanceof Error ? error.message : String(error);
};

export const runApi = async <A>(
  f: (client: ApiClient) => Effect.Effect<A, unknown>
): Promise<A> => {
  const exit = await Effect.runPromiseExit(
    Effect.flatMap(makeClient, f).pipe(Effect.provide(FetchHttpClient.layer))
  );
  if (Exit.isSuccess(exit)) {
    return exit.value;
  }
  throw new Error(apiError(Cause.squash(exit.cause)));
};
```

If `Effect.Success` is named differently in Effect 4, use `Effect.Effect.Success<typeof makeClient>`, or whatever helper `repos/effect/packages/effect/src/Effect.ts` exports.

- [ ] **Step 7: Providers and a smoke page**

`web/app/providers.tsx`:

```tsx
"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { useState } from "react";
import type { ReactNode } from "react";

import { Toaster } from "@/components/ui/sonner";

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
      <QueryClientProvider client={queryClient}>
        {children}
        <Toaster />
      </QueryClientProvider>
    </ThemeProvider>
  );
}
```

In `web/app/layout.tsx`:

- Wrap `{children}` in `<Providers>`.
- Add `suppressHydrationWarning` to `<html>`.
- Set the metadata title to `effect-pi`.

Replace `web/app/page.tsx` with a client component. It calls `runApi((c) => c.info.get())` in `useQuery` and renders `model: {data.model}`. Task 6 replaces it.

- [ ] **Step 8: Verify**

Run: `pnpm install && pnpm check` Expected: PASS. Web typecheck passes, and web `vitest run` passes with no tests: add `passWithNoTests: true` in `web/vitest.config.ts` (`defineConfig({ test: { include: ["lib/**/*.test.ts"], passWithNoTests: true } })`).

Run: `pnpm dev`. Open `http://localhost:3001`. Expected: the page shows `model: faux/faux-1` (or the configured model).

Run:

```bash
curl -s -X POST localhost:3001/api/conversations -H 'content-type: application/json' -d '{"sandbox":"none","prompt":"ping"}'
curl -sN localhost:3001/api/conversations/<id>/events
```

Expected: the snapshot arrives immediately through the proxy (Review Focus 1). Then run `curl -X POST .../messages -d '{"prompt":"again"}'` in another terminal, and the new events must appear in the open `curl -N` without delay.

- [ ] **Step 9: Commit**

```bash
git add pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.json oxlint.config.ts oxfmt.config.ts lefthook.yml .gitignore web
git commit -m "Scaffold the web console with Next.js, shadcn and a typed API client

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Event state, store and SSE hook

**Files:**

- Create: `web/lib/conversation-state.ts`, `web/lib/conversation-state.test.ts`, `web/lib/store.ts`, `web/lib/use-conversation-events.ts`, `web/lib/queries.ts`

**Interfaces:**

- Consumes: `runApi`, `ApiClient` (Task 4); types from `effect-pi/api`.
- Produces:

```ts
// conversation-state.ts
export type ToolRun = {
  readonly callId: string;
  readonly name: string;
  readonly output: string;
  readonly details: unknown;
  readonly status: "pending" | "running" | "done";
};
export type ConversationState = {
  readonly entries: readonly EntryRecord[];
  readonly streaming: AssistantMessage | undefined;
  readonly tools: Readonly<Record<string, ToolRun>>;
  readonly running: boolean;
  readonly queued: number;
  readonly usage: UsageState | undefined;
  readonly failures: readonly string[];
};
export const initialState: ConversationState;
export const applyEvent: (state: ConversationState, event: AgentEvent) => ConversationState;
export const toolResultOf: (state: ConversationState, callId: string) => Message | undefined;
export const totalUsage: (usage: UsageState | undefined) => { tokens: number; cost: number };
// store.ts
export const useConversationStore: UseBoundStore<StoreApi<{
  byId: Record<number, ConversationState>;
  apply(id: number, event: AgentEvent): void;
  markEnded(id: number): void;
  ended: Record<number, true>;
}>>;
// use-conversation-events.ts
export const useConversationEvents: (id: number | undefined) => ConversationState;
// queries.ts
export const useConversations: () => UseQueryResult<readonly ConversationSummary[]>;
export const useInfo: () => UseQueryResult<{ model: string }>;
export const useCreateConversation: () => UseMutationResult<ConversationSummary, Error, { sandbox: SandboxChoice; prompt: string }>;
export const useSendMessage: (id: number) => UseMutationResult<void, Error, string>;
export const useEndConversation: () => UseMutationResult<void, Error, number>;
```

- [ ] **Step 1: Write the failing tests**

`web/lib/conversation-state.test.ts`:

```ts
import type { AgentEvent, AssistantMessage, EntryRecord } from "effect-pi/api";
import { describe, expect, it } from "vitest";

import { applyEvent, initialState, toolResultOf } from "./conversation-state";

const assistant = (text: string): AssistantMessage =>
  ({
    role: "assistant",
    content: [{ type: "text", text }],
  }) as AssistantMessage;

const entry = (id: number, message: unknown): EntryRecord =>
  ({
    id,
    conversationId: 1,
    kind: "test",
    model: [message],
  }) as unknown as EntryRecord;

const snapshot = (entries: EntryRecord[], running = false): AgentEvent =>
  ({
    type: "snapshot",
    entries,
    ...(running ? { run: { inputs: [] } } : {}),
    tools: [],
    compactions: [],
    inbox: [],
    agent: {},
    usage: { models: {}, tools: {} },
  }) as unknown as AgentEvent;

const fold = (events: AgentEvent[]) => events.reduce(applyEvent, initialState);

describe("applyEvent", () => {
  it("a snapshot replaces all state, so reconnecting rebuilds it", () => {
    const before = fold([
      snapshot([entry(1, assistant("old"))]),
      { type: "run_start", inputs: [] } as AgentEvent,
    ]);
    const after = applyEvent(before, snapshot([entry(2, assistant("new"))]));
    expect(after.entries.map((e) => e.id)).toEqual([2]);
    expect(after.running).toBe(false);
  });

  it("streams text deltas into the in-flight message, then commits it once", () => {
    const final = entry(5, assistant("Hello"));
    const state = fold([
      snapshot([]),
      { type: "run_start", inputs: [] } as AgentEvent,
      { type: "message_start", message: assistant("") } as AgentEvent,
      {
        type: "message_update",
        usage: {},
        changes: [{ type: "text_delta", contentIndex: 0, delta: "Hel" }],
      } as unknown as AgentEvent,
      {
        type: "message_update",
        usage: {},
        changes: [{ type: "text_delta", contentIndex: 0, delta: "lo" }],
      } as unknown as AgentEvent,
    ]);
    expect(state.streaming?.content[0]).toEqual({
      type: "text",
      text: "Hello",
    });

    // message_end and entry_appended carry the same entry; it is committed once.
    const committed = [
      { type: "message_end", entry: final } as AgentEvent,
      { type: "entry_appended", entry: final } as AgentEvent,
    ].reduce(applyEvent, state);
    expect(committed.streaming).toBeUndefined();
    expect(committed.entries).toHaveLength(1);
  });

  it("tracks a tool's live output, trims and replacements included", () => {
    const state = fold([
      snapshot([]),
      {
        type: "tool_execution_start",
        toolCallId: "c1",
        toolName: "bash",
        args: { command: "ls" },
      } as AgentEvent,
      {
        type: "tool_execution_update",
        toolCallId: "c1",
        toolName: "bash",
        output: { append: "abc" },
      } as AgentEvent,
      {
        type: "tool_execution_update",
        toolCallId: "c1",
        toolName: "bash",
        output: { trimStart: 1, append: "d" },
        details: { conversationId: 7 },
      } as AgentEvent,
    ]);
    expect(state.tools.c1).toMatchObject({
      output: "bcd",
      status: "running",
      details: { conversationId: 7 },
    });
    const replaced = applyEvent(state, {
      type: "tool_execution_update",
      toolCallId: "c1",
      toolName: "bash",
      output: { set: "fresh" },
    } as AgentEvent);
    expect(replaced.tools.c1?.output).toBe("fresh");

    const result = entry(9, {
      role: "toolResult",
      toolCallId: "c1",
      content: [{ type: "text", text: "done" }],
    });
    const ended = applyEvent(replaced, {
      type: "tool_execution_end",
      toolCallId: "c1",
      toolName: "bash",
      entry: result,
    } as AgentEvent);
    expect(ended.tools.c1?.status).toBe("done");
    expect(toolResultOf(ended, "c1")).toMatchObject({ role: "toolResult" });
  });

  it("records task failures and queued prompts", () => {
    const state = fold([
      snapshot([]),
      {
        type: "inbox_update",
        items: [{ id: 1, mode: "followUp" }],
      } as unknown as AgentEvent,
      {
        type: "task_failed",
        taskId: 3,
        kind: "pi.generation",
        message: "boom",
      } as unknown as AgentEvent,
    ]);
    expect(state.queued).toBe(1);
    expect(state.failures).toEqual(["pi.generation: boom"]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter web test` Expected: FAIL. `./conversation-state` cannot be resolved.

- [ ] **Step 3: Implement `web/lib/conversation-state.ts`**

```ts
// The state of one conversation, folded from its pi-durable events. Pure, so it is unit-tested and easy to reshape
// when the UI moves from full detail to only the meaningful parts.
import type {
  AgentEvent,
  AssistantMessage,
  EntryRecord,
  Message,
  MessageChange,
  UsageState,
} from "effect-pi/api";

export type ToolRun = {
  readonly callId: string;
  readonly name: string;
  readonly output: string;
  readonly details: unknown;
  readonly status: "pending" | "running" | "done";
};

export type ConversationState = {
  readonly entries: readonly EntryRecord[];
  readonly streaming: AssistantMessage | undefined;
  readonly tools: Readonly<Record<string, ToolRun>>;
  readonly running: boolean;
  readonly queued: number;
  readonly usage: UsageState | undefined;
  readonly failures: readonly string[];
};

export const initialState: ConversationState = {
  entries: [],
  streaming: undefined,
  tools: {},
  running: false,
  queued: 0,
  usage: undefined,
  failures: [],
};

const withEntry = (
  entries: readonly EntryRecord[],
  entry: EntryRecord
): readonly EntryRecord[] =>
  entries.some((e) => e.id === entry.id) ? entries : [...entries, entry];

const applyChange = (
  message: AssistantMessage,
  change: MessageChange
): AssistantMessage => {
  if (change.type === "message") {
    return change.message;
  }
  const content = [...message.content];
  const block = content[change.contentIndex];
  switch (change.type) {
    case "text_start":
    case "thinking_start":
    case "toolcall_start":
    case "block": {
      content[change.contentIndex] = change.block;
      break;
    }
    case "text_delta": {
      if (block?.type === "text") {
        content[change.contentIndex] = {
          ...block,
          text: block.text + change.delta,
        };
      }
      break;
    }
    case "thinking_delta": {
      if (block?.type === "thinking") {
        content[change.contentIndex] = {
          ...block,
          thinking: block.thinking + change.delta,
        };
      }
      break;
    }
    case "toolcall_delta": {
      // Partial JSON; the complete arguments arrive with the `block` change and tool_execution_start.
      break;
    }
    default: {
      break;
    }
  }
  return { ...message, content };
};

type OutputUpdate = Extract<
  AgentEvent,
  { type: "tool_execution_update" }
>["output"];

const applyOutput = (output: string, update: OutputUpdate): string => {
  if (update === undefined) {
    return output;
  }
  if ("set" in update) {
    return update.set;
  }
  return output.slice(update.trimStart ?? 0) + (update.append ?? "");
};

const withTool = (
  state: ConversationState,
  callId: string,
  name: string,
  change: (tool: ToolRun) => ToolRun
): ConversationState => {
  const tool = state.tools[callId] ?? {
    callId,
    name,
    output: "",
    details: undefined,
    status: "running" as const,
  };
  return { ...state, tools: { ...state.tools, [callId]: change(tool) } };
};

export const applyEvent = (
  state: ConversationState,
  event: AgentEvent
): ConversationState => {
  switch (event.type) {
    case "snapshot": {
      return {
        ...initialState,
        entries: event.entries,
        streaming: event.generation?.message,
        running: event.run !== undefined,
        queued: event.inbox.length,
        usage: event.usage,
        tools: Object.fromEntries(
          event.tools.map((slot) => [
            slot.callId,
            {
              callId: slot.callId,
              name: slot.name,
              output: slot.output ?? "",
              details: slot.details,
              status: slot.status,
            },
          ])
        ),
      };
    }
    case "run_start": {
      return { ...state, running: true };
    }
    case "run_end": {
      return { ...state, running: false };
    }
    case "message_start": {
      return event.message.role === "assistant"
        ? { ...state, streaming: event.message }
        : state;
    }
    case "message_update": {
      return state.streaming === undefined
        ? state
        : {
            ...state,
            streaming: event.changes.reduce(applyChange, state.streaming),
          };
    }
    case "message_end": {
      return {
        ...state,
        streaming: undefined,
        entries: withEntry(state.entries, event.entry),
      };
    }
    case "entry_appended": {
      return { ...state, entries: withEntry(state.entries, event.entry) };
    }
    case "tool_execution_start": {
      return withTool(state, event.toolCallId, event.toolName, (tool) => ({
        ...tool,
        status: "running",
      }));
    }
    case "tool_execution_update": {
      return withTool(state, event.toolCallId, event.toolName, (tool) => ({
        ...tool,
        output: applyOutput(tool.output, event.output),
        details: event.details ?? tool.details,
      }));
    }
    case "tool_execution_end": {
      const ended = withTool(
        state,
        event.toolCallId,
        event.toolName,
        (tool) => ({
          ...tool,
          status: "done",
        })
      );
      return event.entry === undefined
        ? ended
        : { ...ended, entries: withEntry(ended.entries, event.entry) };
    }
    case "inbox_update": {
      return { ...state, queued: event.items.length };
    }
    case "usage_changed": {
      return { ...state, usage: event.usage };
    }
    case "task_failed": {
      return {
        ...state,
        failures: [...state.failures, `${event.kind}: ${event.message}`],
      };
    }
    default: {
      return state;
    }
  }
};

/** The committed tool result message for a call, once there is one. */
export const toolResultOf = (
  state: ConversationState,
  callId: string
): Message | undefined =>
  state.entries
    .flatMap((entry) => entry.model ?? [])
    .find((m) => m.role === "toolResult" && m.toolCallId === callId);

export const totalUsage = (usage: UsageState | undefined) =>
  Object.values(usage?.models ?? {}).reduce(
    (sum, u) => ({
      tokens: sum.tokens + u.totalTokens,
      cost: sum.cost + u.cost.total,
    }),
    { tokens: 0, cost: 0 }
  );
```

If `Usage.cost.total` has a different field name, read `repos/pi/packages/ai/src/types.ts:433`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter web test` Expected: PASS (4 tests).

- [ ] **Step 5: Store, SSE hook and queries**

`web/lib/store.ts`:

```ts
import type { AgentEvent } from "effect-pi/api";
import { create } from "zustand";

import { applyEvent, initialState } from "./conversation-state";
import type { ConversationState } from "./conversation-state";

type Store = {
  readonly byId: Readonly<Record<number, ConversationState>>;
  /** Conversations the server no longer knows (ended, swept, or lost in a restart). */
  readonly ended: Readonly<Record<number, true>>;
  apply(id: number, event: AgentEvent): void;
  markEnded(id: number): void;
};

export const useConversationStore = create<Store>()((set) => ({
  byId: {},
  ended: {},
  apply: (id, event) =>
    set((store) => ({
      byId: {
        ...store.byId,
        [id]: applyEvent(store.byId[id] ?? initialState, event),
      },
    })),
  markEnded: (id) =>
    set((store) => ({ ended: { ...store.ended, [id]: true } })),
}));
```

`web/lib/use-conversation-events.ts`:

```ts
"use client";

import { Effect, Fiber, Schedule, Stream } from "effect";
import type { AgentEvent } from "effect-pi/api";
import { Api } from "effect-pi/api";
import { FetchHttpClient } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import { useEffect } from "react";

import { initialState } from "./conversation-state";
import type { ConversationState } from "./conversation-state";
import { useConversationStore } from "./store";

/**
 * Subscribe to a conversation's events while mounted. Every (re)connection starts with a snapshot, which replaces the
 * state; a 404 marks the conversation ended instead of retrying.
 */
export const useConversationEvents = (
  id: number | undefined
): ConversationState => {
  const state = useConversationStore((store) =>
    id === undefined ? initialState : (store.byId[id] ?? initialState)
  );

  useEffect(() => {
    if (id === undefined) {
      return;
    }
    const { apply, markEnded } = useConversationStore.getState();
    const subscribe = Effect.gen(function* () {
      const client = yield* HttpApiClient.make(Api, {
        baseUrl: window.location.origin,
      });
      const events = yield* client.conversations.events({ params: { id } });
      yield* Stream.runForEach(events, (event) =>
        // The wire schema is JSON; the server sends AgentEvents.
        Effect.sync(() => apply(id, event as unknown as AgentEvent))
      );
    }).pipe(
      Effect.catchTag("ConversationNotFound", () =>
        Effect.sync(() => markEnded(id))
      ),
      // Reconnect after the stream drops (server restart, network); the next snapshot rebuilds the state.
      Effect.repeat(Schedule.spaced("1 second")),
      Effect.retry(Schedule.spaced("1 second")),
      Effect.provide(FetchHttpClient.layer)
    );
    const fiber = Effect.runFork(subscribe);
    return () => {
      Effect.runFork(Fiber.interrupt(fiber));
    };
  }, [id]);

  return state;
};
```

The `repeat` must stop once the conversation is marked ended. Make the repeat conditional with `Effect.repeat({ schedule: Schedule.spaced("1 second"), until: () => useConversationStore.getState().ended[id] === true })`, or the equivalent option name in Effect 4.

`web/lib/queries.ts`:

```ts
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ConversationSummary, SandboxChoice } from "effect-pi/api";

import { runApi } from "./api";

const LIST = ["conversations"] as const;

export const useConversations = () =>
  useQuery({
    queryKey: LIST,
    queryFn: () => runApi((c) => c.conversations.list()),
    // Keeps status dots current; each open conversation's events are live anyway.
    refetchInterval: 2000,
  });

export const useInfo = () =>
  useQuery({
    queryKey: ["info"],
    queryFn: () => runApi((c) => c.info.get()),
    staleTime: Number.POSITIVE_INFINITY,
  });

export const useCreateConversation = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: { sandbox: SandboxChoice; prompt: string }) =>
      runApi((c) => c.conversations.create({ payload })),
    onSuccess: (created: ConversationSummary) => {
      queryClient.setQueryData<readonly ConversationSummary[]>(LIST, (all) => [
        ...(all ?? []),
        created,
      ]);
    },
  });
};

export const useSendMessage = (id: number) =>
  useMutation({
    mutationFn: (prompt: string) =>
      runApi((c) =>
        c.conversations.send({ params: { id }, payload: { prompt } })
      ),
  });

export const useEndConversation = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) =>
      runApi((c) => c.conversations.end({ params: { id } })),
    onSettled: () => queryClient.invalidateQueries({ queryKey: LIST }),
  });
};
```

- [ ] **Step 6: Run `pnpm check` and commit**

```bash
pnpm check
git add web/lib
git commit -m "Fold conversation events into a Zustand store fed by SSE

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Console layout, transcript and input

**Files:**

- Create: `web/components/console/sidebar.tsx`, `new-conversation.tsx`, `conversation-header.tsx`, `transcript.tsx`, `tool-call.tsx`, `message-input.tsx`
- Modify: `web/app/page.tsx`

**Interfaces:**

- Consumes: Task 5 hooks, `toolResultOf`, `totalUsage`, `ConversationState`; shadcn components.
- Produces:
  - `<Transcript state={ConversationState} />`, reused for subagents in Task 7.
  - `<ToolCall call={ToolCall block} state={ConversationState} />`, with a `renderExtra` slot that Task 7 fills for `subagent`.
  - `page.tsx` keeps the selected conversation id in the URL search param `?c=<id>`.

- [ ] **Step 1: Page shell**

`web/app/page.tsx` (client component):

- Use a shadcn `ResizablePanelGroup` horizontally:
  - Sidebar (20%).
  - Main column: header + transcript + input.
  - Right panel (35%), rendered only when the selected conversation's `sandbox !== "none"`. Task 8 fills it; for now render an empty placeholder card.
- Read and write the selected id with `useSearchParams`/`useRouter` (`?c=`).
- With no `?c`, the main column shows `<NewConversation />`.
- The page calls `useConversationEvents(selectedId)`.

- [ ] **Step 2: Sidebar** (`sidebar.tsx`)
- A "New conversation" button clears `?c`.
- Below it, the list from `useConversations()`, newest first. Each row shows:
  - the title (truncated with `truncate`),
  - a sandbox badge (`none`/`shell`/`desktop`),
  - a status dot: green pulsing `running`, gray `idle`, with `aria-label` equal to the status.
- Clicking a row sets `?c=<id>`. The selected row is highlighted.
- Empty state: "No conversations yet."

- [ ] **Step 3: New conversation** (`new-conversation.tsx`)
- A sandbox `Select` (None, Shell, Desktop, each with a one-line hint):
  - None: "Chat and subagents, no tools."
  - Shell: "A Linux container with file and shell tools."
  - Desktop: "A Linux desktop the agent can see and control."
- A `Textarea` for the prompt (Enter submits, Shift+Enter adds a newline), plus a "Start" button.
- On submit, `useCreateConversation().mutate`. On success, set `?c=<created.id>`. On error, `toast.error(error.message)`.
- While pending, disable the button and label it "Starting…". Creating a desktop sandbox takes seconds.

- [ ] **Step 4: Header** (`conversation-header.tsx`)
- Shows: title, sandbox badge + `sandboxId` (monospace, truncated), model from `useInfo()`, and tokens and cost from `totalUsage(state.usage)`. When `state.queued > 0`, show "N queued".
- An "End" button (`variant="destructive"`, confirm with `window.confirm("End this conversation and remove its sandbox?")`) calls `useEndConversation().mutate(id)`, then clears `?c`.

- [ ] **Step 5: Transcript** (`transcript.tsx`)

Render `state.entries` in order, then `state.streaming` (if any) with a blinking caret. For each entry's `model?.[0]`:

- `user`: a right-aligned bubble. The content is a string, or its text blocks joined, with images as `<img>`.
- `assistant`: render blocks in order:
  - `text` → `<p className="whitespace-pre-wrap">`.
  - `thinking` → shadcn `Collapsible` "Thinking" (closed by default, muted, `whitespace-pre-wrap`).
  - `toolCall` → `<ToolCall call={block} state={state} />`.
- `toolResult`: render nothing (shown inside its `ToolCall`).
- No `model` (bookkeeping entry): a muted one-line `<details>` with `entry.kind` as the summary and `JSON.stringify(entry.data, null, 2)` in a `<pre>`.

After the entries:

- Each `state.failures` item as a red alert line.
- When `state.running && state.streaming === undefined`, a "Working…" indicator.
- When the store marks the conversation `ended`, a banner: "This conversation has ended."

Use shadcn `ScrollArea`, and auto-scroll to the bottom on new content unless the user scrolled up more than 80px.

- [ ] **Step 6: Tool call** (`tool-call.tsx`)

A `Card` showing:

- The tool name in monospace.
- A status `Badge`, from `state.tools[call.id]?.status`, or `done` when a result exists.
- The arguments as pretty JSON in a `Collapsible` (open by default).

Then the body:

- While running, the live output from `state.tools[call.id]?.output` in a `<pre>`, max height 20rem, scrollable.
- When done, the `toolResultOf(state, call.id)` content:
  - text → `<pre>`;
  - image → `<img src={`data:${c.mimeType};base64,${c.data}`} alt="Tool screenshot" className="max-w-full rounded border" />`.
- If `isError`, a red border and an "error" badge.

Take an optional `renderExtra?: (call, tool) => ReactNode` prop, rendered under the arguments.

- [ ] **Step 7: Input** (`message-input.tsx`)
- A `Textarea` + "Send" button at the bottom of the main column. Enter sends, Shift+Enter adds a newline. It calls `useSendMessage(id).mutate(prompt)` and clears on success.
- The input stays enabled while the agent runs (prompts queue as follow-ups). The button label is "Queue" when `state.running`, otherwise "Send".
- When the conversation has ended, disable it.

- [ ] **Step 8: Verify**

Run: `pnpm check`. Expected: PASS.

Run `pnpm dev` with no model configured, and open `localhost:3001`:

- Start a `none` conversation with "hi". Expected: user bubble, then `echo: hi`, and the status dot goes running → idle.
- Send two messages quickly. Expected: both echo, and the header shows "1 queued" briefly.
- Refresh the page. Expected: the transcript rebuilds from the snapshot with no duplicates.
- Stop the server and start it again. Expected: the open conversation shows "This conversation has ended."

- [ ] **Step 9: Commit**

```bash
git add web/app web/components/console
git commit -m "Add the console layout, transcript and message input

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Nested subagent streams

**Files:**

- Create: `web/components/console/subagent.tsx`
- Modify: `web/components/console/transcript.tsx` (pass `renderExtra`)

**Interfaces:**

- Consumes: `useConversationEvents`, `Transcript`, `ToolCall.renderExtra`; `details.conversationId` from Task 1.
- Produces: `<SubagentStream id={number} />`.

- [ ] **Step 1: Implement**

`subagent.tsx`: a `Collapsible` titled "Subagent conversation #{id}", open while the parent tool is running. It calls `useConversationEvents(id)` and renders `<Transcript state={...} nested />`. The `nested` prop:

- drops the auto-scroll and the ended banner,
- indents with a left border.

In `Transcript`, pass `renderExtra` to every `ToolCall`. It returns `<SubagentStream id={...} />` when `call.name === "subagent"` and `tool?.details` is an object with a numeric `conversationId`. Write a small type guard `subagentIdOf(details: unknown): number | undefined` in `subagent.tsx`.

- [ ] **Step 2: Verify**

Run: `pnpm check`. Expected: PASS.

With a real model configured (`ANTHROPIC_API_KEY` or Ollama), start a `none` conversation with "Use the subagent tool to say hello to Effect, then tell me what it said." Expected: the `subagent` tool card contains a nested transcript that streams the child's answer before the parent continues.

- [ ] **Step 3: Commit**

```bash
git add web/components/console
git commit -m "Show subagent conversations nested under their tool call

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Desktop and terminal panels

**Files:**

- Create: `web/lib/vnc.ts`, `web/lib/vnc.test.ts`, `web/lib/terminal.ts`, `web/lib/terminal.test.ts`, `web/components/console/desktop-panel.tsx`, `web/components/console/terminal-panel.tsx`
- Modify: `web/app/page.tsx` (right panel)

**Interfaces:**

- Consumes: `ConversationSummary.vncUrl`, `ConversationState`, `toolResultOf`.
- Produces:
  - `vncViewUrl(vncUrl: string, control: boolean): string`
  - `terminalText(state: ConversationState): string`

- [ ] **Step 1: Write the failing tests**

`web/lib/vnc.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { vncViewUrl } from "./vnc";

describe(vncViewUrl, () => {
  const base = "http://127.0.0.1:55001/vnc.html?autoconnect=true&resize=scale";

  it("is view-only unless the user takes control", () => {
    expect(new URL(vncViewUrl(base, false)).searchParams.get("view_only")).toBe(
      "true"
    );
    expect(new URL(vncViewUrl(base, true)).searchParams.get("view_only")).toBe(
      "false"
    );
  });

  it("keeps the sandbox's own parameters", () => {
    const url = new URL(vncViewUrl(base, false));
    expect(url.searchParams.get("autoconnect")).toBe("true");
    expect(url.searchParams.get("resize")).toBe("scale");
  });
});
```

`web/lib/terminal.test.ts`:

```ts
import type { AgentEvent, EntryRecord } from "effect-pi/api";
import { describe, expect, it } from "vitest";

import { applyEvent, initialState } from "./conversation-state";
import { terminalText } from "./terminal";

const entry = (id: number, message: unknown) =>
  ({
    id,
    conversationId: 1,
    kind: "test",
    model: [message],
  }) as unknown as EntryRecord;

describe(terminalText, () => {
  it("shows each bash command with its final or live output, other tools omitted", () => {
    const state = [
      {
        type: "entry_appended",
        entry: entry(1, {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "a",
              name: "bash",
              arguments: { command: "uname" },
            },
            {
              type: "toolCall",
              id: "b",
              name: "read",
              arguments: { path: "x" },
            },
            {
              type: "toolCall",
              id: "c",
              name: "bash",
              arguments: { command: "sleep 9" },
            },
          ],
        }),
      },
      {
        type: "entry_appended",
        entry: entry(2, {
          role: "toolResult",
          toolCallId: "a",
          content: [{ type: "text", text: "Linux\n" }],
        }),
      },
      {
        type: "tool_execution_update",
        toolCallId: "c",
        toolName: "bash",
        output: { append: "partial" },
      },
    ].reduce((s, e) => applyEvent(s, e as AgentEvent), initialState);

    expect(terminalText(state)).toBe(
      "$ uname\r\nLinux\r\n$ sleep 9\r\npartial"
    );
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter web test` Expected: FAIL. `./vnc` and `./terminal` cannot be resolved.

- [ ] **Step 3: Implement the helpers**

`web/lib/vnc.ts`:

```ts
/** The sandbox's noVNC URL, view-only unless the user has taken control. */
export const vncViewUrl = (vncUrl: string, control: boolean): string => {
  const url = new URL(vncUrl);
  url.searchParams.set("view_only", String(!control));
  return url.toString();
};
```

`web/lib/terminal.ts`:

```ts
// The shell panel's text: the agent's bash commands and their output, in order, as xterm expects (CRLF newlines).
import { toolResultOf } from "./conversation-state";
import type { ConversationState } from "./conversation-state";

const crlf = (text: string) => text.replaceAll(/\r?\n/g, "\r\n");

export const terminalText = (state: ConversationState): string => {
  const messages = [
    ...state.entries.flatMap((entry) => entry.model ?? []),
    ...(state.streaming === undefined ? [] : [state.streaming]),
  ];
  const calls = messages.flatMap((m) =>
    m.role === "assistant"
      ? m.content.filter((c) => c.type === "toolCall" && c.name === "bash")
      : []
  );
  return calls
    .map((call) => {
      if (call.type !== "toolCall") {
        return "";
      }
      const command = String(call.arguments.command ?? "");
      const result = toolResultOf(state, call.id);
      const output =
        result?.role === "toolResult"
          ? result.content
              .flatMap((c) => (c.type === "text" ? [c.text] : []))
              .join("")
          : (state.tools[call.id]?.output ?? "");
      return `$ ${command}\r\n${crlf(output)}`;
    })
    .join("")
    .replace(/\r\n$/, "");
};
```

Check this against the expected string in the test. If the join or trailing-newline handling is off, adjust the implementation (not the test) so each command starts on its own line and the text has no trailing CRLF.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter web test` Expected: PASS.

- [ ] **Step 5: Panels**

`desktop-panel.tsx`:

- An `<iframe src={vncViewUrl(vncUrl, control)} title="Sandbox desktop" className="h-full w-full border-0" />`.
- Above it, a toolbar with a shadcn `Toggle` labelled "Take control" (`aria-pressed`) and an "Open in new tab" link.
- Changing the toggle changes `src`, which reconnects noVNC in the new mode. That's expected.
- Without a `vncUrl`, show "No desktop view for this sandbox."

`terminal-panel.tsx` (client only):

- In a `useEffect`, create `new Terminal({ convertEol: false, disableStdin: true, fontSize: 12, theme: { background: "transparent" } })` from `@xterm/xterm`, open it on a div ref, and import `@xterm/xterm/css/xterm.css`.
- On every `terminalText(state)` change, if the new text starts with the previously written text, write only the suffix. Otherwise call `term.reset()` and write the full text (a snapshot after reconnect).
- Dispose the terminal on unmount.
- Load the panel with `next/dynamic` and `ssr: false`, since xterm touches `window`.

In `page.tsx`'s right panel: `desktop` → `<DesktopPanel vncUrl={summary.vncUrl} />`, `shell` → `<TerminalPanel state={state} />`. The panel is collapsible (`ResizablePanel collapsible`).

- [ ] **Step 6: Verify**

Run: `pnpm check`. Expected: PASS.

With `pnpm sandbox:build` done and a real model, run `pnpm dev`:

- Start a `shell` conversation: "Which Linux distribution are you running on?" Expected: the terminal panel shows `$ head -1 /etc/os-release ...` and its output as the bash call runs.
- Start a `desktop` conversation: "Take a screenshot of the desktop and describe it." Expected: the noVNC panel shows the XFCE desktop. Clicks do nothing until "Take control" is on, and the screenshot appears inline in the tool card.
- Stop `pnpm dev` with Ctrl-C, then run `docker ps --filter name=effect-pi-`. Expected: no containers (Review Focus 5).

- [ ] **Step 7: Commit**

```bash
git add web/lib web/components/console web/app/page.tsx
git commit -m "Add the desktop and shell side panels

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Document the console

**Files:**

- Modify: `AGENTS.md`

- [ ] **Step 1: Update `AGENTS.md`**

Under `## Commands`, add:

- `pnpm server` runs the HTTP server (`server.ts`, `:4000`).
- `pnpm dev` runs the server in watch mode plus the web console on `:3001`.
- `pnpm --filter web <script>` runs a web script.
- `pnpm check` also runs `web`'s typecheck and tests.

Add a `## Web console` section:

- `src/server/`:
  - `Conversations` (the registry: one `Scope` per conversation, sandbox cap 3, 30-minute idle sweep);
  - `api.ts` (the `HttpApi` definition, shared with `web/` as `effect-pi/api`, with no runtime pi imports);
  - `handlers.ts`;
  - `faux.ts` (echo model when none is configured).
- Events: `Agents.events(id)` wraps pi-durable's `watchEvents`. SSE sends one `AgentEvent` per message, `snapshot` first. The `subagent` tool reports `details.conversationId`.
- `web/`: Next.js App Router, shadcn, TanStack Query (REST), and a Zustand store fed by the pure `applyEvent` in `web/lib/conversation-state.ts`. `next.config.ts` rewrites `/api/*` to `:4000` with compression off, so SSE isn't buffered.

- [ ] **Step 2: Commit**

```bash
pnpm check
git add AGENTS.md
git commit -m "Document the web console

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
