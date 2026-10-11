// A faux model for running the server without one configured: it answers every prompt with `echo: <prompt>`.
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
} from "@earendil-works/pi-ai/providers/faux";

export const echoModel = () => {
  const models = createModels();
  const faux = fauxProvider();
  models.setProvider(faux.provider);
  // Faux responses are a queue; each answer queues the next one.
  const echo: FauxResponseStep = (request) => {
    faux.appendResponses([echo]);
    const last = request.messages.findLast((m) => m.role === "user");
    const text =
      typeof last?.content === "string"
        ? last.content
        : (last?.content ?? [])
            .flatMap((c) => (c.type === "text" ? [c.text] : []))
            .join("");
    return fauxAssistantMessage([fauxText(`echo: ${text}`)]);
  };
  faux.setResponses([echo]);
  return { models, model: { provider: "faux", modelId: "faux-1" } };
};
