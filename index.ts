// Hello world: an Effect program that runs a pi-durable agent in the sandbox the user picks.
// The model comes from the environment (see src/models.ts); without one, a scripted faux model runs.
// Run: pnpm start [--sandbox none|shell|desktop] [prompt...]
import { parseArgs } from "node:util";

import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { Effect, Layer } from "effect";

import { mcpServers } from "./mcp.config.ts";
import { Agents } from "./src/agents.ts";
import { langfuseLayer } from "./src/langfuse.ts";
import { modelFromEnv } from "./src/models.ts";
import * as DockerSandboxes from "./src/sandbox/docker.ts";
import type { SandboxChoice } from "./src/sandbox/sandbox.ts";
import { saveScreenshotsTo, screenshotDir } from "./src/screenshots.ts";
import { Skills } from "./src/skills/skills.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { sandbox: { type: "string", default: "none" } },
});
const choices: readonly SandboxChoice[] = ["none", "shell", "desktop"];
const sandbox = choices.find((choice) => choice === values.sandbox);
if (sandbox === undefined) {
  throw new Error(`--sandbox must be one of ${choices.join(", ")}`);
}

const defaultPrompts: Record<SandboxChoice, string> = {
  none: "Use the subagent tool to say hello to Effect, then tell me what it said.",
  shell: "Which Linux distribution are you running on?",
  desktop: "Take a screenshot of the desktop and describe it.",
};
const prompt =
  positionals.length > 0 ? positionals.join(" ") : defaultPrompts[sandbox];

const toolCall = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
  fauxAssistantMessage([fauxToolCall(name, args, { id: "call-1" })], {
    stopReason: "toolUse",
  });

// Without an API key, a scripted model shows each sandbox's tools at work.
const fauxScripts: Record<SandboxChoice, FauxResponseStep[]> = {
  none: [
    toolCall("subagent", { task: "Say hello to Effect." }),
    fauxAssistantMessage([fauxText("Hello, Effect!")]),
    fauxAssistantMessage([fauxText("The subagent says: Hello, Effect!")]),
  ],
  shell: [
    toolCall("bash", { command: "head -1 /etc/os-release && uname -m" }),
    (request) => {
      const result = request.messages.findLast((m) => m.role === "toolResult");
      const text = (result?.content ?? [])
        .flatMap((c) => (c.type === "text" ? [c.text] : []))
        .join("");
      return fauxAssistantMessage([fauxText(`bash says: ${text.trim()}`)]);
    },
  ],
  desktop: [
    toolCall("desktop_screenshot", {}),
    (request) => {
      const result = request.messages.findLast((m) => m.role === "toolResult");
      const image = result?.content.find((c) => c.type === "image");
      return fauxAssistantMessage([
        fauxText(
          image === undefined
            ? "No screenshot came back."
            : `Got a ${image.mimeType} screenshot (${image.data.length} base64 characters).`
        ),
      ]);
    },
  ],
};

// Every desktop screenshot is kept in screenshots/<sandbox id>/, numbered in order.
const SCREENSHOTS = "screenshots";

const saveScreenshot = saveScreenshotsTo(SCREENSHOTS);

const AgentsLive = Layer.unwrap(
  Effect.gen(function* () {
    const setup = yield* modelFromEnv(process.env);
    if (setup !== undefined) {
      yield* Effect.log(
        `model: ${setup.model.provider}/${setup.model.modelId}`
      );
      return Agents.layer({
        ...setup,
        saveScreenshot,
        mcp: mcpServers,
      });
    }
    yield* Effect.logWarning(
      "No model configured (MODEL_PROVIDER, ANTHROPIC_API_KEY or AI_GATEWAY_API_KEY), using a scripted faux model"
    );
    const models = createModels();
    const faux = fauxProvider();
    models.setProvider(faux.provider);
    faux.setResponses(fauxScripts[sandbox]);
    return Agents.layer({
      models,
      model: { provider: "faux", modelId: "faux-1" },
      saveScreenshot,
      mcp: mcpServers,
    });
  })
).pipe(
  Layer.provide(DockerSandboxes.layer()),
  // Skills from skills/<name>/SKILL.md; `/skill:<name> request` forces one, `/skill:<name>` elsewhere hints at it.
  Layer.provide(Skills.directory("skills"))
);

const program = Effect.scoped(
  Effect.gen(function* () {
    const agents = yield* Agents;
    // Expanded first, so an unknown skill fails before a sandbox is created.
    const message = yield* agents.expandSkill(prompt);
    const conversation = yield* agents.start({ sandbox });
    if (conversation.sandbox !== undefined) {
      yield* Effect.log(
        `sandbox: ${conversation.sandbox.kind} ${conversation.sandbox.id}`
      );
    }
    if (conversation.sandbox?.vncUrl !== undefined) {
      yield* Effect.log(`watch the desktop: ${conversation.sandbox.vncUrl}`);
    }
    yield* Effect.log(`user: ${prompt}`);
    const answer = yield* conversation.ask(message);
    yield* Effect.log(`agent: ${answer}`);
    yield* Effect.annotateCurrentSpan({
      "langfuse.observation.input": prompt,
      "langfuse.observation.output": answer,
    });
    if (conversation.sandbox?.kind === "desktop") {
      yield* Effect.log(
        `screenshots: ${screenshotDir(SCREENSHOTS, conversation.sandbox.id)}`
      );
    }
  })
).pipe(
  // The trace root: one trace per run, tagged with the sandbox.
  Effect.withSpan(`effect-pi ${sandbox}`, {
    attributes: { "langfuse.trace.tags": [sandbox] },
  })
);

// Agents is built with the Langfuse tracer, so the spans pi-durable's hooks create are exported too.
const MainLive = Layer.provideMerge(AgentsLive, langfuseLayer(process.env));

try {
  await Effect.runPromise(program.pipe(Effect.provide(MainLive)));
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
