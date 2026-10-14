// Capacity: how many Seats, shell Sandboxes and desktop Sandboxes the server runs at once (see GLOSSARY.md).
// Every Seat takes a `seat`; a shell or desktop Seat also takes a `shell` or a `desktop`. Nothing is evicted at a
// limit: a claim fails with the Conversations holding the short resource, so a person can pick one to Pause, or,
// when asked to, waits until one is released.
import { Context, Deferred, Effect, Layer, Option, Schema } from "effect";
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
  /** Conversations waiting for one. */
  readonly waiting: readonly number[];
}

/** A waiting claim withdrawn by `cancel`. */
export class ClaimCancelled extends Schema.TaggedError<ClaimCancelled>()(
  "ClaimCancelled",
  { holder: Schema.Number }
) {}

/** Resources taken together by one claim. */
export interface Claim {
  /** Name the Conversation holding this claim, once it exists, so it is listed as a holder. */
  assign(holder: number): Effect.Effect<void>;
  /** Give the resources back before the scope closes; later calls, and the scope's own release, do nothing. */
  readonly release: Effect.Effect<void>;
}

export class Capacity extends Context.Service<
  Capacity,
  {
    /**
     * Take one of each resource, all or none, until the scope closes or the claim is released. At a limit it fails
     * with `CapacityExhausted` for the first short resource, or, with `wait`, waits until there is room; a waiting
     * claim is listed under its `holder` and can be withdrawn with `cancel`.
     */
    claim(
      resources: readonly Resource[],
      options?: { readonly holder?: number; readonly wait?: boolean }
    ): Effect.Effect<Claim, CapacityExhausted | ClaimCancelled, Scope.Scope>;
    /** Withdraw `holder`'s waiting claims; true when there was one. */
    cancel(holder: number): Effect.Effect<boolean>;
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
      // Claims waiting for room; each is woken by every release, and tries again.
      const waiters = new Set<{
        readonly resources: readonly Resource[];
        readonly holder: number | undefined;
        readonly wake: Deferred.Deferred<boolean, ClaimCancelled>;
      }>();
      const taken = (resource: Resource) =>
        [...claims].filter((entry) => entry.resources.includes(resource));
      const holdersOf = (resource: Resource) =>
        taken(resource).flatMap((entry) =>
          entry.holder === undefined ? [] : [entry.holder]
        );
      const wakeAll = Effect.suspend(() =>
        Effect.forEach(
          [...waiters],
          (waiter) => Deferred.succeed(waiter.wake, true),
          { discard: true }
        )
      );

      const take = (
        resources: readonly Resource[],
        holder: number | undefined
      ) =>
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
            const entry = { resources, holder };
            claims.add(entry);
            return Effect.succeed(entry);
          }),
          (entry) =>
            Effect.suspend(() => (claims.delete(entry) ? wakeAll : Effect.void))
        ).pipe(
          Effect.map((entry): Claim => ({
            assign: (assigned) =>
              Effect.sync(() => {
                entry.holder = assigned;
              }),
            release: Effect.suspend(() =>
              claims.delete(entry) ? wakeAll : Effect.void
            ),
          }))
        );

      // Registered before trying again, so a release between the failed try and the wait still wakes it.
      // `None` when woken without room yet.
      const waitOnce = (
        resources: readonly Resource[],
        holder: number | undefined
      ) =>
        Effect.gen(function* () {
          const wake = yield* Deferred.make<boolean, ClaimCancelled>();
          const waiter = { resources, holder, wake };
          return yield* Effect.sync(() => waiters.add(waiter)).pipe(
            Effect.andThen(take(resources, holder)),
            Effect.map(Option.some),
            Effect.catchTag("CapacityExhausted", () =>
              Deferred.await(wake).pipe(Effect.as(Option.none<Claim>()))
            ),
            Effect.ensuring(Effect.sync(() => waiters.delete(waiter)))
          );
        });

      const claim = (
        resources: readonly Resource[],
        options: { readonly holder?: number; readonly wait?: boolean } = {}
      ): Effect.Effect<
        Claim,
        CapacityExhausted | ClaimCancelled,
        Scope.Scope
      > =>
        take(resources, options.holder).pipe(
          Effect.catchTag("CapacityExhausted", (exhausted) =>
            options.wait === true
              ? waitOnce(resources, options.holder).pipe(
                  Effect.flatMap((outcome) =>
                    Option.isSome(outcome)
                      ? Effect.succeed(outcome.value)
                      : claim(resources, options)
                  )
                )
              : Effect.fail(exhausted)
          )
        );

      const cancel = (holder: number) =>
        Effect.gen(function* () {
          const mine = [...waiters].filter(
            (waiter) => waiter.holder === holder
          );
          for (const waiter of mine) {
            yield* Deferred.fail(waiter.wake, new ClaimCancelled({ holder }));
          }
          return mine.length > 0;
        });

      const usage = Effect.sync(() =>
        (["seat", "shell", "desktop"] as const).map((resource): Usage => ({
          resource,
          limit: limitOf[resource],
          holders: holdersOf(resource),
          waiting: [...waiters].flatMap((waiter) =>
            waiter.holder !== undefined && waiter.resources.includes(resource)
              ? [waiter.holder]
              : []
          ),
        }))
      );

      return Capacity.of({ claim, cancel, usage });
    });
}
