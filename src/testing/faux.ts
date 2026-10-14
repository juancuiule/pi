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

import { Agents } from "../agents/agents.ts";
import type { ApprovalPolicy } from "../approvals.ts";
import { Capacity } from "../capacity.ts";
import type { Limits } from "../capacity.ts";
import type { McpServerConfig } from "../mcp.ts";
import type { SandboxChoice } from "../sandbox/sandbox.ts";
import { Skills } from "../skills/skills.ts";
import { localSandboxes } from "./sandboxes.ts";

export const fauxAgents = (
  responses: FauxResponseStep[],
  options: {
    /** Where skills come from, usually `Skills.directory(...)` or a `SkillSource.memory` source; none by default. */
    readonly skills?: Layer.Layer<Skills>;
    /** Persistent storage, so a rebuilt layer sees earlier conversations (restart tests). */
    readonly storage?: Storage;
    /** MCP servers, usually `fakeMcpServer`s. */
    readonly mcp?: readonly McpServerConfig[];
    /** How long to wait for each MCP server; `Agents.layer`'s default otherwise. */
    readonly mcpConnectTimeoutMs?: number;
    /** Capacity limits; the layer provides that Capacity too, for a Conversations layer to share. */
    readonly limits?: Partial<Limits>;
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
      ...(options.storage === undefined ? {} : { storage: options.storage }),
      ...(options.mcp === undefined ? {} : { mcp: options.mcp }),
      ...(options.mcpConnectTimeoutMs === undefined
        ? {}
        : { mcpConnectTimeoutMs: options.mcpConnectTimeoutMs }),
    }).pipe(
      Layer.provide(sandboxes.layer),
      Layer.provide(options.skills ?? Skills.none),
      Layer.provideMerge(
        Capacity.layer({ seats: 10, shells: 3, desktops: 1, ...options.limits })
      )
    ),
  };
};

/** Record a Conversation and give it a Seat until the scope closes. */
export const openSeat = (
  options: {
    readonly sandbox?: SandboxChoice;
    readonly approvals?: ApprovalPolicy;
  } = {}
) =>
  Effect.gen(function* () {
    const agents = yield* Agents;
    const id = yield* agents.create({
      prompt: "",
      title: "",
      level: options.sandbox ?? "none",
      createdAt: Date.now(),
      approvals: options.approvals,
    });
    return yield* agents.open(id);
  });

/** Open a Seat at the given Level, ask one prompt, and end the Seat. */
export const ask = (prompt: string, sandbox: SandboxChoice = "none") =>
  Effect.scoped(
    openSeat({ sandbox }).pipe(Effect.flatMap((seat) => seat.ask(prompt)))
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
    fauxText(result?.isError ? `error: ${text}` : text),
  ]);
};
