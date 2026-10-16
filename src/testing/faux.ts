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
import type { AgentModel } from "../agents/agents.ts";
import type { ApprovalPolicy } from "../approvals.ts";
import { Artifacts } from "../artifacts/artifacts.ts";
import { Attachments } from "../attachments/attachments.ts";
import type { AttachmentLimits } from "../attachments/attachments.ts";
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
    /** The configured model; the faux provider has only `faux/faux-1`, the default. */
    readonly model?: AgentModel;
    /** Attachment limits; the layer provides those Attachments too (temporary), for tests to upload with. */
    readonly attachmentLimits?: Partial<AttachmentLimits>;
    /** Whether the faux model takes images; it does by default. */
    readonly vision?: boolean;
  } = {}
) => {
  const models = createModels();
  const faux = fauxProvider(
    options.vision === false
      ? { models: [{ id: "faux-1", input: ["text"] }] }
      : {}
  );
  models.setProvider(faux.provider);
  faux.setResponses(responses);
  const sandboxes = localSandboxes();
  return {
    faux,
    sandboxes,
    layer: Agents.layer({
      models,
      model: options.model ?? { provider: "faux", modelId: "faux-1" },
      ...(options.storage === undefined ? {} : { storage: options.storage }),
      ...(options.mcp === undefined ? {} : { mcp: options.mcp }),
      ...(options.mcpConnectTimeoutMs === undefined
        ? {}
        : { mcpConnectTimeoutMs: options.mcpConnectTimeoutMs }),
    }).pipe(
      Layer.provide(sandboxes.layer),
      Layer.provide(options.skills ?? Skills.none),
      Layer.provideMerge(Attachments.temporary(options.attachmentLimits)),
      Layer.provideMerge(Artifacts.temporary()),
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

const nameOf = (tool: unknown) =>
  typeof tool === "string" ? tool : (tool as { name: string }).name;

/** A model turn that answers with the tools it was offered and every system message, as JSON (see `offeredIn`). */
export const offered: FauxResponseStep = (request) => {
  const system = request.messages.filter((m) => m.role === "system");
  // pi-durable sends tool changes on positional system messages; the offered tools are their sum.
  const tools = new Set<string>();
  for (const message of system) {
    for (const tool of message.toolsRemoved ?? []) {
      tools.delete(nameOf(tool));
    }
    for (const tool of message.toolsAdded ?? []) {
      tools.add(nameOf(tool));
    }
  }
  return fauxAssistantMessage([
    fauxText(JSON.stringify({ tools: [...tools], system })),
  ]);
};

/**
 * The answer of an `offered` turn: the tool names, and the prompt sections as the model last got them (a later system
 * message replaces a section), as one string.
 */
export const offeredIn = (
  answer: string
): { readonly tools: string[]; readonly system: string } => {
  const parsed = JSON.parse(answer) as {
    tools: string[];
    system: { sections?: Record<string, string> }[];
  };
  const sections: Record<string, string> = {};
  for (const message of parsed.system) {
    Object.assign(sections, message.sections ?? {});
  }
  return {
    tools: parsed.tools.toSorted(),
    system: JSON.stringify(sections),
  };
};
