// Test helpers: an Agents layer backed by pi-ai's scripted faux model.
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { Effect } from "effect";

import { Agents } from "../agents.ts";

export const fauxAgents = (responses: FauxResponseStep[]) => {
  const models = createModels();
  const faux = fauxProvider();
  models.setProvider(faux.provider);
  faux.setResponses(responses);
  return {
    faux,
    layer: Agents.layer({
      models,
      model: { provider: "faux", modelId: "faux-1" },
    }),
  };
};

export const ask = (prompt: string) =>
  Effect.gen(function* () {
    const agents = yield* Agents;
    return yield* agents.ask(prompt);
  });

/** A model turn that calls one tool. */
export const callTool = (
  name: string,
  args: Parameters<typeof fauxToolCall>[1]
) =>
  fauxAssistantMessage([fauxToolCall(name, args, { id: `call-${name}` })], {
    stopReason: "toolUse",
  });

/** A model turn that answers with the last tool result it received, prefixed with `error:` when it failed. */
export const echoToolResult: FauxResponseStep = (request) => {
  const result = request.messages.findLast(
    (message) => message.role === "toolResult"
  );
  const text = (result?.content ?? [])
    .flatMap((c) => (c.type === "text" ? [c.text] : []))
    .join("");
  return fauxAssistantMessage([
    fauxText(result?.isError === true ? `error: ${text}` : text),
  ]);
};
