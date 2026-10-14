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
import { Effect, Layer } from "effect";
import { afterAll, describe, expect, it } from "vitest";

import { Agents } from "../agents/agents.ts";
import { Capacity } from "../capacity.ts";
import { saveScreenshotsTo } from "../screenshots.ts";
import type { SaveScreenshot } from "../screenshots.ts";
import { Skills } from "../skills/skills.ts";
import { ask, callTool, echoToolResult } from "../testing/faux.ts";
import * as DockerVolumes from "../workspaces/docker-volume.ts";
import { Workspaces } from "../workspaces/workspaces.ts";
import * as DockerSandboxes from "./docker.ts";

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
  }
);
