// Test helpers: an Agents layer backed by pi-ai's scripted faux model and local-directory sandboxes.
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type { Storage } from "@earendil-works/pi-durable";
import { Effect, Layer } from "effect";

import { Agents } from "../agents.ts";
import type { McpServerConfig } from "../mcp.ts";
import type { SandboxChoice } from "../sandbox/sandbox.ts";
import type { Skill } from "../skills.ts";
import { localSandboxes } from "./sandboxes.ts";

export const fauxAgents = (
  responses: FauxResponseStep[],
  options: {
    readonly skills?: readonly Skill[];
    /** Persistent storage, so a rebuilt layer sees earlier conversations (restart tests). */
    readonly storage?: Storage;
    /** MCP servers, usually `fakeMcpServer`s. */
    readonly mcp?: readonly McpServerConfig[];
  } = {}
) => {
  const models = createModels();
  const faux = fauxProvider();
  models.setProvider(faux.provider);
  faux.setResponses(responses);
  const sandboxes = localSandboxes();
  return {
    faux,
    sandboxes,
    layer: Agents.layer({
      models,
      model: { provider: "faux", modelId: "faux-1" },
      ...options,
    }).pipe(Layer.provide(sandboxes.layer)),
  };
};

/** Start a conversation with the given sandbox, ask one prompt, and end it. */
export const ask = (prompt: string, sandbox: SandboxChoice = "none") =>
  Effect.scoped(
    Effect.gen(function* () {
      const agents = yield* Agents;
      const conversation = yield* agents.start({ sandbox });
      return yield* conversation.ask(prompt);
    })
  );

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
