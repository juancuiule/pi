// Sandboxes as local Docker containers. Each container gets the pi-env daemon, and the harness reaches it through
// `docker exec -i`, so pi's file and shell tools run inside the container.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  Connection,
  packagedDaemon,
  RemoteExecutionEnv,
} from "@earendil-works/pi-env";
import { Effect, Layer, Schedule } from "effect";

import { Sandboxes, SandboxError } from "./sandbox.ts";
import type { SandboxInfo, SandboxKind, WorkspaceMount } from "./sandbox.ts";

const execFileAsync = promisify(execFile);

export const DAEMON_PATH = "/usr/local/bin/pi-env";
export const WORKSPACE = "/workspace";
export const DISPLAY = ":99";
const NOVNC_PORT = "6080/tcp";

export const defaultImages: Record<SandboxKind, string> = {
  shell: "effect-pi/sandbox-shell",
  desktop: "effect-pi/sandbox-desktop",
};

export const docker = (args: readonly string[]) =>
  Effect.tryPromise({
    try: async () => {
      const { stdout } = await execFileAsync("docker", args);
      return stdout.trim();
    },
    catch: (cause) =>
      new SandboxError({ message: `docker ${args[0]} failed`, cause }),
  });

/** True when the Docker daemon answers; for skipping tests and failing fast with a clear message. */
export const dockerAvailable = async (): Promise<boolean> => {
  try {
    await execFileAsync("docker", ["info", "--format", "{{.ServerVersion}}"]);
    return true;
  } catch {
    return false;
  }
};

/** Linux containers share the host's architecture under Docker Desktop and on Linux. */
const daemonBinary = () =>
  packagedDaemon({
    platform: "linux",
    arch: process.arch === "arm64" ? "arm64" : "x64",
  });

const waitForDesktop = (name: string) =>
  docker(["exec", name, "test", "-f", "/tmp/desktop-ready"]).pipe(
    // Up to 30 seconds for Xvfb, XFCE and noVNC to come up
    Effect.retry({ schedule: Schedule.spaced("250 millis"), times: 120 }),
    Effect.mapError(
      (cause) =>
        new SandboxError({ message: `Desktop ${name} did not start`, cause })
    )
  );

const vncUrl = (name: string) =>
  docker(["port", name, NOVNC_PORT]).pipe(
    // `docker port` prints one line per address, e.g. "127.0.0.1:55012"
    Effect.map((ports) => {
      const [address] = ports.split("\n");
      return `http://${address}/vnc.html?autoconnect=true&resize=scale`;
    })
  );

export const layer = (
  options: { readonly images?: Partial<Record<SandboxKind, string>> } = {}
) =>
  Layer.effect(
    Sandboxes,
    Effect.gen(function* () {
      const images = { ...defaultImages, ...options.images };
      // One daemon connection per container, created on first use; it reconnects by itself after a lost link.
      const connections = new Map<string, Connection>();
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          for (const connection of connections.values()) {
            connection.close();
          }
          connections.clear();
        })
      );

      const connectionFor = (name: string) => {
        let connection = connections.get(name);
        if (connection === undefined) {
          connection = new Connection({
            command: ["docker", "exec", "-i", name, DAEMON_PATH],
          });
          connections.set(name, connection);
        }
        return connection;
      };

      const create = Effect.fn("DockerSandboxes.create")(function* (
        kind: SandboxKind,
        name: string,
        files: WorkspaceMount
      ) {
        const publish =
          kind === "desktop" ? ["-p", `127.0.0.1::${NOVNC_PORT}`] : [];
        const mount =
          files.type === "volume"
            ? `type=volume,src=${files.name},dst=${WORKSPACE}`
            : `type=bind,src=${files.path},dst=${WORKSPACE}`;
        yield* docker([
          "run",
          "--detach",
          "--name",
          name,
          "--label",
          `effect-pi.sandbox=${kind}`,
          "--mount",
          mount,
          ...publish,
          images[kind],
        ]);
        const started = Effect.gen(function* () {
          yield* docker(["cp", daemonBinary(), `${name}:${DAEMON_PATH}`]);
          yield* docker(["exec", name, "chmod", "+x", DAEMON_PATH]);
          if (kind === "shell") {
            return { kind, id: name } satisfies SandboxInfo;
          }
          yield* waitForDesktop(name);
          return {
            kind,
            id: name,
            vncUrl: yield* vncUrl(name),
          } satisfies SandboxInfo;
        });
        // A container that failed to finish starting is removed instead of leaking.
        return yield* started.pipe(
          Effect.onError(() => Effect.ignore(docker(["rm", "--force", name])))
        );
      });

      const remove = Effect.fn("DockerSandboxes.remove")(function* (
        sandbox: SandboxInfo
      ) {
        connections.get(sandbox.id)?.close();
        connections.delete(sandbox.id);
        yield* docker(["rm", "--force", sandbox.id]);
      });

      const env = (sandbox: SandboxInfo) =>
        new RemoteExecutionEnv({
          connection: connectionFor(sandbox.id),
          id: `docker:${sandbox.id}`,
          cwd: WORKSPACE,
          ...(sandbox.kind === "desktop" ? { shellEnv: { DISPLAY } } : {}),
        });

      return Sandboxes.of({ create, remove, env });
    })
  );
