// Model providers. Which one runs comes from the configuration (MODEL_PROVIDER, MODEL_ID, OLLAMA_URL and the API keys
// in .env.schema): a named provider wins; otherwise anthropic when its key is set, then vercel, then openai; otherwise
// none, and callers fall back to a faux model.
import { createProvider } from "@earendil-works/pi-ai";
import type { Model } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { createModels } from "@earendil-works/pi-ai/models";
import type { MutableModels } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { vercelAIGatewayProvider } from "@earendil-works/pi-ai/providers/vercel-ai-gateway";
import { Effect, Schema } from "effect";

import type { AgentModel } from "./agents/agents.ts";

export type ModelProvider = "anthropic" | "vercel" | "openai" | "ollama";

export const defaultModelIds: Record<ModelProvider, string> = {
  anthropic: "claude-sonnet-5-5",
  vercel: "alibaba/qwen3.8-27b",
  openai: "gpt-5.5",
  ollama: "qwen3.5:4b-64k",
};

export const DEFAULT_OLLAMA_URL = "http://192.168.1.20:11434";

// Ollama's context when a model sets no num_ctx; a guess on the small side, so pi compacts early rather than late.
const OLLAMA_DEFAULT_CONTEXT = 4096;

export class ModelConfigError extends Schema.TaggedError<ModelConfigError>()(
  "ModelConfigError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  }
) {}

export interface ModelSetup {
  readonly models: MutableModels;
  readonly model: AgentModel;
}

// ─── Ollama ──────────────────────────────────────────────────────────────────

/** The part of Ollama's `POST /api/show` response that describes what a model can do. */
export interface OllamaShow {
  readonly capabilities?: readonly string[];
  /** Modelfile parameters, one `name value` pair per line, for example `num_ctx 65536`. */
  readonly parameters?: string;
}

/** A pi-ai model for an Ollama model, from what Ollama reports about it. */
export const ollamaModel = (
  id: string,
  baseUrl: string,
  show: OllamaShow
): Model<"openai-completions"> => {
  const capabilities = show.capabilities ?? [];
  const numCtx = /^num_ctx\s+(?<numCtx>\d+)/mu.exec(show.parameters ?? "")
    ?.groups?.numCtx;
  const contextWindow =
    numCtx === undefined ? OLLAMA_DEFAULT_CONTEXT : Number(numCtx);
  return {
    id,
    name: `${id} (Ollama)`,
    api: "openai-completions",
    provider: "ollama",
    baseUrl: `${baseUrl}/v1`,
    reasoning: capabilities.includes("thinking"),
    input: capabilities.includes("vision") ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens: Math.min(8192, contextWindow),
    // Ollama rejects the `developer` role and ignores `reasoning_effort`.
    compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
  };
};

/** A keyless provider serving the given Ollama models. */
export const ollamaProvider = (
  baseUrl: string,
  models: readonly Model<"openai-completions">[]
) =>
  createProvider<"openai-completions">({
    id: "ollama",
    name: "Ollama",
    baseUrl: `${baseUrl}/v1`,
    // Ollama needs no key, but the OpenAI client refuses to send a request without one.
    auth: {
      apiKey: {
        name: "Ollama",
        resolve: () => Promise.resolve({ auth: { apiKey: "ollama" } }),
      },
    },
    models,
    api: openAICompletionsApi(),
  });

/** Ask an Ollama server about one of its models. Fails when the server is unreachable or lacks the model. */
export const showOllamaModel = (baseUrl: string, id: string) =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(`${baseUrl}/api/show`, {
        method: "POST",
        body: JSON.stringify({ model: id }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        throw new Error(`${response.status} ${await response.text()}`);
      }
      return (await response.json()) as OllamaShow;
    },
    catch: (cause) =>
      new ModelConfigError({
        message: `Could not load Ollama model ${id} from ${baseUrl}`,
        cause,
      }),
  });

// ─── Picking a provider ──────────────────────────────────────────────────────

/** What the configuration says about the model; see .env.schema. The keys themselves are read by pi-ai. */
export interface ModelConfig {
  readonly provider?: ModelProvider | undefined;
  readonly modelId?: string | undefined;
  readonly ollamaUrl?: string | undefined;
  readonly hasAnthropicKey?: boolean | undefined;
  readonly hasGatewayKey?: boolean | undefined;
  readonly hasOpenAIKey?: boolean | undefined;
}

const pickProvider = (config: ModelConfig): ModelProvider | undefined => {
  if (config.provider !== undefined) {
    return config.provider;
  }
  if (config.hasAnthropicKey) {
    return "anthropic";
  }
  if (config.hasGatewayKey) {
    return "vercel";
  }
  return config.hasOpenAIKey ? "openai" : undefined;
};

/** The model the configuration asks for, or `undefined` when it names none. */
export const modelFromConfig = Effect.fnUntraced(function* (
  config: ModelConfig
) {
  const provider = pickProvider(config);
  if (provider === undefined) {
    return;
  }
  const modelId = config.modelId ?? defaultModelIds[provider];
  const models = createModels();
  switch (provider) {
    case "anthropic": {
      models.setProvider(anthropicProvider());
      return {
        models,
        model: { provider: "anthropic", modelId },
      } satisfies ModelSetup;
    }
    case "vercel": {
      models.setProvider(vercelAIGatewayProvider());
      return {
        models,
        model: { provider: "vercel-ai-gateway", modelId },
      } satisfies ModelSetup;
    }
    case "openai": {
      models.setProvider(openaiProvider());
      return {
        models,
        model: { provider: "openai", modelId },
      } satisfies ModelSetup;
    }
    case "ollama": {
      const baseUrl = (config.ollamaUrl ?? DEFAULT_OLLAMA_URL).replace(
        /\/+$/u,
        ""
      );
      const show = yield* showOllamaModel(baseUrl, modelId);
      models.setProvider(
        ollamaProvider(baseUrl, [ollamaModel(modelId, baseUrl, show)])
      );
      return {
        models,
        model: { provider: "ollama", modelId },
      } satisfies ModelSetup;
    }
    default: {
      return provider satisfies never;
    }
  }
});
