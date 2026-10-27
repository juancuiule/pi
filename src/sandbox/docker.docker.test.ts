// Integration tests against real Docker containers. Run with `pnpm test:docker` after `pnpm sandbox:build`.
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
} from "@earendil-works/pi-ai/providers/faux";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { Effect, Fiber, Layer, Schedule, Stream } from "effect";
import { afterAll, describe, expect, it } from "vitest";

import { Agents } from "../agents/agents.ts";
import { Artifacts } from "../artifacts/artifacts.ts";
import { TrustedDomains } from "../artifacts/domains.ts";
import { Attachments } from "../attachments/attachments.ts";
import { Capacity } from "../capacity.ts";
import { saveScreenshotsTo } from "../screenshots.ts";
import type { SaveScreenshot } from "../screenshots.ts";
import { Skills, SkillSource } from "../skills/skills.ts";
import { ask, callTool, echoToolResult } from "../testing/faux.ts";
import * as DockerVolumes from "../workspaces/docker-volume.ts";
import { Workspaces } from "../workspaces/workspaces.ts";
import * as DockerSandboxes from "./docker.ts";
import type { WorkspaceOpen } from "./open-sequence.ts";
import { Sandboxes } from "./sandbox.ts";
import type { SandboxShell } from "./sandbox.ts";
import { shellSession } from "./shell-session.ts";

const containerExists = (name: string) =>
  execFileSync("docker", ["ps", "-a", "--filter", `name=^${name}$`, "-q"], {
    encoding: "utf-8",
  }).trim() !== "";

// Volumes these tests create carry this label, so they are removed afterwards without touching anyone else's.
const TEST_LABEL = "effect-pi.test";
const testWorkspaces = () => DockerVolumes.workspaces({ labels: [TEST_LABEL] });

const volumeExists = (name: string) =>
  execFileSync("docker", ["volume", "ls", "--filter", `name=^${name}$`, "-q"], {
    encoding: "utf-8",
  }).trim() !== "";

const imageOf = (container: string) =>
  execFileSync(
    "docker",
    ["inspect", "--format", "{{.Config.Image}}", container],
    {
      encoding: "utf-8",
    }
  ).trim();

const createdAt = (image: string) =>
  execFileSync(
    "docker",
    ["image", "inspect", "--format", "{{.Created}}", image],
    {
      encoding: "utf-8",
    }
  ).trim();

/** Polls `f` until true, giving up after ~10 seconds. */
const until = (f: () => boolean) =>
  Effect.suspend(() => (f() ? Effect.succeed(true) : Effect.fail(false))).pipe(
    Effect.retry({ schedule: Schedule.spaced("50 millis"), times: 200 }),
    Effect.orElseSucceed(() => false)
  );

/** Run `command` in a Sandbox, collecting its output. */
const run = (env: ExecutionEnv, command: string) =>
  Effect.promise(async () => {
    let text = "";
    const result = await env.exec(
      command,
      { onOutput: (chunk) => (text += chunk) },
      BACKGROUND_CONTEXT
    );
    return { ok: result.ok, text };
  });

const dockerAgents = (
  responses: FauxResponseStep[],
  saveScreenshot?: SaveScreenshot
) => {
  const models = createModels();
  const faux = fauxProvider();
  models.setProvider(faux.provider);
  faux.setResponses(responses);
  return Agents.layer({
    models,
    model: { provider: "faux", modelId: "faux-1" },
    ...(saveScreenshot === undefined ? {} : { saveScreenshot }),
  }).pipe(
    Layer.provide(testWorkspaces()),
    Layer.provide(Skills.none),
    Layer.provide(Attachments.temporary()),
    Layer.provide(Artifacts.temporary()),
    Layer.provide(TrustedDomains.temporary()),
    Layer.provide(Capacity.layer({ seats: 2, shells: 1, desktops: 1 }))
  );
};

describe.skipIf(!(await DockerSandboxes.dockerAvailable()))(
  "Docker sandboxes",
  { timeout: 120_000 },
  () => {
    afterAll(() => {
      const volumes = execFileSync(
        "docker",
        ["volume", "ls", "--filter", `label=${TEST_LABEL}`, "-q"],
        { encoding: "utf-8" }
      )
        .split("\n")
        .filter((name) => name !== "");
      if (volumes.length > 0) {
        execFileSync("docker", ["volume", "rm", "--force", ...volumes]);
      }
    });

    it("keeps a Workspace's files across its Sandboxes, of any Level, until discarded", async () => {
      const { first, second, storage, names } = await Effect.runPromise(
        Effect.gen(function* () {
          const workspaces = yield* Workspaces;
          const shell = yield* Effect.scoped(
            Effect.gen(function* () {
              const created = yield* workspaces.sandbox({ level: "shell" });
              const output = yield* run(
                workspaces.env(created.sandbox),
                "pwd && echo kept > notes.txt && git --version | cut -d' ' -f1 && test -x /usr/local/bin/open && echo open"
              );
              return { ...created, output };
            })
          );
          // The shell container is gone; a desktop over the same storage still has the file.
          const desktop = yield* Effect.scoped(
            Effect.gen(function* () {
              const created = yield* workspaces.sandbox({
                level: "desktop",
                storage: shell.storage,
              });
              const output = yield* run(
                workspaces.env(created.sandbox),
                "cat notes.txt && test ! -e /usr/local/bin/open && echo no-open"
              );
              return { ...created, output };
            })
          );
          yield* workspaces.discard(shell.storage);
          return {
            first: shell.output,
            second: desktop.output,
            storage: shell.storage,
            names: [shell.sandbox.id, desktop.sandbox.id],
          };
        }).pipe(Effect.provide(testWorkspaces()))
      );

      expect(first).toStrictEqual({
        ok: true,
        text: "/workspace\ngit\nopen\n",
      });
      expect(second).toStrictEqual({ ok: true, text: "kept\nno-open\n" });
      for (const name of names) {
        expect(containerExists(name)).toBeFalsy();
      }
      expect(volumeExists(storage.id)).toBeFalsy();
    });

    it("installs Software in an image built once, and reused by the next Sandbox", async () => {
      const runs = await Effect.runPromise(
        Effect.gen(function* () {
          const workspaces = yield* Workspaces;
          const once = Effect.scoped(
            Effect.gen(function* () {
              const created = yield* workspaces.sandbox({
                level: "shell",
                software: ["uv"],
              });
              const output = yield* run(
                workspaces.env(created.sandbox),
                "uv --version && test -x /usr/local/bin/open"
              );
              const image = imageOf(created.sandbox.id);
              return {
                storage: created.storage,
                found: { ok: output.ok, image, built: createdAt(image) },
              };
            })
          ).pipe(
            Effect.tap(({ storage }) => workspaces.discard(storage)),
            Effect.map(({ found }) => found)
          );
          return [yield* once, yield* once];
        }).pipe(Effect.provide(testWorkspaces()))
      );

      const [first, second] = runs;
      execFileSync("docker", ["image", "rm", first?.image ?? ""]);
      expect(first?.ok).toBeTruthy();
      expect(first?.image).toMatch(
        /^effect-pi\/sandbox-shell:sw-[0-9a-f]{12}$/u
      );
      expect(second).toStrictEqual(first);
    }, 600_000);

    it("replaces a skill's folder in a container from staged files", async () => {
      const listing = await Effect.runPromise(
        Effect.gen(function* () {
          const workspaces = yield* Workspaces;
          const skills = yield* Skills;
          const { skills: available } = yield* skills.catalog;
          const skill = available.find((each) => each.name === "convert");
          if (skill === undefined) {
            return yield* Effect.die(new Error("no convert skill"));
          }
          return yield* Effect.scoped(
            Effect.gen(function* () {
              const { sandbox } = yield* workspaces.sandbox({ level: "shell" });
              const env = workspaces.env(sandbox);
              yield* run(
                env,
                "mkdir -p .skills/convert && echo old > .skills/convert/stale.txt"
              );
              yield* skills.replace(env, skill, BACKGROUND_CONTEXT);
              return yield* run(env, "ls -A .skills .skills/convert");
            })
          );
        }).pipe(
          Effect.provide(
            Layer.merge(
              testWorkspaces(),
              Skills.layer.pipe(
                Layer.provide(
                  SkillSource.memory({
                    "convert/SKILL.md":
                      "---\nname: convert\ndescription: Convert units.\n---\nDo it.\n",
                  })
                )
              )
            )
          )
        )
      );

      expect(listing.ok).toBeTruthy();
      // The stale file and the staging folder are gone; the skill's files are there.
      expect(listing.text).not.toContain("stale.txt");
      expect(listing.text).not.toContain("staging");
      expect(listing.text).toContain("SKILL.md");
    });

    it("gives the model a PNG screenshot of the desktop and keeps it on the host", async () => {
      const root = mkdtempSync(path.join(tmpdir(), "effect-pi-screenshots-"));
      const layer = dockerAgents(
        [
          callTool("desktop_screenshot", {}),
          (request) => {
            const result = request.messages.findLast(
              (m) => m.role === "toolResult"
            );
            const image = result?.content.find((c) => c.type === "image");
            const header =
              image === undefined
                ? ""
                : Buffer.from(image.data, "base64").subarray(1, 4).toString();
            return fauxAssistantMessage([fauxText(header)]);
          },
        ],
        saveScreenshotsTo(root)
      );

      const answer = await Effect.runPromise(
        ask("Look at the screen.", "desktop").pipe(Effect.provide(layer))
      );

      expect(answer).toBe("PNG");
      // One folder for the sandbox, holding the one screenshot.
      const [sandboxDir] = readdirSync(root);
      const saved = readFileSync(path.join(root, sandboxDir ?? "", "001.png"));
      expect(saved.subarray(1, 4).toString()).toBe("PNG");
      rmSync(root, { recursive: true, force: true });
    });

    it("moves the mouse where the model clicks", async () => {
      const layer = dockerAgents([
        callTool("desktop_click", { x: 640, y: 400 }),
        callTool("bash", { command: "xdotool getmouselocation --shell" }),
        echoToolResult,
      ]);

      const answer = await Effect.runPromise(
        ask("Click the middle of the screen.", "desktop").pipe(
          Effect.provide(layer)
        )
      );

      expect(answer).toContain("X=640\nY=400");
    });

    it("announces the Shell tab's `open` from the PTY, live only, and refuses what it cannot open", async () => {
      const dir = mkdtempSync(path.join(tmpdir(), "effect-pi-open-"));
      mkdirSync(path.join(dir, "notes"));
      mkdirSync(path.join(dir, "src"));
      writeFileSync(path.join(dir, "notes", "a.md"), "# A\n");
      writeFileSync(path.join(dir, "src", "x.ts"), "x\n");
      writeFileSync(path.join(dir, "odd;name .md"), "odd\n");
      symlinkSync("/etc", path.join(dir, "out"));
      const name = `effect-pi-open-${crypto.randomUUID().slice(0, 8)}`;
      const utf8 = new TextDecoder();
      const ascii = new TextEncoder();

      const observed = await Effect.runPromise(
        Effect.gen(function* () {
          const sandboxes = yield* Sandboxes;
          const sandbox = yield* sandboxes.create(
            "shell",
            name,
            { type: "directory", path: dir },
            []
          );
          yield* Effect.addFinalizer(() =>
            Effect.ignore(sandboxes.remove(sandbox))
          );
          const session = yield* shellSession(
            yield* sandboxes.shell(sandbox, { columns: 200, rows: 40 })
          );
          let output = "";
          const opens: WorkspaceOpen[] = [];
          yield* Stream.runForEach(session.output, (chunk) =>
            Effect.sync(() => {
              output += utf8.decode(chunk, { stream: true });
            })
          ).pipe(Effect.forkScoped);
          yield* Stream.runForEach(session.opens, (open) =>
            Effect.sync(() => {
              opens.push(open);
            })
          ).pipe(Effect.forkScoped);

          let step = 0;
          /**
           * Runs one command line: its exit status and the lines it printed between the echoed command
           * and the status, without escape sequences (bash's own, and `open`'s, which `opens` reports).
           */
          const type = (line: string) =>
            Effect.gen(function* () {
              step += 1;
              const from = output.length;
              const status = `echo END-${step}:$?`;
              const end = new RegExp(`END-${step}:(\\d+)`, "u");
              yield* session.write(ascii.encode(`${line}; ${status}\n`));
              yield* until(() => end.test(output.slice(from)));
              const lines = output
                .slice(from)
                .replaceAll(
                  // oxlint-disable-next-line no-control-regex -- terminal escapes are control characters by design
                  /\u001B\][^\u0007]*\u0007|\u001B\[[0-9;?]*[A-Za-z]|\r/gu,
                  ""
                )
                .split("\n");
              const endAt = lines.findIndex((printed) => end.test(printed));
              // The first command is echoed twice: by the PTY as typeahead, then by readline.
              const echoAt = lines
                .slice(0, endAt)
                .findLastIndex((printed) => printed.includes(status));
              return {
                status: Number(end.exec(lines[endAt] ?? "")?.[1]),
                said: lines.slice(echoAt + 1, endAt).join("\n"),
              };
            });

          const results = {
            file: yield* type("cd src && open ../notes/a.md"),
            here: yield* type("open ."),
            root: yield* type("cd .. && open ."),
            odd: yield* type("open 'odd;name .md'"),
            missing: yield* type("open nope"),
            outside: yield* type("open /etc/hostname"),
            link: yield* type("open out"),
            none: yield* type("open"),
            two: yield* type("open a b"),
            captured: yield* type('x=$(open notes/a.md); echo "[$x]"'),
          };
          yield* until(() => opens.length >= 5);
          yield* Effect.sleep("300 millis");

          const agent = yield* run(
            sandboxes.env(sandbox),
            'cd /workspace && open notes/a.md; echo "status=$?"'
          );

          let replayed = "";
          const late: WorkspaceOpen[] = [];
          yield* Stream.runForEach(session.output, (chunk) =>
            Effect.sync(() => {
              replayed += utf8.decode(chunk, { stream: true });
            })
          ).pipe(Effect.forkScoped);
          yield* Stream.runForEach(session.opens, (open) =>
            Effect.sync(() => {
              late.push(open);
            })
          ).pipe(Effect.forkScoped);
          const replay = yield* until(() =>
            replayed.includes("\u001B]7701;open;")
          );
          yield* Effect.sleep("500 millis");

          return {
            results,
            opens: [...opens],
            agent: agent.text,
            replay,
            late,
          };
        }).pipe(Effect.provide(DockerSandboxes.layer()), Effect.scoped)
      );
      rmSync(dir, { recursive: true, force: true });

      expect(observed).toStrictEqual({
        results: {
          file: { status: 0, said: "" },
          here: { status: 0, said: "" },
          root: { status: 0, said: "" },
          odd: { status: 0, said: "" },
          missing: { status: 1, said: "open: no such file or directory: nope" },
          outside: {
            status: 1,
            said: "open: not in the workspace: /etc/hostname",
          },
          link: { status: 1, said: "open: not in the workspace: out" },
          none: { status: 2, said: "usage: open <path>" },
          two: { status: 2, said: "usage: open <path>" },
          captured: { status: 0, said: "[]" },
        },
        opens: [
          { path: "/workspace/notes/a.md", kind: "file" },
          { path: "/workspace/src", kind: "directory" },
          { path: "/workspace", kind: "directory" },
          { path: "/workspace/odd;name .md", kind: "file" },
          { path: "/workspace/notes/a.md", kind: "file" },
        ],
        agent: "open: needs the console's Shell tab\nstatus=1\n",
        replay: true,
        late: [],
      });
    });

    it("holds a Sandbox to its memory and CPU limits", async () => {
      const dir = mkdtempSync(path.join(tmpdir(), "effect-pi-limits-"));
      const name = `effect-pi-limits-${crypto.randomUUID().slice(0, 8)}`;

      const observed = await Effect.runPromise(
        Effect.gen(function* () {
          const sandboxes = yield* Sandboxes;
          const sandbox = yield* sandboxes.create(
            "shell",
            name,
            { type: "directory", path: dir },
            []
          );
          yield* Effect.addFinalizer(() =>
            Effect.ignore(sandboxes.remove(sandbox))
          );
          const allocate = (mb: number) => {
            try {
              execFileSync(
                "docker",
                [
                  "exec",
                  name,
                  "python3",
                  "-c",
                  `bytearray(${mb} * 1024 * 1024)`,
                ],
                { stdio: "ignore" }
              );
              return "ok";
            } catch {
              return "killed";
            }
          };
          return {
            small: allocate(64),
            large: allocate(400),
            cpus: execFileSync(
              "docker",
              ["inspect", "--format", "{{.HostConfig.NanoCpus}}", name],
              { encoding: "utf-8" }
            ).trim(),
          };
        }).pipe(
          Effect.provide(
            DockerSandboxes.layer({ limits: { memoryMb: 256, cpus: 0.5 } })
          ),
          Effect.scoped
        )
      );
      rmSync(dir, { recursive: true, force: true });

      expect(observed).toStrictEqual({
        small: "ok",
        large: "killed",
        cpus: "500000000",
      });
    });

    it("runs an interactive PTY with resize and Ctrl-C, killed when its scope closes", async () => {
      const dir = mkdtempSync(path.join(tmpdir(), "effect-pi-shell-"));
      const name = `effect-pi-shell-${crypto.randomUUID().slice(0, 8)}`;
      const utf8 = new TextDecoder();
      const ascii = new TextEncoder();

      const observed = await Effect.runPromise(
        Effect.gen(function* () {
          const sandboxes = yield* Sandboxes;
          const sandbox = yield* sandboxes.create(
            "shell",
            name,
            {
              type: "directory",
              path: dir,
            },
            []
          );
          yield* Effect.addFinalizer(() =>
            Effect.ignore(sandboxes.remove(sandbox))
          );

          let output = "";
          const seen = (text: string | RegExp) =>
            typeof text === "string"
              ? output.includes(text)
              : text.test(output);
          const collect = (shell: SandboxShell) =>
            Stream.runForEach(shell.output, (chunk) =>
              Effect.sync(() => {
                output += utf8.decode(chunk, { stream: true });
              })
            ).pipe(Effect.forkDetach);

          const first = yield* Effect.scoped(
            Effect.gen(function* () {
              const shell = yield* sandboxes.shell(sandbox, {
                columns: 100,
                rows: 40,
              });
              const reader = yield* collect(shell);
              yield* shell.write(ascii.encode("echo MARKER\n"));
              const echoed = yield* until(() => seen("MARKER"));
              yield* shell.write(ascii.encode("stty size\n"));
              const sized = yield* until(() => seen("40 100"));
              yield* shell.resize(90, 30);
              yield* shell.write(ascii.encode("stty size\n"));
              const resized = yield* until(() => seen("30 90"));
              // Ctrl-C reaches the foreground job as SIGINT, not literal input.
              yield* shell.write(ascii.encode("sleep 300\n"));
              yield* Effect.sleep("300 millis");
              yield* shell.write(Uint8Array.of(3));
              yield* shell.write(ascii.encode("echo INTACT\n"));
              const intact = yield* until(() => seen("INTACT"));
              // `exit` ends the exec: the PTY's stream ends and the collector joins.
              yield* shell.write(ascii.encode("exit\n"));
              const exited = yield* Fiber.join(reader).pipe(
                Effect.timeoutOption("10 seconds"),
                Effect.map((option) => option._tag === "Some")
              );
              return { echoed, sized, resized, intact, exited };
            })
          );

          // A scope closing mid-job ends the exec without `exit`: the PTY's SIGHUP kills it.
          yield* Effect.scoped(
            Effect.gen(function* () {
              const shell = yield* sandboxes.shell(sandbox, {
                columns: 60,
                rows: 20,
              });
              yield* collect(shell);
              yield* shell.write(ascii.encode("sleep 300\n"));
              yield* Effect.sleep("500 millis");
            })
          );
          const killed = yield* until(() => {
            try {
              execFileSync(
                "docker",
                ["exec", name, "pgrep", "-f", "sleep 300"],
                { stdio: ["ignore", "ignore", "ignore"] }
              );
              return false;
            } catch {
              return true;
            }
          });

          return { first, killed };
        }).pipe(Effect.provide(DockerSandboxes.layer()), Effect.scoped)
      );

      expect(observed.first).toStrictEqual({
        echoed: true,
        sized: true,
        resized: true,
        intact: true,
        exited: true,
      });
      expect(observed.killed).toBeTruthy();
      rmSync(dir, { recursive: true, force: true });
    });
  }
);
