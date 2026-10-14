import { Effect, Exit, Scope } from "effect";
import { describe, expect, it } from "vitest";

import { Capacity } from "./capacity.ts";
import type { Limits } from "./capacity.ts";

const run = <A, E>(effect: Effect.Effect<A, E, Capacity>, limits?: Limits) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(
        Capacity.layer(limits ?? { seats: 3, shells: 1, desktops: 2 })
      )
    )
  );

describe(Capacity, () => {
  it("fills seats with any mix of Levels, then refuses even a chat", async () => {
    const exit = await run(
      Effect.gen(function* () {
        const capacity = yield* Capacity;
        const scope = yield* Scope.make();
        const shell = yield* capacity
          .claim(["seat", "shell"])
          .pipe(Scope.provide(scope));
        yield* shell.assign(1);
        const desktops = yield* Effect.forEach([2, 3], (holder) =>
          capacity.claim(["seat", "desktop"]).pipe(
            Scope.provide(scope),
            Effect.tap((claim) => claim.assign(holder))
          )
        );
        expect(desktops).toHaveLength(2);
        return yield* Effect.exit(
          capacity.claim(["seat"]).pipe(Scope.provide(scope))
        );
      })
    );
    expect(Exit.isFailure(exit)).toBeTruthy();
    expect(JSON.stringify(exit)).toContain('"resource":"seat"');
    expect(JSON.stringify(exit)).toContain('"holders":[1,2,3]');
  });

  it("runs many chats while the sandbox limits are small", async () => {
    const holders = await run(
      Effect.gen(function* () {
        const capacity = yield* Capacity;
        const scope = yield* Scope.make();
        yield* Effect.forEach(
          Array.from({ length: 10 }, (_, i) => i),
          (id) =>
            capacity.claim(["seat"]).pipe(
              Scope.provide(scope),
              Effect.tap((claim) => claim.assign(id))
            )
        );
        const usage = yield* capacity.usage;
        return usage.find((each) => each.resource === "seat")?.holders;
      }),
      { seats: 10, shells: 2, desktops: 2 }
    );
    expect(holders).toHaveLength(10);
  });

  it("takes all of a claim or none of it, and releases it with its scope", async () => {
    const usage = await run(
      Effect.gen(function* () {
        const capacity = yield* Capacity;
        const held = yield* Scope.make();
        yield* capacity.claim(["seat", "shell"]).pipe(Scope.provide(held));
        // The shell is taken, so this claim fails and must not keep its seat.
        const refused = yield* Effect.exit(
          Effect.scoped(capacity.claim(["seat", "shell"]))
        );
        expect(Exit.isFailure(refused)).toBeTruthy();
        expect(JSON.stringify(refused)).toContain('"resource":"shell"');
        const during = yield* capacity.usage;
        yield* Scope.close(held, Exit.void);
        return { during, after: yield* capacity.usage };
      })
    );
    // An unassigned claim counts against the limit without being listed.
    expect(
      usage.during.find((u) => u.resource === "seat")?.holders
    ).toStrictEqual([]);
    expect(usage.after.every((each) => each.holders.length === 0)).toBeTruthy();
  });
});
