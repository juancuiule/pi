import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { Agents } from "../agents/agents.ts";
import { fauxAgents, offered, offeredIn } from "../testing/faux.ts";
import { alice } from "../testing/users.ts";

const MENTIONS = "`@path` names a path under /workspace";

describe("the workspace section", () => {
  it("explains `@path` mentions once the conversation has files, from the next request after an Upgrade", async () => {
    const { layer } = fauxAgents([offered, offered]);

    const [before, after] = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const agents = yield* Agents;
          const id = yield* agents.create({
            owner: alice.id,
            prompt: "",
            title: "",
            level: "none",
            createdAt: 0,
          });
          const seat = yield* agents.open(id);
          const first = yield* seat.ask("Hello");
          yield* seat.upgrade({ level: "shell" });
          const second = yield* seat.ask("Look at @src/app.ts");
          return [first, second].map((answer) => offeredIn(answer).system);
        })
      ).pipe(Effect.provide(layer))
    );

    expect(before).not.toContain(MENTIONS);
    expect(after).toContain(MENTIONS);
  });
});
