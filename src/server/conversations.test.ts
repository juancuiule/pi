import type { FauxResponseStep } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxText,
} from "@earendil-works/pi-ai/providers/faux";
import { Effect, Exit, Fiber, Layer, Stream } from "effect";
import { describe, expect, it } from "vitest";

import { Capacity } from "../capacity.ts";
import { callTool, echoToolResult, fauxAgents } from "../testing/faux.ts";
import { Conversations, titleOf } from "./conversations.ts";

const defaults = {
  idleTimeoutMs: 60_000,
  sweepEveryMs: 60_000,
};

const setup = (
  responses: FauxResponseStep[],
  options: Partial<typeof defaults> & { readonly shells?: number } = {}
) => {
  const agents = fauxAgents(responses);
  const { shells = 3, ...rest } = options;
  return {
    ...agents,
    layer: Conversations.layer({ ...defaults, ...rest }).pipe(
      Layer.provide(agents.layer),
      Layer.provide(Capacity.layer({ seats: 10, shells, desktops: 1 }))
    ),
  };
};

/** Poll `check` until it returns true, failing after `timeoutMs` (3 seconds by default). */
const waitUntil = (check: Effect.Effect<boolean, unknown>, timeoutMs = 3000) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < timeoutMs / 10; attempt += 1) {
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
        // Ended conversations stay listed: no longer live, never resumable.
        const listed = yield* conversations.list;
        expect(listed).toHaveLength(1);
        expect(listed[0]?.status).toBe("ended");
        expect(listed[0]?.endedReason).toBe("ended");
        return yield* Effect.exit(conversations.send(created.id, "again"));
      }).pipe(Effect.provide(layer))
    );

    expect(Exit.isFailure(exit)).toBeTruthy();
    expect(JSON.stringify(exit)).toContain("ConversationEnded");
  });

  it("ends a running conversation, stopping its run before the sandbox goes", async () => {
    const { layer, sandboxes, faux } = setup([
      callTool("bash", { command: "sleep 5" }),
      echoToolResult,
    ]);

    const started = Date.now();
    const snapshot = await Effect.runPromise(
      Effect.gen(function* () {
        const conversations = yield* Conversations;
        const created = yield* conversations.create({
          sandbox: "shell",
          prompt: "sleep",
        });
        yield* waitUntil(
          conversations.list.pipe(
            Effect.map((all) => all[0]?.status === "running")
          )
        );
        // The bash call is in progress: only its follow-up turn is still queued.
        yield* waitUntil(
          Effect.sync(() => faux.getPendingResponseCount() === 1)
        );
        yield* conversations.end(created.id);
        expect(sandboxes.live.size).toBe(0);
        // The harness still knows the conversation; its snapshot shows no run.
        const events = yield* conversations.events(created.id);
        return yield* events.pipe(Stream.runHead);
      }).pipe(Effect.provide(layer))
    );

    expect(snapshot._tag === "Some" && snapshot.value.type).toBe("snapshot");
    expect(
      snapshot._tag === "Some" &&
        snapshot.value.type === "snapshot" &&
        snapshot.value.run
    ).toBeUndefined();
    // The follow-up model turn never ran, and End did not wait for the sleep.
    expect(faux.getPendingResponseCount()).toBe(1);
    expect(faux.state.callCount).toBe(1);
    expect(Date.now() - started).toBeLessThan(5000);
  }, 30_000);

  it("refuses sandboxes past the cap, even when created concurrently", async () => {
    const { layer } = setup([answer("a"), answer("b"), answer("c")], {
      shells: 1,
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
    expect(JSON.stringify(failures[0])).toContain("CapacityExhausted");
    expect(exits.at(2)?._tag).toBe("Success");
  });

  it("sweeps idle conversations but never a running one", async () => {
    const { layer, sandboxes } = setup(
      [callTool("bash", { command: "sleep 2" }), echoToolResult],
      { idleTimeoutMs: 50, sweepEveryMs: 10 }
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const conversations = yield* Conversations;
        yield* conversations.create({ sandbox: "shell", prompt: "sleep" });
        // Wait until the run is observably in progress, so the check below
        // does not depend on how fast the bash call started.
        yield* waitUntil(
          conversations.list.pipe(
            Effect.map((all) => all.some((c) => c.status === "running"))
          ),
          10_000
        );
        // Several idle timeouts later the bash call (2s) is still running.
        yield* Effect.sleep("300 millis");
        const during = yield* conversations.list;
        expect(during).toHaveLength(1);
        expect(during[0]?.status).toBe("running");
        // A swept shell conversation stays listed, ended because its sandbox was removed.
        yield* waitUntil(
          conversations.list.pipe(
            Effect.map(
              (all) =>
                all[0]?.status === "ended" &&
                all[0]?.endedReason === "sandbox_removed"
            )
          ),
          15_000
        );
        expect(sandboxes.live.size).toBe(0);
      }).pipe(Effect.provide(layer))
    );
  }, 30_000);

  it("does not sweep a new conversation before its first run has ended", async () => {
    // idleTimeoutMs 0: without the guard, the first sweep would close the
    // conversation while its status is still the initial "idle".
    const { layer } = setup(
      [callTool("bash", { command: "sleep 1" }), echoToolResult],
      { idleTimeoutMs: 0, sweepEveryMs: 1 }
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const conversations = yield* Conversations;
        yield* conversations.create({ sandbox: "shell", prompt: "sleep" });
        yield* Effect.sleep("200 millis");
        expect(yield* conversations.list).toHaveLength(1);
      }).pipe(Effect.provide(layer))
    );
  }, 30_000);

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

  it("leaks neither a sandbox nor a cap slot when a create is interrupted", async () => {
    const { layer, sandboxes } = setup([answer("a")], { shells: 1 });

    await Effect.runPromise(
      Effect.gen(function* () {
        const conversations = yield* Conversations;
        for (const delay of [0, 1, 3, 6]) {
          const fiber = yield* Effect.forkChild(
            conversations.create({ sandbox: "shell", prompt: "x" })
          );
          yield* Effect.sleep(`${delay} millis`);
          yield* Fiber.interrupt(fiber);
          for (const summary of yield* conversations.list) {
            yield* conversations.end(summary.id);
          }
          expect(sandboxes.live.size).toBe(0);
        }
        // The cap slot is free again.
        yield* conversations.create({ sandbox: "shell", prompt: "y" });
      }).pipe(Effect.provide(layer))
    );
  });
});
