// Integration tests against real Docker containers. Run with `pnpm test:docker` after `pnpm sandbox:build`.
import { execFileSync } from "node:child_process";

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
} from "@earendil-works/pi-ai/providers/faux";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { Agents } from "../agents.ts";
import { ask, callTool, echoToolResult } from "../testing/faux.ts";
import * as DockerSandboxes from "./docker.ts";
import { Sandboxes } from "./sandbox.ts";

const containerExists = (name: string) =>
  execFileSync("docker", ["ps", "-a", "--filter", `name=^${name}$`, "-q"], {
    encoding: "utf-8",
  }).trim() !== "";

const dockerAgents = (responses: FauxResponseStep[]) => {
  const models = createModels();
  const faux = fauxProvider();
  models.setProvider(faux.provider);
  faux.setResponses(responses);
  return Agents.layer({
    models,
    model: { provider: "faux", modelId: "faux-1" },
  }).pipe(Layer.provide(DockerSandboxes.layer()));
};

describe.skipIf(!(await DockerSandboxes.dockerAvailable()))(
  "Docker sandboxes",
  { timeout: 120_000 },
  () => {
    it("runs commands in a shell container and removes it", async () => {
      const name = DockerSandboxes.makeName("shell");

      const output = await Effect.runPromise(
        Effect.gen(function* () {
          const sandboxes = yield* Sandboxes;
          const sandbox = yield* sandboxes.create("shell", name);
          let text = "";
          const result = yield* Effect.promise(() =>
            sandboxes
              .env(sandbox)
              .exec(
                "pwd && git --version | cut -d' ' -f1",
                { onOutput: (chunk) => (text += chunk) },
                BACKGROUND_CONTEXT
              )
          );
          yield* sandboxes.remove(sandbox);
          return { ok: result.ok, text };
        }).pipe(Effect.provide(DockerSandboxes.layer()), Effect.scoped)
      );

      expect(output).toStrictEqual({ ok: true, text: "/workspace\ngit\n" });
      expect(containerExists(name)).toBeFalsy();
    });

    it("gives the model a PNG screenshot of the desktop", async () => {
      const layer = dockerAgents([
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
      ]);

      const answer = await Effect.runPromise(
        ask("Look at the screen.", "desktop").pipe(Effect.provide(layer))
      );

      expect(answer).toBe("PNG");
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
