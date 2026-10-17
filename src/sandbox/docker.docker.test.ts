// Integration tests against real Docker containers. Run with `pnpm test:docker` after `pnpm sandbox:build`.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
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
import { Skills } from "../skills/skills.ts";
import { ask, callTool, echoToolResult } from "../testing/faux.ts";
import * as DockerVolumes from "../workspaces/docker-volume.ts";
import { Workspaces } from "../workspaces/workspaces.ts";
import * as DockerSandboxes from "./docker.ts";
import { Sandboxes } from "./sandbox.ts";
import type { SandboxShell } from "./sandbox.ts";

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
                "pwd && echo kept > notes.txt && git --version | cut -d' ' -f1"
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
                "cat notes.txt"
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

      expect(first).toStrictEqual({ ok: true, text: "/workspace\ngit\n" });
      expect(second).toStrictEqual({ ok: true, text: "kept\n" });
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
                "uv --version"
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
          const skill = available.find(
            (each) => each.name === "unit-conversion"
          );
          if (skill === undefined) {
            return yield* Effect.die(new Error("no unit-conversion skill"));
          }
          return yield* Effect.scoped(
            Effect.gen(function* () {
              const { sandbox } = yield* workspaces.sandbox({ level: "shell" });
              const env = workspaces.env(sandbox);
              yield* run(
                env,
                "mkdir -p .skills/unit-conversion && echo old > .skills/unit-conversion/stale.txt"
              );
              yield* skills.replace(env, skill, BACKGROUND_CONTEXT);
              return yield* run(env, "ls -A .skills .skills/unit-conversion");
            })
          );
        }).pipe(
          Effect.provide(
            Layer.merge(testWorkspaces(), Skills.directory("skills"))
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
