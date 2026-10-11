// Model providers, picked from environment variables:
//   MODEL_PROVIDER  anthropic | vercel | ollama. Unset: anthropic when ANTHROPIC_API_KEY is set, vercel when
//                   AI_GATEWAY_API_KEY is set, otherwise none (callers fall back to a faux model).
//   MODEL_ID        the provider's model ID, overriding the default below.
//   OLLAMA_URL      the Ollama server, http://192.168.1.20:11434 by default.
import { createProvider } from "@earendil-works/pi-ai";
import type { Model } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { createModels } from "@earendil-works/pi-ai/models";
import type { MutableModels } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { vercelAIGatewayProvider } from "@earendil-works/pi-ai/providers/vercel-ai-gateway";
import { Effect, Schema } from "effect";

import type { AgentModel } from "./agents.ts";

export type ModelProvider = "anthropic" | "vercel" | "ollama";

export const defaultModelIds: Record<ModelProvider, string> = {
  anthropic: "claude-sonnet-5-5",
  vercel: "anthropic/claude-sonnet-5.5",
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

const providers: readonly ModelProvider[] = ["anthropic", "vercel", "ollama"];

const pickProvider = (
  env: NodeJS.ProcessEnv
): Effect.Effect<ModelProvider | undefined, ModelConfigError> => {
  const name = env.MODEL_PROVIDER;
  if (name === undefined || name === "") {
    if (env.ANTHROPIC_API_KEY !== undefined) {
      return Effect.succeed("anthropic");
    }
    return Effect.succeed(
      env.AI_GATEWAY_API_KEY === undefined ? undefined : "vercel"
    );
  }
  const provider = providers.find((candidate) => candidate === name);
  return provider === undefined
    ? Effect.fail(
        new ModelConfigError({
          message: `MODEL_PROVIDER must be one of ${providers.join(", ")}, got ${name}`,
        })
      )
    : Effect.succeed(provider);
};

/** The model the environment asks for, or `undefined` when it names none. */
export const modelFromEnv = Effect.fn("modelFromEnv")(function* (
  env: NodeJS.ProcessEnv
) {
  const provider = yield* pickProvider(env);
  if (provider === undefined) {
    return;
  }
  const modelId = env.MODEL_ID ?? defaultModelIds[provider];
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
    case "ollama": {
      const baseUrl = (env.OLLAMA_URL ?? DEFAULT_OLLAMA_URL).replace(
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
