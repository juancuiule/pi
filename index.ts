// Hello world: an Effect program that runs a pi-durable agent, which spawns a subagent through a tool.
// Uses Anthropic when ANTHROPIC_API_KEY is set, and a scripted faux model otherwise.
// Run: pnpm start
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
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall(
            "subagent",
            { task: "Say hello to Effect." },
            { id: "call-1" }
          ),
        ],
        { stopReason: "toolUse" }
      ),
      fauxAssistantMessage([fauxText("Hello, Effect!")]),
      fauxAssistantMessage([fauxText("The subagent says: Hello, Effect!")]),
    ]);
    return Agents.layer({
      models,
      model: { provider: "faux", modelId: "faux-1" },
    });
  })
);

const program = Effect.gen(function* () {
  const agents = yield* Agents;
  const prompt =
    "Use the subagent tool to say hello to Effect, then tell me what it said.";
  yield* Effect.log(`user: ${prompt}`);
  const answer = yield* agents.ask(prompt);
  yield* Effect.log(`agent: ${answer}`);
});

try {
  await Effect.runPromise(program.pipe(Effect.provide(AgentsLive)));
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
