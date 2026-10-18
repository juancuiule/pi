import type { FauxResponseStep, Message } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxText,
} from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Deferred, Effect, Exit, Fiber, Layer, Stream } from "effect";
import { describe, expect, it } from "vitest";

import { Agents } from "../agents/agents.ts";
import { InvalidSetting } from "../errors.ts";
import { SandboxError } from "../sandbox/sandbox.ts";
import { Search } from "../search/search.ts";
import { callTool, echoToolResult, fauxAgents } from "../testing/faux.ts";
import { localSandboxes } from "../testing/sandboxes.ts";
import type { LocalSandboxes } from "../testing/sandboxes.ts";
import { Workspaces, WorkspaceStorage } from "../workspaces/workspaces.ts";
import type { SaveReason } from "../workspaces/workspaces.ts";
import { Conversations, titleOf } from "./conversations.ts";

const defaults = {
  idleTimeoutMs: 60_000,
  sweepEveryMs: 60_000,
};

const setup = (
  responses: FauxResponseStep[],
  options: Partial<typeof defaults> & {
    readonly shells?: number;
    readonly sandboxes?: LocalSandboxes;
    readonly titleGeneration?: boolean;
    readonly search?: Layer.Layer<Search, unknown, Agents>;
  } = {}
) => {
  const {
    shells = 3,
    sandboxes,
    search = Search.none,
    titleGeneration,
    ...rest
  } = options;
  const agents = fauxAgents(responses, {
    limits: { shells },
    ...(titleGeneration === undefined ? {} : { titleGeneration }),
    ...(sandboxes === undefined ? {} : { sandboxes }),
  });
  return {
    ...agents,
    layer: Conversations.layer({ ...defaults, ...rest }).pipe(
      // provideMerge: tests reach the same Search and Agents the layer serves.
      Layer.provideMerge(search),
      Layer.provideMerge(agents.layer)
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

  it("indexes a conversation when its Run ends, even one with no Sandbox", async () => {
    const { layer } = setup([answer("quokkas smile")], {
      search: Search.temporary,
    });

    const { created, found } = await Effect.runPromise(
      Effect.gen(function* () {
        const conversations = yield* Conversations;
        const search = yield* Search;
        // Let the startup sweep pass first, so only run-end indexing can find this one.
        yield* search.catchUp;
        const started = yield* conversations.create({
          sandbox: "none",
          prompt: "quokka facts",
        });
        yield* waitUntil(
          conversations.list.pipe(
            Effect.map((all) => all[0]?.status === "idle")
          )
        );
        // Indexing is forked at run end, so poll for it.
        yield* waitUntil(
          search.query("quokka").pipe(Effect.map((hits) => hits.length > 0))
        );
        return { created: started, found: yield* search.query("quokka") };
      }).pipe(Effect.provide(layer))
    );

    expect(found[0]?.id).toBe(created.id);
    expect(found[0]?.title).toBe("quokka facts");
  });

  it("pauses an idle Conversation, freeing its Sandbox, and a send resumes it with its files", async () => {
    const { layer, sandboxes } = setup([
      callTool("bash", { command: "echo kept > note.txt" }),
      echoToolResult,
      callTool("bash", { command: "cat note.txt" }),
      echoToolResult,
    ]);

    const { paused, resumed } = await Effect.runPromise(
      Effect.gen(function* () {
        const conversations = yield* Conversations;
        const created = yield* conversations.create({
          sandbox: "shell",
          prompt: "leave a note",
        });
        const current = conversations.list.pipe(
          Effect.map((all) => all.find((c) => c.id === created.id))
        );
        yield* waitUntil(current.pipe(Effect.map((c) => c?.status === "idle")));
        yield* conversations.pause(created.id);
        expect(sandboxes.live.size).toBe(0);
        const pausedSummary = yield* current;
        yield* conversations.send(created.id, "read it");
        yield* waitUntil(
          conversations.events(created.id).pipe(
            Effect.flatMap((events) => events.pipe(Stream.runHead)),
            Effect.map(
              (head) =>
                head._tag === "Some" &&
                head.value.type === "snapshot" &&
                JSON.stringify(head.value.entries).includes("kept") &&
                head.value.run === undefined &&
                head.value.entries.length >= 8
            )
          )
        );
        return { paused: pausedSummary, resumed: yield* current };
      }).pipe(Effect.provide(layer))
    );

    expect(paused?.status).toBe("paused");
    expect(paused?.sandboxId).toBeUndefined();
    expect(resumed?.status).not.toBe("paused");
    expect(resumed?.sandboxId).toBeDefined();
  }, 30_000);

  it("pauses a running Conversation once its Run ends", async () => {
    const { layer, sandboxes, faux } = setup([
      callTool("bash", { command: "sleep 1" }),
      echoToolResult,
    ]);

    const during = await Effect.runPromise(
      Effect.gen(function* () {
        const conversations = yield* Conversations;
        const created = yield* conversations.create({
          sandbox: "shell",
          prompt: "sleep",
        });
        const current = conversations.list.pipe(
          Effect.map((all) => all.find((c) => c.id === created.id))
        );
        yield* waitUntil(
          current.pipe(Effect.map((c) => c?.status === "running"))
        );
        yield* conversations.pause(created.id);
        const summary = yield* current;
        yield* waitUntil(
          current.pipe(Effect.map((c) => c?.status === "paused")),
          10_000
        );
        return summary;
      }).pipe(Effect.provide(layer))
    );

    expect(during?.status).toBe("running");
    expect(during?.pausing).toBeTruthy();
    // The Run finished: its follow-up model turn ran before the Seat closed.
    expect(faux.state.callCount).toBe(2);
    expect(sandboxes.live.size).toBe(0);
  }, 30_000);

  it("cancels a pending Pause when a prompt is sent", async () => {
    const { layer } = setup([
      callTool("bash", { command: "sleep 1" }),
      echoToolResult,
      answer("still here"),
    ]);

    const after = await Effect.runPromise(
      Effect.gen(function* () {
        const conversations = yield* Conversations;
        const created = yield* conversations.create({
          sandbox: "shell",
          prompt: "sleep",
        });
        const current = conversations.list.pipe(
          Effect.map((all) => all.find((c) => c.id === created.id))
        );
        yield* waitUntil(
          current.pipe(Effect.map((c) => c?.status === "running"))
        );
        yield* conversations.pause(created.id);
        yield* conversations.send(created.id, "one more thing");
        yield* waitUntil(
          current.pipe(Effect.map((c) => c?.status === "idle")),
          10_000
        );
        yield* Effect.sleep("100 millis");
        return yield* current;
      }).pipe(Effect.provide(layer))
    );

    expect(after?.status).toBe("idle");
    expect(after?.pausing).toBeFalsy();
  }, 30_000);

  it("stops a Run without waiting for its tool, and keeps the Seat", async () => {
    const { layer, sandboxes, faux } = setup([
      callTool("bash", { command: "sleep 5" }),
      echoToolResult,
    ]);

    const started = Date.now();
    const after = await Effect.runPromise(
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
        yield* conversations.stop(created.id);
        return (yield* conversations.list)[0];
      }).pipe(Effect.provide(layer))
    );

    expect(after?.status).toBe("idle");
    // The follow-up model turn never ran, and Stop did not wait for the sleep.
    expect(faux.getPendingResponseCount()).toBe(1);
    expect(faux.state.callCount).toBe(1);
    expect(Date.now() - started).toBeLessThan(5000);
    // The Seat kept its Sandbox until the layer was torn down.
    expect(sandboxes.live.size).toBe(0);
  }, 30_000);

  it("archives a Conversation, deleting its files, and unarchives it with an empty Workspace", async () => {
    const { layer, sandboxes } = setup([answer("ok"), answer("back")]);

    const { archived, refused, unarchived } = await Effect.runPromise(
      Effect.gen(function* () {
        const conversations = yield* Conversations;
        const created = yield* conversations.create({
          sandbox: "shell",
          prompt: "hello",
        });
        const current = conversations.list.pipe(
          Effect.map((all) => all.find((c) => c.id === created.id))
        );
        expect(sandboxes.stored.size).toBe(1);
        yield* conversations.archive(created.id);
        expect(sandboxes.live.size).toBe(0);
        expect(sandboxes.stored.size).toBe(0);
        const archivedSummary = yield* current;
        const sendExit = yield* Effect.exit(
          conversations.send(created.id, "again")
        );
        yield* conversations.unarchive(created.id);
        const unarchivedSummary = yield* current;
        yield* conversations.send(created.id, "again");
        return {
          archived: archivedSummary,
          refused: sendExit,
          unarchived: unarchivedSummary,
        };
      }).pipe(Effect.provide(layer))
    );

    expect(archived?.status).toBe("archived");
    expect(Exit.isFailure(refused)).toBeTruthy();
    expect(JSON.stringify(refused)).toContain("ConversationArchived");
    expect(unarchived?.status).toBe("paused");
  });

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

  it("names the Conversations holding a resource at its limit", async () => {
    const { layer } = setup([answer("a"), answer("b")], { shells: 1 });

    const { holder, refused } = await Effect.runPromise(
      Effect.gen(function* () {
        const conversations = yield* Conversations;
        const first = yield* conversations.create({
          sandbox: "shell",
          prompt: "1",
        });
        const second = yield* Effect.exit(
          conversations.create({ sandbox: "shell", prompt: "2" })
        );
        return { holder: first.id, refused: second };
      }).pipe(Effect.provide(layer))
    );

    expect(JSON.stringify(refused)).toContain(
      `"resource":"shell","limit":1,"holders":[${holder}]`
    );
  });

  it("sweeps idle Seats to paused, but never a running one", async () => {
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
        // Once idle, it is swept: paused, its Sandbox removed.
        yield* waitUntil(
          conversations.list.pipe(
            Effect.map((all) => all[0]?.status === "paused")
          ),
          15_000
        );
        expect(sandboxes.live.size).toBe(0);
      }).pipe(Effect.provide(layer))
    );
  }, 30_000);

  it("does not sweep a new conversation before its first run has ended", async () => {
    // idleTimeoutMs 0: the first prompt starts the Run in the commit that admits it, so the
    // first sweep already sees the Seat running.
    const { layer } = setup(
      [callTool("bash", { command: "sleep 1" }), echoToolResult],
      { idleTimeoutMs: 0, sweepEveryMs: 1 }
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const conversations = yield* Conversations;
        yield* conversations.create({ sandbox: "shell", prompt: "sleep" });
        yield* Effect.sleep("200 millis");
        const listed = yield* conversations.list;
        expect(listed).toHaveLength(1);
        expect(listed[0]?.status).toBe("running");
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

  it("saves a Workspace checkpoint when a Run ends, then again when the Seat closes", async () => {
    // A WorkspaceStorage that records saves, over the local sandboxes' directory storage.
    const local = localSandboxes();
    const saves: { readonly id: string; readonly reason: SaveReason }[] = [];
    const recording = Layer.effect(
      WorkspaceStorage,
      Effect.gen(function* () {
        const base = yield* WorkspaceStorage;
        return WorkspaceStorage.of({
          ...base,
          save: (ref, _sandbox, reason) =>
            Effect.sync(() => {
              saves.push({ id: ref.id, reason });
            }),
        });
      })
    ).pipe(Layer.provide(local.storage));
    const sandboxes: LocalSandboxes = {
      ...local,
      layer: Workspaces.layer.pipe(
        Layer.provide(Layer.merge(local.sandboxes, recording))
      ),
    };
    const { layer } = setup([answer("done")], { sandboxes });

    await Effect.runPromise(
      Effect.gen(function* () {
        const conversations = yield* Conversations;
        const created = yield* conversations.create({
          sandbox: "shell",
          prompt: "hi",
        });
        yield* waitUntil(
          conversations.list.pipe(
            Effect.map((all) => all[0]?.status === "idle")
          )
        );
        yield* waitUntil(
          Effect.sync(() => saves.some((save) => save.reason === "checkpoint"))
        );
        yield* conversations.pause(created.id);
        yield* waitUntil(
          Effect.sync(() => saves.some((save) => save.reason === "pause"))
        );
      }).pipe(Effect.provide(layer))
    );

    expect(saves.map((save) => save.reason)).toStrictEqual([
      "checkpoint",
      "pause",
    ]);
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
            yield* conversations.stop(summary.id);
            yield* conversations.pause(summary.id);
          }
          expect(sandboxes.live.size).toBe(0);
        }
        // The cap slot is free again.
        yield* conversations.create({ sandbox: "shell", prompt: "y" });
      }).pipe(Effect.provide(layer))
    );
  });
});

describe("Upgrade", () => {
  it("raises a chat to a shell, then a desktop, keeping its files and swapping its claims", async () => {
    const { layer, sandboxes } = setup([
      answer("hi"),
      callTool("bash", { command: "echo kept > note.txt" }),
      echoToolResult,
      callTool("bash", { command: "cat note.txt" }),
      echoToolResult,
    ]);

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const conversations = yield* Conversations;
        const created = yield* conversations.create({
          sandbox: "none",
          prompt: "hello",
        });
        const idle = conversations.list.pipe(
          Effect.map((all) => all[0]?.status === "idle")
        );
        yield* waitUntil(idle);
        const shell = yield* conversations.upgrade(created.id, {
          level: "shell",
        });
        yield* conversations.send(created.id, "leave a note");
        yield* waitUntil(idle, 10_000);
        const desktop = yield* conversations.upgrade(created.id, {
          level: "desktop",
        });
        const usage = yield* conversations.capacity;
        const stream = yield* conversations.events(created.id);
        yield* conversations.send(created.id, "read it");
        const reply = yield* stream.pipe(
          Stream.filter(
            (event) =>
              event.type === "message_end" &&
              JSON.stringify(event.entry.model).includes("kept")
          ),
          Stream.runHead
        );
        const lower = yield* Effect.exit(
          conversations.upgrade(created.id, { level: "shell" })
        );
        return { shell, desktop, usage, reply, lower };
      }).pipe(Effect.provide(layer))
    );

    expect([result.shell.sandbox, result.desktop.sandbox]).toStrictEqual([
      "shell",
      "desktop",
    ]);
    expect(result.desktop.sandboxId).toBe(result.shell.sandboxId);
    // The shell went back when the desktop came.
    expect(
      result.usage.map((u) => [u.resource, u.holders.length])
    ).toStrictEqual([
      ["seat", 1],
      ["shell", 0],
      ["desktop", 1],
    ]);
    expect([
      result.reply._tag,
      JSON.stringify(result.lower).includes("InvalidUpgrade"),
    ]).toStrictEqual(["Some", true]);
    expect(sandboxes.live.size).toBe(0);
  }, 30_000);

  it("refuses a person's Upgrade at a limit, and records a paused one for its next Seat", async () => {
    const { layer } = setup([answer("a"), answer("b")], { shells: 1 });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const conversations = yield* Conversations;
        yield* conversations.create({ sandbox: "shell", prompt: "holder" });
        const chat = yield* conversations.create({
          sandbox: "none",
          prompt: "chat",
        });
        const refused = yield* Effect.exit(
          conversations.upgrade(chat.id, { level: "shell" })
        );
        yield* conversations.stop(chat.id);
        yield* conversations.pause(chat.id);
        const recorded = yield* conversations.upgrade(chat.id, {
          level: "shell",
        });
        return { refused, recorded };
      }).pipe(Effect.provide(layer))
    );

    expect(JSON.stringify(result.refused)).toContain("CapacityExhausted");
    expect([result.recorded.status, result.recorded.sandbox]).toStrictEqual([
      "paused",
      "shell",
    ]);
  });

  it("lets the agent upgrade, waiting for room until the person pauses a holder", async () => {
    const { layer } = setup(
      [
        answer("holding"),
        callTool("upgrade_workspace", {
          level: "shell",
          reason: "to run code",
        }),
        echoToolResult,
      ],
      { shells: 1 }
    );

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const conversations = yield* Conversations;
        const holder = yield* conversations.create({
          sandbox: "shell",
          prompt: "holder",
        });
        yield* waitUntil(
          conversations.list.pipe(
            Effect.map((all) => all.every((c) => c.status === "idle"))
          )
        );
        const chat = yield* conversations.create({
          sandbox: "none",
          prompt: "run some code",
        });
        const shellUsage = conversations.capacity.pipe(
          Effect.map((usage) => usage.find((u) => u.resource === "shell"))
        );
        yield* waitUntil(
          shellUsage.pipe(
            Effect.map((u) => u?.waiting.includes(chat.id) ?? false)
          )
        );
        yield* conversations.pause(holder.id);
        yield* waitUntil(
          conversations.list.pipe(
            Effect.map(
              (all) =>
                all.find((c) => c.id === chat.id)?.status === "idle" &&
                all.find((c) => c.id === chat.id)?.sandbox === "shell"
            )
          ),
          10_000
        );
        return yield* shellUsage;
      }).pipe(Effect.provide(layer))
    );

    expect(result?.holders).toHaveLength(1);
    expect(result?.waiting).toStrictEqual([]);
  }, 30_000);

  it("ends the agent's waiting Upgrade with an error when the person cancels it", async () => {
    const { layer } = setup(
      [
        answer("holding"),
        callTool("upgrade_workspace", {
          level: "shell",
          reason: "to run code",
        }),
        echoToolResult,
      ],
      { shells: 1 }
    );

    const reply = await Effect.runPromise(
      Effect.gen(function* () {
        const conversations = yield* Conversations;
        yield* conversations.create({ sandbox: "shell", prompt: "holder" });
        const chat = yield* conversations.create({
          sandbox: "none",
          prompt: "run some code",
        });
        yield* waitUntil(
          conversations.capacity.pipe(
            Effect.map((usage) =>
              usage.some((u) => u.waiting.includes(chat.id))
            )
          )
        );
        const stream = yield* conversations.events(chat.id);
        expect(yield* conversations.cancelWait(chat.id)).toBeTruthy();
        return yield* stream.pipe(
          Stream.filter(
            (event) =>
              event.type === "message_end" &&
              JSON.stringify(event.entry.model).includes("cancelled")
          ),
          Stream.runHead
        );
      }).pipe(Effect.provide(layer))
    );

    expect(reply._tag).toBe("Some");
  }, 30_000);
});

// `sandboxes.create` holds on `hold`: a stand-in for a Software image build, which `docker.ts` runs inside
// create. The Conversation is recorded and listed while its Seat is still being made.
const buildGate = ({ free = 0 } = {}) => {
  const started = Deferred.makeUnsafe<boolean>();
  const hold = Deferred.makeUnsafe<boolean>();
  let builds = 0;
  return {
    started,
    hold,
    onCreate: Effect.suspend(() => {
      builds += 1;
      return builds <= free
        ? Effect.void
        : Deferred.succeed(started, true).pipe(
            Effect.andThen(Deferred.await(hold))
          );
    }),
  };
};

const shellHolders = Effect.gen(function* () {
  const conversations = yield* Conversations;
  const usage = yield* conversations.capacity;
  return usage.find((each) => each.resource === "shell")?.holders ?? [];
});

// `onCreate` fails as an image `docker build` would; `except` builds succeed, the rest fail.
const failingBuild = ({ except = new Set<number>() } = {}) => {
  let builds = 0;
  return Effect.suspend(() => {
    builds += 1;
    return except.has(builds)
      ? Effect.void
      : Effect.fail(new SandboxError({ message: "image build failed" }));
  });
};

describe("a Seat mid-open", () => {
  it("a resume during a building open waits for it instead of taking a second Seat", async () => {
    const { started, hold, onCreate } = buildGate();
    const { layer, sandboxes } = setup([answer("hi")], {
      sandboxes: localSandboxes({ onCreate }),
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const conversations = yield* Conversations;
        const creating = yield* conversations
          .create({ sandbox: "shell", prompt: "hi" })
          .pipe(Effect.forkChild);
        yield* Deferred.await(started);
        const listed = yield* conversations.list;
        expect(listed).toHaveLength(1);
        const resuming = yield* conversations
          .resume(listed[0]?.id ?? -1)
          .pipe(Effect.forkChild);
        yield* Effect.sleep("50 millis");
        const during = yield* shellHolders;
        yield* Deferred.succeed(hold, true);
        return {
          during,
          created: yield* Fiber.join(creating),
          resumed: yield* Fiber.join(resuming),
        };
      }).pipe(Effect.provide(layer))
    );

    // One Seat, one Sandbox, one shell claim: the resume waited on the open.
    expect(result.during).toStrictEqual([result.created.id]);
    expect(sandboxes.created).toStrictEqual([{ kind: "shell", software: [] }]);
    expect(result.resumed.id).toBe(result.created.id);
    expect(result.resumed.sandboxId).toBeDefined();
  });

  it("an Upgrade during a building open lands on the opened Seat", async () => {
    const { started, hold, onCreate } = buildGate();
    const { layer, sandboxes } = setup([answer("hi")], {
      sandboxes: localSandboxes({ onCreate }),
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const conversations = yield* Conversations;
        const creating = yield* conversations
          .create({ sandbox: "shell", software: ["node"], prompt: "hi" })
          .pipe(Effect.forkChild);
        yield* Deferred.await(started);
        const listed = yield* conversations.list;
        const upgrading = yield* conversations
          .upgrade(listed[0]?.id ?? -1, { software: ["uv"] })
          .pipe(Effect.forkChild);
        yield* Effect.sleep("50 millis");
        yield* Deferred.succeed(hold, true);
        return {
          created: yield* Fiber.join(creating),
          upgraded: yield* Fiber.join(upgrading),
        };
      }).pipe(Effect.provide(layer))
    );

    // The stored-Upgrade path never ran: the Seat's open committed first, then the Upgrade replaced its Sandbox.
    expect(sandboxes.created).toStrictEqual([
      { kind: "shell", software: ["node"] },
      { kind: "shell", software: ["node", "uv"] },
    ]);
    expect(result.upgraded.software).toStrictEqual(["node", "uv"]);
    expect(result.created.id).toBe(result.upgraded.id);
  });

  it("a Pause during a seated Upgrade's build waits, then closes the new Sandbox", async () => {
    const { started, hold, onCreate } = buildGate({ free: 1 });
    const { layer, sandboxes } = setup([answer("hi")], {
      sandboxes: localSandboxes({ onCreate }),
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const conversations = yield* Conversations;
        const created = yield* conversations.create({
          sandbox: "shell",
          prompt: "hi",
        });
        const upgrading = yield* conversations
          .upgrade(created.id, { software: ["uv"] })
          .pipe(Effect.forkChild);
        yield* Deferred.await(started);
        const pausing = yield* conversations
          .pause(created.id)
          .pipe(Effect.forkChild);
        yield* Effect.sleep("50 millis");
        // The Seat's old Sandbox is still there; the Pause is queued behind the Upgrade, not racing it.
        const during = yield* shellHolders;
        yield* Deferred.succeed(hold, true);
        const upgraded = yield* Fiber.join(upgrading);
        yield* Fiber.join(pausing);
        return {
          during,
          upgraded,
          // Read before the layer closes at the end of this Effect: teardown removes them all.
          sandboxesLive: sandboxes.live.size,
          after: yield* shellHolders,
          listed: yield* conversations.list,
        };
      }).pipe(Effect.provide(layer))
    );

    expect(result.during).toStrictEqual([result.upgraded.id]);
    expect(sandboxes.created).toStrictEqual([
      { kind: "shell", software: [] },
      { kind: "shell", software: ["uv"] },
    ]);
    // Nothing orphaned: both Sandboxes removed, every claim released, the Conversation paused.
    expect(result.sandboxesLive).toBe(0);
    expect(result.after).toStrictEqual([]);
    expect(result.listed[0]).toMatchObject({
      status: "paused",
      software: ["uv"],
    });
  }, 30_000);

  it("an archive during a building open waits, then removes the Seat and the files", async () => {
    const { started, hold, onCreate } = buildGate();
    const { layer, sandboxes } = setup([answer("hi")], {
      sandboxes: localSandboxes({ onCreate }),
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const conversations = yield* Conversations;
        const creating = yield* conversations
          .create({ sandbox: "shell", prompt: "hi" })
          .pipe(Effect.forkChild);
        yield* Deferred.await(started);
        const listed = yield* conversations.list;
        const archiving = yield* conversations
          .archive(listed[0]?.id ?? -1)
          .pipe(Effect.forkChild);
        yield* Effect.sleep("50 millis");
        yield* Deferred.succeed(hold, true);
        return {
          created: yield* Fiber.await(creating),
          archived: yield* Fiber.join(archiving),
          // Read before the layer closes at the end of this Effect: teardown removes them all.
          sandboxesLive: sandboxes.live.size,
          sandboxesStored: sandboxes.stored.size,
          listed: yield* conversations.list,
        };
      }).pipe(Effect.provide(layer))
    );

    expect(result.sandboxesLive).toBe(0);
    expect(result.sandboxesStored).toBe(0);
    expect(result.listed[0]?.status).toBe("archived");
  }, 30_000);
});

describe("a failed build", () => {
  it("leaves a created Conversation paused and claim-free, and its gate settled", async () => {
    const { layer, sandboxes } = setup([answer("hi")], {
      sandboxes: localSandboxes({
        onCreate: failingBuild({ except: new Set([2]) }),
      }),
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const conversations = yield* Conversations;
        const created = yield* conversations
          .create({ sandbox: "shell", prompt: "hi" })
          .pipe(Effect.flip);
        const listed = yield* conversations.list;
        const holders = yield* shellHolders;
        // The open's gate settled on the failure: a resume opens a Seat instead of hanging.
        const resumed = yield* conversations.resume(listed[0]?.id ?? -1);
        return {
          created,
          listed,
          holders,
          resumed,
          sandboxesLive: sandboxes.live.size,
        };
      }).pipe(Effect.provide(layer))
    );

    expect(result.created).toBeInstanceOf(SandboxError);
    expect(result.listed[0]?.status).toBe("paused");
    expect(result.holders).toStrictEqual([]);
    expect(result.resumed.sandboxId).toBeDefined();
    expect(result.sandboxesLive).toBe(1);
  });

  it("on a seated Upgrade keeps the Seat's Sandbox, claims and Software", async () => {
    const { layer, sandboxes } = setup([answer("hi"), answer("more")], {
      sandboxes: localSandboxes({
        onCreate: failingBuild({ except: new Set([1]) }),
      }),
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const conversations = yield* Conversations;
        const created = yield* conversations.create({
          sandbox: "shell",
          prompt: "hi",
        });
        const upgraded = yield* conversations
          .upgrade(created.id, { software: ["uv"] })
          .pipe(Effect.flip);
        // The Seat is unharmed: its old Sandbox still serves sends.
        yield* conversations.send(created.id, "more");
        return {
          upgraded,
          holders: yield* shellHolders,
          listed: yield* conversations.list,
          sandboxesLive: sandboxes.live.size,
        };
      }).pipe(Effect.provide(layer))
    );

    expect(result.upgraded).toBeInstanceOf(SandboxError);
    expect(sandboxes.created).toStrictEqual([{ kind: "shell", software: [] }]);
    expect(result.sandboxesLive).toBe(1);
    expect(result.holders).toStrictEqual([result.listed[0]?.id]);
    expect(result.listed[0]?.software).toStrictEqual([]);
  });

  it("rejects Software the Level forbids before claiming a Seat or Level", async () => {
    const { layer, sandboxes } = setup([answer("hi")], { shells: 1 });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const conversations = yield* Conversations;
        yield* conversations.create({ sandbox: "shell", prompt: "hi" });
        // The one shell is taken, but the invalid Software must read as a 400, not a 409.
        const rejected = yield* conversations
          .create({ sandbox: "shell", software: ["chrome"], prompt: "hi" })
          .pipe(Effect.flip);
        return { rejected, listed: yield* conversations.list };
      }).pipe(Effect.provide(layer))
    );

    expect(result.rejected).toBeInstanceOf(InvalidSetting);
    expect(result.listed).toHaveLength(1);
    expect(sandboxes.created).toStrictEqual([{ kind: "shell", software: [] }]);
  });
});

const metaOf = (agents: Agents["Service"], id: number) =>
  agents.get(id as ConversationId).pipe(Effect.map((stored) => stored.meta));

const emptyAnswer: FauxResponseStep = () =>
  Promise.resolve(fauxAssistantMessage([]));

describe("titles", () => {
  it("generates a title once when a conversation's first run ends", async () => {
    const { layer, faux } = setup([answer("reply"), answer("Greetings Chat")], {
      titleGeneration: true,
    });

    const meta = await Effect.runPromise(
      Effect.gen(function* () {
        const conversations = yield* Conversations;
        const agents = yield* Agents;
        const created = yield* conversations.create({
          sandbox: "none",
          prompt: "say hello",
        });
        expect(created.title).toBe("say hello");
        yield* waitUntil(
          conversations.list.pipe(
            Effect.map((all) => all[0]?.title === "Greetings Chat")
          )
        );
        return yield* metaOf(agents, created.id);
      }).pipe(Effect.provide(layer))
    );

    expect(meta.title).toBe("Greetings Chat");
    expect(meta.titleSource).toBe("generated");
    expect(meta.autoTitleAt).toBeTypeOf("number");
    // One model call for the run, one for the title.
    expect(faux.state.callCount).toBe(2);
  });

  it("does not generate again after a later run", async () => {
    const { layer, faux } = setup(
      [answer("reply"), answer("Greetings Chat"), answer("more")],
      { titleGeneration: true }
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const conversations = yield* Conversations;
        const created = yield* conversations.create({
          sandbox: "none",
          prompt: "say hello",
        });
        yield* waitUntil(
          conversations.list.pipe(
            Effect.map((all) => all[0]?.title === "Greetings Chat")
          )
        );
        yield* conversations.send(created.id, "another");
        yield* waitUntil(
          conversations.list.pipe(
            Effect.map((all) => all[0]?.status === "idle")
          )
        );
        // The second run-end's attempt found the latch spent: no model call, the title stands.
        yield* Effect.sleep("50 millis");
        expect(faux.state.callCount).toBe(3);
        expect((yield* conversations.list)[0]?.title).toBe("Greetings Chat");
      }).pipe(Effect.provide(layer))
    );
  });

  it("keeps the prompt title when generation fails, and does not retry", async () => {
    const { layer, faux } = setup(
      [
        answer("reply"),
        fauxAssistantMessage([fauxText("Whatever")], {
          stopReason: "error",
          errorMessage: "boom",
        }),
        answer("more"),
      ],
      { titleGeneration: true }
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const conversations = yield* Conversations;
        const agents = yield* Agents;
        const created = yield* conversations.create({
          sandbox: "none",
          prompt: "say hello",
        });
        // Recorded before the model call: a failed attempt is still the one attempt.
        yield* waitUntil(
          metaOf(agents, created.id).pipe(
            Effect.map((meta) => meta.autoTitleAt !== undefined)
          )
        );
        yield* conversations.send(created.id, "another");
        yield* waitUntil(
          conversations.list.pipe(
            Effect.map((all) => all[0]?.status === "idle")
          )
        );
        yield* Effect.sleep("50 millis");
        const meta = yield* metaOf(agents, created.id);
        expect(meta.title).toBe("say hello");
        expect(meta.titleSource).toBeUndefined();
        expect(faux.state.callCount).toBe(3);
      }).pipe(Effect.provide(layer))
    );
  });

  it("never overwrites a rename that lands while a title generates", async () => {
    const gate = Deferred.makeUnsafe<boolean>();
    let asked = 0;
    const gated: FauxResponseStep = () => {
      asked += 1;
      return Effect.runPromise(Deferred.await(gate)).then(() =>
        answer("Stomped")
      );
    };
    const { layer } = setup([answer("hi"), gated], { titleGeneration: true });

    await Effect.runPromise(
      Effect.gen(function* () {
        const conversations = yield* Conversations;
        const agents = yield* Agents;
        const created = yield* conversations.create({
          sandbox: "none",
          prompt: "say hello",
        });
        yield* waitUntil(Effect.sync(() => asked === 1));
        yield* conversations.rename(created.id, "Mine");
        yield* Deferred.succeed(gate, true);
        yield* Effect.sleep("150 millis");
        const meta = yield* metaOf(agents, created.id);
        expect(meta.title).toBe("Mine");
        expect(meta.titleSource).toBe("manual");
      }).pipe(Effect.provide(layer))
    );
  });

  it("skips generation for a conversation renamed before its first run ended", async () => {
    const gate = Deferred.makeUnsafe<boolean>();
    const gatedRun: FauxResponseStep = () =>
      Effect.runPromise(Deferred.await(gate)).then(() => answer("hi"));
    const { layer, faux } = setup([gatedRun], { titleGeneration: true });

    await Effect.runPromise(
      Effect.gen(function* () {
        const conversations = yield* Conversations;
        const agents = yield* Agents;
        const created = yield* conversations.create({
          sandbox: "none",
          prompt: "say hello",
        });
        yield* conversations.rename(created.id, "Mine");
        yield* Deferred.succeed(gate, true);
        yield* waitUntil(
          conversations.list.pipe(
            Effect.map((all) => all[0]?.status === "idle")
          )
        );
        yield* Effect.sleep("50 millis");
        const meta = yield* metaOf(agents, created.id);
        expect(meta.title).toBe("Mine");
        expect(meta.titleSource).toBe("manual");
        expect(meta.autoTitleAt).toBeUndefined();
        // The title call never happened: only the run's turn reached the model.
        expect(faux.state.callCount).toBe(1);
      }).pipe(Effect.provide(layer))
    );
  });

  it("names the conversation from a later exchange when the first carries no text", async () => {
    const { layer, faux } = setup(
      [emptyAnswer, answer("a real reply"), answer("Real Title")],
      { titleGeneration: true }
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const conversations = yield* Conversations;
        const agents = yield* Agents;
        const created = yield* conversations.create({
          sandbox: "none",
          prompt: "",
        });
        yield* waitUntil(
          conversations.list.pipe(
            Effect.map((all) => all[0]?.status === "idle")
          )
        );
        yield* Effect.sleep("50 millis");
        // The textless first run spent neither the latch nor a title call.
        const before = yield* metaOf(agents, created.id);
        expect(before.autoTitleAt).toBeUndefined();
        expect(faux.state.callCount).toBe(1);
        yield* conversations.send(created.id, "a real question");
        yield* waitUntil(
          metaOf(agents, created.id).pipe(
            Effect.map((meta) => meta.title === "Real Title")
          )
        );
        const meta = yield* metaOf(agents, created.id);
        expect(meta.titleSource).toBe("generated");
        expect(faux.state.callCount).toBe(3);
      }).pipe(Effect.provide(layer))
    );
  });

  it("regenerates on demand, over a manual title, paused or archived", async () => {
    const { layer } = setup(
      [
        answer("reply"),
        answer("Auto Title"),
        answer("Regenerated"),
        answer("Paused Title"),
        answer("Archived Title"),
      ],
      { titleGeneration: true }
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const conversations = yield* Conversations;
        const agents = yield* Agents;
        const created = yield* conversations.create({
          sandbox: "none",
          prompt: "say hello",
        });
        yield* waitUntil(
          conversations.list.pipe(
            Effect.map((all) => all[0]?.title === "Auto Title")
          )
        );
        yield* conversations.rename(created.id, "Mine");
        const regenerated = yield* conversations.generateTitle(created.id);
        expect(regenerated.title).toBe("Regenerated");
        yield* conversations.pause(created.id);
        const paused = yield* conversations.generateTitle(created.id);
        expect([paused.title, paused.status]).toStrictEqual([
          "Paused Title",
          "paused",
        ]);
        yield* conversations.archive(created.id);
        const archived = yield* conversations.generateTitle(created.id);
        expect([archived.title, archived.status]).toStrictEqual([
          "Archived Title",
          "archived",
        ]);
        const meta = yield* metaOf(agents, created.id);
        expect(meta.titleSource).toBe("generated");
      }).pipe(Effect.provide(layer))
    );
  });

  it("titles a regeneration from the first and the latest exchange", async () => {
    const captured: Message[][] = [];
    const recording: FauxResponseStep = (request) => {
      captured.push([...request.messages]);
      return answer("Regen Title");
    };
    const { layer, faux } = setup(
      [answer("first answer"), recording, answer("second answer")],
      { titleGeneration: true }
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const conversations = yield* Conversations;
        const created = yield* conversations.create({
          sandbox: "none",
          prompt: "first prompt",
        });
        yield* waitUntil(Effect.sync(() => captured.length === 1));
        yield* conversations.send(created.id, "second prompt");
        yield* waitUntil(
          conversations.list.pipe(
            Effect.map((all) => all[0]?.status === "idle")
          )
        );
        faux.appendResponses([recording]);
        yield* conversations.generateTitle(created.id);
      }).pipe(Effect.provide(layer))
    );

    const first = String(captured[0]?.find((m) => m.role === "user")?.content);
    expect(captured).toHaveLength(2);
    for (const part of ["first prompt", "first answer"]) {
      expect(first).toContain(part);
    }
    const latest = String(captured[1]?.find((m) => m.role === "user")?.content);
    for (const part of [
      "first prompt",
      "first answer",
      "second prompt",
      "second answer",
    ]) {
      expect(latest).toContain(part);
    }
  });

  it("never generates when titleGeneration is off", async () => {
    const { layer, faux } = setup([answer("reply")]);

    const { meta, failed } = await Effect.runPromise(
      Effect.gen(function* () {
        const conversations = yield* Conversations;
        const agents = yield* Agents;
        const created = yield* conversations.create({
          sandbox: "none",
          prompt: "say hello",
        });
        yield* waitUntil(
          conversations.list.pipe(
            Effect.map((all) => all[0]?.status === "idle")
          )
        );
        yield* Effect.sleep("50 millis");
        return {
          meta: yield* metaOf(agents, created.id),
          failed: yield* Effect.flip(conversations.generateTitle(created.id)),
        };
      }).pipe(Effect.provide(layer))
    );

    expect(meta.title).toBe("say hello");
    expect(meta.autoTitleAt).toBeUndefined();
    expect(failed).toMatchObject({
      _tag: "TitleGenerationFailed",
      reason: "no_model",
    });
    expect(faux.state.callCount).toBe(1);
  });

  it("fails a regeneration for a conversation with no answered exchange", async () => {
    const gate = Deferred.makeUnsafe<boolean>();
    const gatedRun: FauxResponseStep = () =>
      Effect.runPromise(Deferred.await(gate)).then(() => answer("late"));
    const { layer } = setup([gatedRun], { titleGeneration: true });

    const failed = await Effect.runPromise(
      Effect.gen(function* () {
        const conversations = yield* Conversations;
        const created = yield* conversations.create({
          sandbox: "none",
          prompt: "say hello",
        });
        const flipped = yield* Effect.flip(
          conversations.generateTitle(created.id)
        );
        yield* Deferred.succeed(gate, true);
        return flipped;
      }).pipe(Effect.provide(layer))
    );

    expect(failed).toMatchObject({
      _tag: "TitleGenerationFailed",
      reason: "no_exchange",
    });
  });
});
