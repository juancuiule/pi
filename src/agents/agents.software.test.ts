import type { ConversationId } from "@earendil-works/pi-durable";
import { Effect, Stream } from "effect";
import { describe, expect, it } from "vitest";

import { Capacity } from "../capacity.ts";
import type { Resource } from "../capacity.ts";
import { fauxAgents, offered, offeredIn } from "../testing/faux.ts";
import { alice } from "../testing/users.ts";
import { Agents } from "./agents.ts";
import { SETTINGS_ENTRY } from "./settings.ts";

const create = (
  options: Partial<Parameters<(typeof Agents)["Service"]["create"]>[0]> = {}
) =>
  Effect.gen(function* () {
    const agents = yield* Agents;
    return yield* agents.create({
      owner: alice.id,
      prompt: "",
      title: "",
      level: "shell",
      createdAt: 0,
      ...options,
    });
  });

const recordsOf = (id: ConversationId) =>
  Effect.gen(function* () {
    const agents = yield* Agents;
    const events = yield* agents.events(id);
    const [first] = yield* events.pipe(Stream.take(1), Stream.runCollect);
    return first?.type === "snapshot"
      ? first.entries
          .filter((entry) => entry.kind === SETTINGS_ENTRY)
          .map((entry) => entry.data)
      : [];
  });

const holdersOf = (resource: Resource) =>
  Effect.gen(function* () {
    const capacity = yield* Capacity;
    const usage = yield* capacity.usage;
    return usage.find((each) => each.resource === resource)?.holders;
  });

describe("Software", () => {
  it("is recorded at create, in catalog order, and asked of every Sandbox", async () => {
    const { layer, sandboxes } = fauxAgents([]);

    const stored = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const agents = yield* Agents;
          const id = yield* create({ software: ["ffmpeg", "node", "ffmpeg"] });
          yield* agents.open(id);
          return yield* agents.get(id);
        })
      ).pipe(Effect.provide(layer))
    );

    expect(stored.software).toStrictEqual(["node", "ffmpeg"]);
    expect(sandboxes.created).toStrictEqual([
      { kind: "shell", software: ["node", "ffmpeg"] },
    ]);
  });

  it("refuses Software the Level does not offer, creating nothing", async () => {
    const { layer } = fauxAgents([]);

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const agents = yield* Agents;
        const chat = yield* Effect.flip(
          create({ level: "none", software: ["node"] })
        );
        return { chat, all: yield* agents.list };
      }).pipe(Effect.provide(layer))
    );

    expect(result.chat._tag).toBe("InvalidSetting");
    expect(result.all).toHaveLength(0);
  });

  it("is added by an Upgrade at the same Level, in a new Sandbox with both", async () => {
    const { layer, sandboxes } = fauxAgents([]);

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const agents = yield* Agents;
          const id = yield* create({ software: ["node"] });
          const seat = yield* agents.open(id);
          yield* seat.upgrade({ software: ["ffmpeg"] });
          return {
            level: seat.level,
            stored: yield* agents.get(id),
            records: yield* recordsOf(id),
          };
        })
      ).pipe(Effect.provide(layer))
    );

    expect(sandboxes.created).toStrictEqual([
      { kind: "shell", software: ["node"] },
      { kind: "shell", software: ["node", "ffmpeg"] },
    ]);
    expect(result.level).toBe("shell");
    expect(result.stored.software).toStrictEqual(["node", "ffmpeg"]);
    expect(result.records).toStrictEqual([
      { by: "person", changes: [{ type: "software", added: ["ffmpeg"] }] },
    ]);
  });

  it("is added at the same Level under the Seat's own claim, even at the limit", async () => {
    const { layer, sandboxes } = fauxAgents([], {
      limits: { seats: 2, shells: 1, desktops: 1 },
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const agents = yield* Agents;
        const id = yield* create({ software: ["node"] });
        const during = yield* Effect.scoped(
          Effect.gen(function* () {
            const seat = yield* agents.open(id);
            yield* seat.upgrade({ software: ["ffmpeg"] });
            return yield* holdersOf("shell");
          })
        );
        return { id: Number(id), during, after: yield* holdersOf("shell") };
      }).pipe(Effect.provide(layer))
    );

    expect(sandboxes.created).toStrictEqual([
      { kind: "shell", software: ["node"] },
      { kind: "shell", software: ["node", "ffmpeg"] },
    ]);
    expect(result.during).toStrictEqual([result.id]);
    expect(result.after).toStrictEqual([]);
    expect(sandboxes.live.size).toBe(0);
  });

  it("refuses a Level Upgrade at the limit, keeping the Sandbox and its claim", async () => {
    const { layer, sandboxes } = fauxAgents([], {
      limits: { seats: 2, shells: 1, desktops: 1 },
    });

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const agents = yield* Agents;
          const holder = yield* create({ level: "desktop" });
          yield* agents.open(holder);
          const id = yield* create({ software: ["ffmpeg"] });
          const seat = yield* agents.open(id);
          const refused = yield* Effect.flip(
            seat.upgrade({ level: "desktop" })
          );
          return {
            holder: Number(holder),
            id: Number(id),
            refused,
            level: seat.level,
            shells: yield* holdersOf("shell"),
            desktops: yield* holdersOf("desktop"),
          };
        })
      ).pipe(Effect.provide(layer))
    );

    expect(result.refused._tag).toBe("CapacityExhausted");
    expect(result.level).toBe("shell");
    expect(result.shells).toStrictEqual([result.id]);
    expect(result.desktops).toStrictEqual([result.holder]);
    expect(sandboxes.created).toStrictEqual([
      { kind: "desktop", software: [] },
      { kind: "shell", software: ["ffmpeg"] },
    ]);
  });

  it("is kept by a Level Upgrade", async () => {
    const { layer, sandboxes } = fauxAgents([]);

    const stored = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const agents = yield* Agents;
          const id = yield* create({ software: ["ffmpeg"] });
          const seat = yield* agents.open(id);
          yield* seat.upgrade({ level: "desktop" });
          return yield* agents.get(id);
        })
      ).pipe(Effect.provide(layer))
    );

    expect(sandboxes.created).toStrictEqual([
      { kind: "shell", software: ["ffmpeg"] },
      { kind: "desktop", software: ["ffmpeg"] },
    ]);
    expect([stored.level, stored.software]).toStrictEqual([
      "desktop",
      ["ffmpeg"],
    ]);
  });

  it("refuses an Upgrade that adds nothing, or Software the Level cannot have", async () => {
    const { layer, sandboxes } = fauxAgents([]);

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const agents = yield* Agents;
          const id = yield* create({ software: ["node"] });
          const seat = yield* agents.open(id);
          const chat = yield* create({ level: "none" });
          return yield* Effect.all([
            Effect.flip(seat.upgrade({ software: ["node"] })),
            Effect.flip(seat.upgrade({ level: "shell" })),
            Effect.flip(seat.upgrade({})),
            Effect.flip(seat.upgrade({ software: ["chrome"] })),
            Effect.flip(agents.upgrade(chat, { software: ["node"] })),
          ]);
        })
      ).pipe(Effect.provide(layer))
    );

    expect(result.map((error) => error._tag)).toStrictEqual(
      Array.from({ length: 5 }, () => "InvalidUpgrade")
    );
    expect(sandboxes.created).toHaveLength(1);
  });

  it("raises a paused conversation's Level and Software for its next Seat", async () => {
    const { layer, sandboxes } = fauxAgents([]);

    const stored = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const agents = yield* Agents;
          const id = yield* create({ level: "none" });
          yield* agents.upgrade(id, { level: "shell", software: ["node"] });
          yield* agents.open(id);
          return yield* agents.get(id);
        })
      ).pipe(Effect.provide(layer))
    );

    expect([stored.level, stored.software]).toStrictEqual(["shell", ["node"]]);
    expect(sandboxes.created).toStrictEqual([
      { kind: "shell", software: ["node"] },
    ]);
  });

  it("is listed in the workspace section, from the next request after an Upgrade", async () => {
    const { layer } = fauxAgents([offered, offered]);

    const [before, after] = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const agents = yield* Agents;
          const id = yield* create({ software: ["node"] });
          const seat = yield* agents.open(id);
          const first = yield* seat.ask("What is installed?");
          yield* seat.upgrade({ software: ["ffmpeg"] });
          const second = yield* seat.ask("And now?");
          return [first, second].map((answer) => offeredIn(answer).system);
        })
      ).pipe(Effect.provide(layer))
    );

    const node = "- Node.js 24 (`node`, `npm`, `npx`, `pnpm`, `yarn`)";
    const ffmpeg = "- FFmpeg (`ffmpeg`, `ffprobe`)";
    expect(before).toContain(
      `Installed beyond the base system:\\n${node}\\n</workspace>`
    );
    expect(after).toContain(
      `Installed beyond the base system:\\n${node}\\n${ffmpeg}\\n</workspace>`
    );
  });
});
