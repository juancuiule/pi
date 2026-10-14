// Capacity: how many Seats, shell Sandboxes and desktop Sandboxes the server runs at once (see GLOSSARY.md).
// Every Seat takes a `seat`; a shell or desktop Seat also takes a `shell` or a `desktop`. Nothing is evicted at a
// limit: a claim fails with the Conversations holding the short resource, so a person can pick one to Pause.
import { Context, Effect, Layer } from "effect";
import type { Scope } from "effect";

import { CapacityExhausted } from "./errors.ts";

export type Resource = "seat" | "shell" | "desktop";

export interface Limits {
  readonly seats: number;
  readonly shells: number;
  readonly desktops: number;
}

export interface Usage {
  readonly resource: Resource;
  readonly limit: number;
  /** Conversations holding one; a claim not yet assigned counts against the limit but is not listed. */
  readonly holders: readonly number[];
}

/** Resources taken together by one claim. */
export interface Claim {
  /** Name the Conversation holding this claim, once it exists, so it is listed as a holder. */
  assign(holder: number): Effect.Effect<void>;
}

export class Capacity extends Context.Service<
  Capacity,
  {
    /**
     * Take one of each resource, all or none, until the scope closes. Fails with `CapacityExhausted` for the first
     * resource at its limit.
     */
    claim(
      resources: readonly Resource[]
    ): Effect.Effect<Claim, CapacityExhausted, Scope.Scope>;
    readonly usage: Effect.Effect<readonly Usage[]>;
  }
>()("effect-pi/Capacity") {
  static readonly layer = (limits: Limits) =>
    Layer.sync(Capacity, () => {
      const limitOf: Record<Resource, number> = {
        seat: limits.seats,
        shell: limits.shells,
        desktop: limits.desktops,
      };
      // Each live claim with the resources it took; `holder` is unset until assigned.
      const claims = new Set<{
        readonly resources: readonly Resource[];
        holder: number | undefined;
      }>();
      const taken = (resource: Resource) =>
        [...claims].filter((entry) => entry.resources.includes(resource));
      const holdersOf = (resource: Resource) =>
        taken(resource).flatMap((entry) =>
          entry.holder === undefined ? [] : [entry.holder]
        );

      const claim = (resources: readonly Resource[]) =>
        Effect.acquireRelease(
          Effect.suspend(() => {
            const short = resources.find(
              (resource) => taken(resource).length >= limitOf[resource]
            );
            if (short !== undefined) {
              return Effect.fail(
                new CapacityExhausted({
                  resource: short,
                  limit: limitOf[short],
                  holders: holdersOf(short),
                })
              );
            }
            const entry = {
              resources,
              holder: undefined as number | undefined,
            };
            claims.add(entry);
            return Effect.succeed(entry);
          }),
          (entry) => Effect.sync(() => claims.delete(entry))
        ).pipe(
          Effect.map((entry): Claim => ({
            assign: (holder) =>
              Effect.sync(() => {
                entry.holder = holder;
              }),
          }))
        );

      const usage = Effect.sync(() =>
        (["seat", "shell", "desktop"] as const).map((resource): Usage => ({
          resource,
          limit: limitOf[resource],
          holders: holdersOf(resource),
        }))
      );

      return Capacity.of({ claim, usage });
    });
}
