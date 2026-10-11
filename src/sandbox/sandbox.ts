// Per-conversation sandboxes: the user picks a kind when a conversation starts, the sandbox is created first,
// and the conversation records it in a document that the harness environment function reads on every tool call.
import { defineDoc } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { Context, Schema } from "effect";
import type { Effect } from "effect";

/** `shell`: a Linux userland for bash and file tools. `desktop`: the same plus a graphical desktop. */
export type SandboxKind = "shell" | "desktop";

/** What the user picks when a conversation starts. */
export type SandboxChoice = SandboxKind | "none";

// A type, not an interface: it is stored in a pi-durable document, which must be a JSON type, and interfaces have
// no index signature.
// oxlint-disable-next-line typescript/consistent-type-definitions
export type SandboxInfo = {
  readonly kind: SandboxKind;
  /** Backend-specific identity, for example a container name; reconnects use it after a restart. */
  readonly id: string;
  /** A URL where a person can watch the desktop, when there is one. */
  readonly vncUrl?: string;
};

/** The sandbox a conversation runs in. Subagents get their owner's sandbox; a fork gets none until assigned. */
export const SandboxDoc = defineDoc<{ sandbox?: SandboxInfo }>({
  kind: "app.sandbox",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({}),
});

export class SandboxError extends Schema.TaggedError<SandboxError>()(
  "SandboxError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  }
) {}

export class Sandboxes extends Context.Service<
  Sandboxes,
  {
    /** Create and start a sandbox. `name` is unique per conversation. */
    create(
      kind: SandboxKind,
      name: string
    ): Effect.Effect<SandboxInfo, SandboxError>;
    /** Stop and delete a sandbox, ignoring one that is already gone. */
    remove(sandbox: SandboxInfo): Effect.Effect<void, SandboxError>;
    /** The execution environment of a sandbox, for the harness. Called for every tool call, so it is cheap. */
    env(sandbox: SandboxInfo): ExecutionEnv;
  }
>()("effect-pi/Sandboxes") {}
