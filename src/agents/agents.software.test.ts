import type { ConversationId } from "@earendil-works/pi-durable";
import { Effect, Stream } from "effect";
import { describe, expect, it } from "vitest";

import { Capacity } from "../capacity.ts";
import type { Resource } from "../capacity.ts";
import { fauxAgents, offered, offeredIn } from "../testing/faux.ts";
import { Agents } from "./agents.ts";
import { SETTINGS_ENTRY } from "./settings.ts";

const create = (
  options: Partial<Parameters<(typeof Agents)["Service"]["create"]>[0]> = {}
) =>
  Effect.gen(function* () {
    const agents = yield* Agents;
    return yield* agents.create({
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
          const id = yield* create({ software: ["uv", "node", "uv"] });
          yield* agents.open(id);
          return yield* agents.get(id);
        })
      ).pipe(Effect.provide(layer))
    );

    expect(stored.software).toStrictEqual(["node", "uv"]);
    expect(sandboxes.created).toStrictEqual([
      { kind: "shell", software: ["node", "uv"] },
    ]);
  });

  it("refuses Software the Level does not offer, creating nothing", async () => {
    const { layer } = fauxAgents([]);

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const agents = yield* Agents;
        const chrome = yield* Effect.flip(create({ software: ["chrome"] }));
        const chat = yield* Effect.flip(
          create({ level: "none", software: ["node"] })
        );
        return { chrome, chat, all: yield* agents.list };
      }).pipe(Effect.provide(layer))
    );

    expect([result.chrome._tag, result.chat._tag]).toStrictEqual([
      "InvalidSetting",
      "InvalidSetting",
    ]);
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
          yield* seat.upgrade({ software: ["uv"] });
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
      { kind: "shell", software: ["node", "uv"] },
    ]);
    expect(result.level).toBe("shell");
    expect(result.stored.software).toStrictEqual(["node", "uv"]);
    expect(result.records).toStrictEqual([
      { by: "person", changes: [{ type: "software", added: ["uv"] }] },
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
            yield* seat.upgrade({ software: ["uv"] });
            return yield* holdersOf("shell");
          })
        );
        return { id: Number(id), during, after: yield* holdersOf("shell") };
      }).pipe(Effect.provide(layer))
    );

    expect(sandboxes.created).toStrictEqual([
      { kind: "shell", software: ["node"] },
      { kind: "shell", software: ["node", "uv"] },
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
          const id = yield* create({ software: ["uv"] });
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
      { kind: "shell", software: ["uv"] },
    ]);
  });

  it("is kept by a Level Upgrade", async () => {
    const { layer, sandboxes } = fauxAgents([]);

    const stored = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const agents = yield* Agents;
          const id = yield* create({ software: ["uv"] });
          const seat = yield* agents.open(id);
          yield* seat.upgrade({ level: "desktop" });
          return yield* agents.get(id);
        })
      ).pipe(Effect.provide(layer))
    );

    expect(sandboxes.created).toStrictEqual([
      { kind: "shell", software: ["uv"] },
      { kind: "desktop", software: ["uv"] },
    ]);
    expect([stored.level, stored.software]).toStrictEqual(["desktop", ["uv"]]);
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
          yield* seat.upgrade({ software: ["uv"] });
          const second = yield* seat.ask("And now?");
          return [first, second].map((answer) => offeredIn(answer).system);
        })
      ).pipe(Effect.provide(layer))
    );

    const node = "- Node.js 24 (`node`, `npm`, `npx`, `pnpm`, `yarn`)";
    const uv =
      "- uv, which manages Python environments and packages (`uv venv`, `uv pip install`, `uv run`). Use it instead of pip.";
    expect(before).toContain(
      `Installed beyond the base system:\\n${node}\\n</workspace>`
    );
    expect(after).toContain(
      `Installed beyond the base system:\\n${node}\\n${uv}\\n</workspace>`
    );
  });
});

const BROWSER_TOOLS = [
  "browser_click",
  "browser_fill",
  "browser_navigate",
  "browser_open",
  "browser_press",
  "browser_screenshot",
  "browser_scroll",
  "browser_select",
  "browser_snapshot",
  "browser_tabs",
  "browser_text",
  "browser_wait",
];

const browserTools = (answer: string) =>
  offeredIn(answer).tools.filter((tool) => tool.startsWith("browser_"));

// Chrome for Testing, which agent-browser installs, has no Linux arm64 build, so only x64 hosts offer it.
describe.skipIf(process.arch !== "x64")("Software with an extension", () => {
  it("offers the browser tools and section only to a Workspace with agent-browser", async () => {
    const { layer } = fauxAgents([offered, offered]);

    const [without, withBrowser] = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const agents = yield* Agents;
          const plain = yield* agents.open(yield* create());
          const browsing = yield* agents.open(
            yield* create({ software: ["agent-browser"] })
          );
          return [yield* plain.ask("hi"), yield* browsing.ask("hi")];
        })
      ).pipe(Effect.provide(layer))
    );

    expect(browserTools(without)).toStrictEqual([]);
    expect(offeredIn(without).system).not.toContain("<page_content>");
    expect(browserTools(withBrowser)).toStrictEqual(BROWSER_TOOLS);
    expect(offeredIn(withBrowser).system).toContain("<page_content>");
  });

  it("adds the browser tools to a running conversation when an Upgrade adds agent-browser", async () => {
    const { layer } = fauxAgents([offered, offered]);

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const agents = yield* Agents;
          const id = yield* create();
          const seat = yield* agents.open(id);
          const before = yield* seat.ask("hi");
          yield* seat.upgrade({ software: ["agent-browser"] });
          const after = yield* seat.ask("hi");
          const settings = yield* agents.agent(id);
          return {
            before,
            after,
            browser: settings.extensions.find(
              (each) => each.name === "browser"
            ),
          };
        })
      ).pipe(Effect.provide(layer))
    );

    expect(browserTools(result.before)).toStrictEqual([]);
    expect(browserTools(result.after)).toStrictEqual(BROWSER_TOOLS);
    expect(result.browser).toMatchObject({
      enabled: true,
      available: true,
      software: "agent-browser",
    });
  });

  it("adds the browser tools when agent-browser is added to a paused conversation", async () => {
    const { layer } = fauxAgents([offered]);

    const answer = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const agents = yield* Agents;
          const id = yield* create();
          yield* agents.upgrade(id, { software: ["agent-browser"] });
          const seat = yield* agents.open(id);
          return yield* seat.ask("hi");
        })
      ).pipe(Effect.provide(layer))
    );

    expect(browserTools(answer)).toStrictEqual(BROWSER_TOOLS);
  });

  it("refuses to turn the browser on without agent-browser, and says what to add", async () => {
    const { layer } = fauxAgents([]);

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const agents = yield* Agents;
        const id = yield* create();
        const refused = yield* Effect.flip(
          agents.configure(id, { extensions: { browser: true } })
        );
        const settings = yield* agents.agent(id);
        return {
          refused,
          browser: settings.extensions.find((each) => each.name === "browser"),
        };
      }).pipe(Effect.provide(layer))
    );

    expect(result.refused).toMatchObject({
      _tag: "InvalidSetting",
      name: "browser",
      reason: "needs the Browser for the agent software; add it first",
    });
    expect(result.browser).toMatchObject({ enabled: false, available: false });
  });
});
