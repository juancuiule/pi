// Sandbox notifications: a machine process leaves the agent a message by dropping one small file per
// notification into `<cwd>/.pi-notify/` — `pi-notify` writes it through a hidden temporary file renamed
// into place, so every visible file is complete and `exclude.hidden` keeps those writes out of the
// watcher's reports. A spool file exists while no submission claims it: writers only create, this watcher
// is the only deleter, and it deletes once the submission is admitted. Files never claimed ride the
// Workspace's saves and deliver to the next Seat; ones claimed but still queued withdraw on Pause or Stop
// exactly like a person's queued input, and a re-drain's dedup covers the submit→delete gap.
import { BACKGROUND_CONTEXT, withCancel } from "@earendil-works/chord/context";
import { defineExtension, section } from "@earendil-works/pi-durable";
import type { Extension } from "@earendil-works/pi-durable";
import type {
  ExecutionEnv,
  FileInfo,
  FileWatcher,
  WatchChange,
} from "@earendil-works/pi-durable/env";
import { Effect, Exit, Queue } from "effect";
import type { Scope } from "effect";

import { escapeAttachmentTags } from "../attachments/format.ts";
import { WorkspaceDoc } from "../workspaces/workspaces.ts";

/** The spool directory below the Sandbox's working directory; hidden inside a Workspace's files. */
export const NOTIFY_DIR = ".pi-notify";
/** A notification is delivered cut at this many bytes. */
export const NOTIFY_MAX_BYTES = 8 * 1024;
/** How many files one drain pass takes; more wait for the next pass. */
export const NOTIFY_SWEEP_MAX = 32;
/** Files a drain claims before it has to pace itself. */
export const NOTIFY_BURST = 8;
/** How long a paced drain waits for each further token. */
export const NOTIFY_REFILL_MS = 5000;
// A dead watcher is re-established with an exponential backoff from here, this many tries at most.
const WATCH_BACKOFF_MS = 2000;
const WATCH_TRIES = 5;

export const OPEN_TAG = '<sandbox-notification at="';
export const CLOSE_TAG = "</sandbox-notification>";

/**
 * Text that cannot open or close a notification block: a file's payload cannot close its block early, and
 * what a person types cannot pass for a notification the Sandbox sent. Mirrors `escapeAttachmentTags`.
 */
export const escapeNotificationTags = (text: string): string =>
  text.replaceAll(
    /<(?<slash>\/?)sandbox-notification/giu,
    "<$<slash>\u200Bsandbox-notification"
  );

/** Same name and mtime is the same notification across re-drains and restarts; a rewrite is a new one. */
export const notifyRequestId = (name: string, mtimeMs: number): string =>
  `pi-notify/${mtimeMs}/${name}`;

/** One file's submission: its writing time, then its text — escaped so it cannot pass for another block. */
export const formatNotification = (file: FileInfo, text: string): string =>
  `${OPEN_TAG}${new Date(file.mtimeMs).toISOString()}">\n${escapeNotificationTags(escapeAttachmentTags(text))}\n${CLOSE_TAG}`;

/**
 * Drain `env`'s notification spool: on start and on every change below it, each visible file becomes one
 * submission `submit` admits — oldest first, at most `sweepMax` a pass — while a token bucket paces a
 * flood to `burst` at once and one more every `refillMs`, deferring rather than dropping. Forked on the
 * caller's scope like `shellSession` (src/sandbox/shell-session.ts). Never fails the caller: a dead
 * watcher is re-established a few times, then the drain stops and the files deliver to the next Seat.
 * `submit` resolves once a submission durably claims the file; a rejection keeps it for the next pass.
 */
export const watchNotifications = (
  env: ExecutionEnv,
  submit: (content: string, requestId: string) => Promise<void>,
  options: {
    readonly maxBytes?: number;
    readonly sweepMax?: number;
    readonly burst?: number;
    readonly refillMs?: number;
  } = {}
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    const maxBytes = options.maxBytes ?? NOTIFY_MAX_BYTES;
    const sweepMax = options.sweepMax ?? NOTIFY_SWEEP_MAX;
    const burst = options.burst ?? NOTIFY_BURST;
    const refillMs = options.refillMs ?? NOTIFY_REFILL_MS;
    yield* Effect.forkScoped(
      Effect.gen(function* () {
        const decoder = new TextDecoder();
        const ticked = yield* Queue.unbounded<"drain" | "rewatch">();
        // Env calls see this context; the scope closing cancels them and closes the watcher.
        const scoped = withCancel(BACKGROUND_CONTEXT);
        let watcher: FileWatcher | undefined;
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            scoped.cancel();
            const current = watcher;
            if (current !== undefined) {
              yield* Effect.promise(() => current.close(BACKGROUND_CONTEXT));
            }
          })
        );
        const spool = yield* Effect.promise(() =>
          env.absolutePath(NOTIFY_DIR, scoped.context)
        ).pipe(Effect.map((result) => (result.ok ? result.value : undefined)));
        if (spool === undefined) {
          return;
        }
        const onChange = (change: WatchChange) => {
          Queue.offerUnsafe(ticked, "error" in change ? "rewatch" : "drain");
        };

        const read = (info: FileInfo) =>
          Effect.promise(async () => {
            const opened = await env.openBinaryReader(
              info.path,
              { noFollow: true },
              scoped.context
            );
            if (!opened.ok) {
              return;
            }
            try {
              const chunk = await opened.value.read(
                0,
                maxBytes + 1,
                scoped.context
              );
              return chunk.ok ? chunk.value : undefined;
            } finally {
              try {
                await opened.value.close(BACKGROUND_CONTEXT);
              } catch {
                // The file was already read or is gone; nothing left to close over.
              }
            }
          });

        // Files are claimed at `burst` per sweep, then one more each `refillMs`: a finished pass resets
        // the budget, an unfinished one earns a single token.
        let tokens = burst;
        // One sweep of the spool, oldest first; `false` while files are left for a later pass.
        const pass = Effect.gen(function* () {
          const listed = yield* Effect.promise(() =>
            env.listDir(spool, scoped.context)
          );
          if (!listed.ok) {
            // No spool is the common case; anything else is retried on the next change.
            if (listed.error.code !== "not_found") {
              yield* Effect.logWarning(`Could not list ${spool}`, listed.error);
            }
            return true;
          }
          const pending = listed.value
            .filter(
              (info) => info.kind === "file" && !info.name.startsWith(".")
            )
            .toSorted(
              (a, b) => a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name)
            )
            .slice(0, sweepMax);
          for (const info of pending) {
            if (tokens === 0) {
              return false;
            }
            const bytes = yield* read(info);
            if (bytes === undefined) {
              continue;
            }
            tokens -= 1;
            const truncated = bytes.length > maxBytes;
            const text =
              decoder.decode(truncated ? bytes.subarray(0, maxBytes) : bytes) +
              (truncated ? `\n[notification cut at ${maxBytes} bytes]` : "");
            const submitted = yield* Effect.exit(
              Effect.promise(() =>
                submit(
                  formatNotification(info, text),
                  notifyRequestId(info.name, info.mtimeMs)
                )
              )
            );
            if (Exit.isFailure(submitted)) {
              yield* Effect.logWarning(
                `A sandbox notification from ${info.path} was refused`,
                submitted.cause
              );
              // The file stays: the next change or Seat retries it.
              return true;
            }
            // Claimed: it goes. A failed remove leaves a file the re-drain's dedup covers.
            yield* Effect.promise(() =>
              env.remove(info.path, { force: true }, scoped.context)
            );
          }
          // A full sweep may have left files; the pass after the wait picks them up.
          return pending.length < sweepMax;
        });

        const sweep = Effect.gen(function* () {
          for (;;) {
            if (yield* pass) {
              tokens = burst;
              return;
            }
            yield* Effect.sleep(refillMs);
            tokens = Math.min(burst, tokens + 1);
          }
        });

        for (let retry = 0; ;) {
          // Coverage first, then the sweep: nothing written during it is missed.
          const established = yield* Effect.promise(() =>
            env.watch(
              [{ path: spool, exclude: { hidden: true } }],
              onChange,
              scoped.context
            )
          );
          if (established.ok) {
            retry = 0;
            watcher = established.value;
            yield* sweep;
            // Ticks until the watcher dies; a stale "drain" just runs an empty pass.
            let alive = true;
            while (alive) {
              if ((yield* Queue.take(ticked)) === "drain") {
                yield* sweep;
              } else {
                const dead = watcher;
                watcher = undefined;
                if (dead !== undefined) {
                  yield* Effect.promise(() => dead.close(BACKGROUND_CONTEXT));
                }
                alive = false;
              }
            }
          } else {
            retry += 1;
            if (retry >= WATCH_TRIES) {
              yield* Effect.logWarning(
                `Could not watch ${spool} for sandbox notifications`,
                established.error
              );
              return;
            }
            yield* Effect.sleep(WATCH_BACKOFF_MS * 2 ** (retry - 1));
          }
        }
      })
    );
  });

/** Tells the agent how the machine reaches it; only where a Sandbox exists to write the spool. */
export const notifyExtension: Extension = defineExtension({
  name: "notify",
  sections: [
    section("notify", async (input, context) => {
      const doc = await input.read.snapshot(
        WorkspaceDoc,
        input.conversationId,
        context
      );
      if (doc?.level === undefined || doc.level === "none") {
        return;
      }
      return `Processes on your machine can leave you a message: run \`pi-notify "text"\` or drop a file in ${NOTIFY_DIR}/. It arrives as a \`<sandbox-notification at="…">\` message from the machine, not from the person; keep it short.`;
    }),
  ],
});
