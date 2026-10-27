// Sandboxes as local Docker containers. Each container gets the pi-env daemon, and the harness reaches it through
// `docker exec -i`, so pi's file and shell tools run inside the container. Interactive shells are execs too, but
// over the Engine API on the Docker socket: the CLI attaches fine, yet only the API can resize the exec's PTY.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import http from "node:http";
import type { Socket } from "node:net";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  Connection,
  packagedDaemon,
  RemoteExecutionEnv,
} from "@earendil-works/pi-env";
import { NodeStream } from "@effect/platform-node";
import { Effect, Layer, Schedule, Semaphore } from "effect";

import { Sandboxes, SandboxError } from "./sandbox.ts";
import type {
  SandboxInfo,
  SandboxKind,
  SandboxShell,
  WorkspaceMount,
} from "./sandbox.ts";
import { dockerfile, normalize, SOFTWARE } from "./software.ts";
import type { SoftwareId } from "./software.ts";

const execFileAsync = promisify(execFile);

export const DAEMON_PATH = "/usr/local/bin/pi-env";
/**
 * The Shell tab's `open` command, copied in at start like the daemon: cached software images get it
 * without a rebuild, and desktop containers (FROM the shell image) never do, since `open` means
 * something else in XFCE.
 */
export const OPEN_PATH = "/usr/local/bin/open";
const OPEN_SCRIPT = fileURLToPath(
  new URL("../../docker/sandbox/open", import.meta.url)
);
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

const dockerWithInput = (args: readonly string[], input: string) =>
  Effect.tryPromise({
    try: async (signal) => {
      // A build's progress goes to stderr, and can be long.
      const running = execFileAsync("docker", args, {
        signal,
        maxBuffer: 64 * 1024 * 1024,
      });
      running.child.stdin?.end(input);
      const { stdout } = await running;
      return stdout.trim();
    },
    catch: (cause) =>
      new SandboxError({ message: `docker ${args[0]} failed`, cause }),
  });

// The `docker` CLI's socket: `unix://` in DOCKER_HOST, else the default path. Other DOCKER_HOST schemes (tcp,
// ssh) are unsupported for shells: the CLI could reach them, the Engine calls below could not.
const socketPath = () => {
  const host = process.env.DOCKER_HOST ?? "";
  return host.startsWith("unix://")
    ? host.slice("unix://".length)
    : "/var/run/docker.sock";
};

interface EngineReply {
  readonly status: number;
  readonly body: string;
}

/** Where an interactive shell records its container PID, so teardown can reach it. */
const PID_FILE = "/tmp/.pi-shell-pid";

const engine = (
  path: string,
  options: {
    readonly body?: object;
    readonly upgrade?: boolean;
    readonly method?: "GET" | "POST";
  } = {}
) =>
  Effect.callback<EngineReply | { readonly socket: Socket }, SandboxError>(
    (resume) => {
      const payload =
        options.body === undefined ? "" : JSON.stringify(options.body);
      const request = http.request({
        socketPath: socketPath(),
        path,
        method: options.method ?? "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
          ...(options.upgrade === true
            ? { connection: "Upgrade", upgrade: "tcp" }
            : {}),
        },
      });
      const fail = (message: string) => (cause: Error) =>
        resume(
          Effect.fail(
            new SandboxError({ message: `${message}: ${cause.message}`, cause })
          )
        );
      request.on("upgrade", (_response, socket, _head) =>
        resume(Effect.succeed({ socket }))
      );
      request.on("response", (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resume(
            Effect.succeed({
              status: response.statusCode ?? 0,
              body: Buffer.concat(chunks).toString("utf-8"),
            })
          )
        );
      });
      request.on("error", fail(`docker engine ${path} failed`));
      request.end(payload);
    }
  );

/** A POST that reads a body, failing on a non-2xx status. */
const enginePost = (path: string, body?: object) =>
  engine(path, body === undefined ? {} : { body }).pipe(
    Effect.flatMap((reply) => {
      if ("socket" in reply) {
        return new SandboxError({
          message: `docker engine ${path} upgraded`,
        });
      }
      if (reply.status < 200 || reply.status >= 300) {
        return new SandboxError({
          message: `docker engine ${path} answered ${reply.status}: ${reply.body}`,
        });
      }
      return Effect.succeed(reply);
    })
  );

/** Whether an exec's process is still running; a daemon error reads as gone. */
const execRunning = (execId: string) =>
  engine(`/exec/${execId}/json`, { method: "GET" }).pipe(
    Effect.flatMap((reply) =>
      "socket" in reply
        ? Effect.succeed(false)
        : Effect.succeed(
            (JSON.parse(reply.body) as { Running?: boolean }).Running === true
          )
    ),
    Effect.orElseSucceed(() => false)
  );

/** Whether the exec's process exited within ~1.5 seconds. */
const execExited = (execId: string) =>
  Effect.gen(function* () {
    for (let i = 0; i < 15; i += 1) {
      if (!(yield* execRunning(execId))) {
        return true;
      }
      yield* Effect.sleep("100 millis");
    }
    return !(yield* execRunning(execId));
  });

/** A PTY exec's hijacked stream. The client can detach without the exec'd process noticing. */
const engineAttach = (execId: string) =>
  engine(`/exec/${execId}/start`, {
    body: { Detach: false, Tty: true },
    upgrade: true,
  }).pipe(
    Effect.flatMap((reply) =>
      "socket" in reply
        ? Effect.succeed(reply.socket)
        : new SandboxError({
            message: `docker exec ${execId} answered ${reply.status}: ${reply.body}`,
          })
    )
  );

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
      return `ws://${address}/websockify`;
    })
  );

export interface Limits {
  /** Memory with swap included, so a Sandbox cannot push the host into swap. */
  readonly memoryMb?: number | undefined;
  readonly cpus?: number | undefined;
}

const limitArgs = ({ memoryMb, cpus }: Limits = {}) => [
  ...(memoryMb === undefined
    ? []
    : [`--memory=${memoryMb}m`, `--memory-swap=${memoryMb}m`]),
  ...(cpus === undefined ? [] : [`--cpus=${cpus}`]),
];

export const layer = (
  options: {
    readonly images?: Partial<Record<SandboxKind, string>>;
    readonly limits?: Limits;
  } = {}
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

      // One build at a time, so two Seats asking for the same image build it once.
      const building = yield* Semaphore.make(1);

      // The tag hashes the base image's id, so a rebuilt base gets new images instead of stale ones.
      const imageFor = Effect.fnUntraced(function* (
        kind: SandboxKind,
        software: readonly SoftwareId[]
      ) {
        const base = images[kind];
        const ids = normalize(software);
        if (ids.length === 0) {
          return base;
        }
        return yield* building.withPermit(
          Effect.gen(function* () {
            const baseId = yield* docker([
              "image",
              "inspect",
              "--format",
              "{{.Id}}",
              base,
            ]);
            const text = dockerfile(base, ids);
            const hash = createHash("sha256")
              .update(baseId)
              .update(text)
              .digest("hex")
              .slice(0, 12);
            const tag = `effect-pi/sandbox-${kind}:sw-${hash}`;
            const built = yield* docker(["image", "inspect", tag]).pipe(
              Effect.as(true),
              Effect.catchTag("SandboxError", () => Effect.succeed(false))
            );
            if (!built) {
              yield* dockerWithInput(
                [
                  "build",
                  "--label",
                  `effect-pi.software=${ids.join(",")}`,
                  "--tag",
                  tag,
                  "-",
                ],
                text
              ).pipe(
                Effect.mapError(
                  (error) =>
                    new SandboxError({
                      message: `Could not build a ${kind} image with ${ids.map((id) => SOFTWARE[id].label).join(", ")}`,
                      cause: error.cause,
                    })
                )
              );
            }
            return tag;
          })
        );
      });

      const create = Effect.fn("DockerSandboxes.create")(function* (
        kind: SandboxKind,
        name: string,
        files: WorkspaceMount,
        software: readonly SoftwareId[]
      ) {
        const image = yield* imageFor(kind, software);
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
          ...limitArgs(options.limits),
          image,
        ]);
        const started = Effect.gen(function* () {
          yield* docker(["cp", daemonBinary(), `${name}:${DAEMON_PATH}`]);
          yield* docker(["exec", name, "chmod", "+x", DAEMON_PATH]);
          if (kind === "shell") {
            // `docker cp` keeps the script's committed 755 mode.
            yield* docker(["cp", OPEN_SCRIPT, `${name}:${OPEN_PATH}`]);
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

      const shell = Effect.fn("DockerSandboxes.shell")(function* (
        sandbox: SandboxInfo,
        size: { readonly columns: number; readonly rows: number }
      ) {
        const reply = yield* enginePost(`/containers/${sandbox.id}/exec`, {
          AttachStdin: true,
          AttachStdout: true,
          AttachStderr: true,
          Tty: true,
          Env: ["TERM=xterm-256color", "COLORTERM=truecolor"],
          WorkingDir: WORKSPACE,
          // `exec` keeps the PID, so the file records the login shell's container PID.
          Cmd: ["/bin/bash", "-c", `echo $$ > ${PID_FILE}; exec /bin/bash -l`],
        });
        const execId = (JSON.parse(reply.body) as { Id: string }).Id;

        const socket = yield* Effect.acquireRelease(
          engineAttach(execId),
          (stream) =>
            Effect.gen(function* () {
              // An idle shell exits on `exit`, ending the exec and its stream.
              yield* Effect.sync(() => {
                if (!stream.destroyed) {
                  stream.write("exit\n");
                }
              });
              const exited = yield* execExited(execId);
              if (!exited) {
                // A foreground job still holds the prompt: SIGHUP the shell's
                // process group from inside the container, since closing the
                // hijacked stream alone does not reach it.
                yield* Effect.ignore(
                  Effect.gen(function* () {
                    const killer = yield* enginePost(
                      `/containers/${sandbox.id}/exec`,
                      {
                        AttachStdin: false,
                        AttachStdout: false,
                        AttachStderr: false,
                        Cmd: [
                          "/bin/sh",
                          "-c",
                          `p=$(cat ${PID_FILE} 2>/dev/null) && (kill -HUP -"$p" 2>/dev/null || kill -HUP "$p" 2>/dev/null); exit 0`,
                        ],
                      }
                    );
                    const id = (JSON.parse(killer.body) as { Id: string }).Id;
                    yield* enginePost(`/exec/${id}/start`, { Detach: true });
                  })
                );
              }
              yield* Effect.sync(() => stream.destroy());
            })
        );
        socket.setNoDelay(true);

        const resize = (columns: number, rows: number) =>
          enginePost(`/exec/${execId}/resize?h=${rows}&w=${columns}`).pipe(
            Effect.asVoid
          );
        // An exec's PTY starts 0x0: with no client terminal, the daemon has no size to copy.
        yield* resize(size.columns, size.rows);

        const output = NodeStream.fromReadable<Uint8Array, SandboxError>({
          evaluate: () => socket,
          onError: (cause) =>
            new SandboxError({
              message: "the sandbox shell's stream failed",
              cause,
            }),
        });

        const writeTo = promisify(socket.write).bind(socket);
        const write = (bytes: Uint8Array) =>
          socket.destroyed
            ? new SandboxError({ message: "the sandbox shell is closed" })
            : Effect.promise(() => writeTo(bytes)).pipe(
                Effect.mapError(
                  (cause) =>
                    new SandboxError({
                      message: "writing to the sandbox shell failed",
                      cause,
                    })
                )
              );

        return { output, write, resize } satisfies SandboxShell;
      });

      return Sandboxes.of({ create, remove, env, shell });
    })
  );
