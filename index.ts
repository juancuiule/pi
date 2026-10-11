// Hello world: an Effect program that runs a pi-durable agent in the sandbox the user picks.
// Uses Anthropic when ANTHROPIC_API_KEY is set, and a scripted faux model otherwise.
// Run: pnpm start [--sandbox none|shell|desktop] [prompt...]
import { parseArgs } from "node:util";

import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { Effect, Layer } from "effect";

import { Agents } from "./src/agents.ts";
import type { AgentModel } from "./src/agents.ts";
import * as DockerSandboxes from "./src/sandbox/docker.ts";
import type { SandboxChoice } from "./src/sandbox/sandbox.ts";

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

const AgentsLive = Layer.unwrap(
  Effect.gen(function* () {
    const models = createModels();
    if (process.env.ANTHROPIC_API_KEY !== undefined) {
      models.setProvider(anthropicProvider());
      const model: AgentModel = {
        provider: "anthropic",
        modelId: "claude-sonnet-5-5",
      };
      return Agents.layer({ models, model });
    }
    yield* Effect.logWarning(
      "ANTHROPIC_API_KEY not set, using a scripted faux model"
    );
    const faux = fauxProvider();
    models.setProvider(faux.provider);
    faux.setResponses(fauxScripts[sandbox]);
    return Agents.layer({
      models,
      model: { provider: "faux", modelId: "faux-1" },
    });
  })
).pipe(Layer.provide(DockerSandboxes.layer()));

const program = Effect.scoped(
  Effect.gen(function* () {
    const agents = yield* Agents;
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
    const answer = yield* conversation.ask(prompt);
    yield* Effect.log(`agent: ${answer}`);
  })
);

try {
  await Effect.runPromise(program.pipe(Effect.provide(AgentsLive)));
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
