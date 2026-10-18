// Per-conversation sandboxes: the user picks a kind when a conversation starts, the sandbox is created first,
// and the conversation records it in a document that the harness environment function reads on every tool call.
import type { Duplex } from "node:stream";

import { defineDoc } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { Context, Schema } from "effect";
import type { Effect, Scope, Stream } from "effect";

import type { SoftwareId } from "./software.ts";

/**
 * `shell`: a Linux userland for bash and file tools.
 * `desktop`: the same plus a graphical desktop.
 **/
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
  /** The ports this Sandbox publishes on the host loopback, dying with it. */
  readonly ports?: ExposedPort[];
};

// A type, not an interface: it is stored in a pi-durable document, which must be a JSON type.
// oxlint-disable-next-line typescript/consistent-type-definitions
export type ExposedPort = {
  /** The port inside the sandbox the agent named. */
  readonly port: number;
  readonly label?: string;
  /** Where the person's browser reaches it: http://127.0.0.1:<random host port>/. */
  readonly url: string;
};

/** The sandbox a conversation runs in. A fork gets none until assigned. */
export const SandboxDoc = defineDoc<{ sandbox?: SandboxInfo }>({
  kind: "app.sandbox",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({}),
});

/** Where a Workspace's files live, mounted as the sandbox's working directory. */
export type WorkspaceMount =
  | { readonly type: "volume"; readonly name: string }
  | { readonly type: "directory"; readonly path: string };

export class SandboxError extends Schema.TaggedError<SandboxError>()(
  "SandboxError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  }
) {}

/** An interactive PTY in a Sandbox: the console's shell tab is one of these. */
export interface SandboxShell {
  /** Terminal bytes the PTY produces, ending when the shell exits. */
  readonly output: Stream.Stream<Uint8Array, SandboxError>;
  /** Bytes to the shell's stdin. */
  readonly write: (bytes: Uint8Array) => Effect.Effect<void, SandboxError>;
  /** Change the PTY's window size. */
  readonly resize: (
    columns: number,
    rows: number
  ) => Effect.Effect<void, SandboxError>;
}

export class Sandboxes extends Context.Service<
  Sandboxes,
  {
    /**
     * Create and start a sandbox over a Workspace's files, with `software` installed on top of the Level's image.
     * `name` is unique per sandbox.
     */
    create(
      kind: SandboxKind,
      name: string,
      files: WorkspaceMount,
      software: readonly SoftwareId[]
    ): Effect.Effect<SandboxInfo, SandboxError>;
    /** Stop and delete a sandbox, ignoring one that is already gone; the Workspace's files stay. */
    remove(sandbox: SandboxInfo): Effect.Effect<void, SandboxError>;
    /** The execution environment of a sandbox, for the harness. Called for every tool call, so it is cheap. */
    env(sandbox: SandboxInfo): ExecutionEnv;
    /**
     * An interactive shell in a Sandbox, killed when the scope closes. A backend without PTYs still answers: the
     * shell then works line-by-line, without job control.
     */
    shell(
      sandbox: SandboxInfo,
      options: { readonly columns: number; readonly rows: number }
    ): Effect.Effect<SandboxShell, SandboxError, Scope.Scope>;
    /**
     * A raw bidirectional byte channel to 127.0.0.1:`port` inside the sandbox; one per connection, and the
     * caller owns and destroys it. Fails when the sandbox is gone — a port with nothing listening may still
     * "connect" when the backend's channel opens eagerly, e.g. Docker's forwarder dies after connect.
     */
    connect(
      sandbox: SandboxInfo,
      port: number
    ): Effect.Effect<Duplex, SandboxError>;
  }
>()("effect-pi/Sandboxes") {}
