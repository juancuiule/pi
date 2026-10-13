// Sends the agents' traces to Langfuse over OTLP when both Langfuse keys are configured (see .env.schema;
// `pnpm langfuse:up` writes them to .env for the local Langfuse).
import { Layer } from "effect";
import { FetchHttpClient } from "effect/http";
import { OtlpSerialization, OtlpTracer } from "effect/observability";

export const DEFAULT_LANGFUSE_URL = "http://localhost:3000";

/** Where and as whom traces go: a Langfuse project's URL and API keys. */
export interface LangfuseOptions {
  readonly baseUrl: string;
  readonly publicKey: string;
  readonly secretKey: string;
}

/**
 * Langfuse options from its configuration: both keys export traces, neither turns tracing off. One key alone is a
 * mistake (a typo or a half-filled .env) that would silently drop every trace, so it throws. Blank values are unset.
 */
export const langfuseOptions = (input: {
  readonly publicKey?: string | undefined;
  readonly secretKey?: string | undefined;
  readonly baseUrl?: string | undefined;
}): LangfuseOptions | undefined => {
  const publicKey = input.publicKey === "" ? undefined : input.publicKey;
  const secretKey = input.secretKey === "" ? undefined : input.secretKey;
  if (publicKey === undefined && secretKey === undefined) {
    return undefined;
  }
  if (secretKey === undefined) {
    throw new Error(
      "LANGFUSE_PUBLIC_KEY is set but LANGFUSE_SECRET_KEY is not: set both to trace to Langfuse, or neither"
    );
  }
  if (publicKey === undefined) {
    throw new Error(
      "LANGFUSE_SECRET_KEY is set but LANGFUSE_PUBLIC_KEY is not: set both to trace to Langfuse, or neither"
    );
  }
  return {
    baseUrl: input.baseUrl ?? DEFAULT_LANGFUSE_URL,
    publicKey,
    secretKey,
  };
};

/** The OTLP traces endpoint and headers for a Langfuse project. */
export const langfuseExport = (options: LangfuseOptions) => ({
  url: `${options.baseUrl.replace(/\/+$/u, "")}/api/public/otel/v1/traces`,
  headers: {
    authorization: `Basic ${Buffer.from(`${options.publicKey}:${options.secretKey}`).toString("base64")}`,
    "x-langfuse-ingestion-version": "4",
  },
});

/** A tracer exporting to Langfuse, or nothing without options (see `langfuseOptions`). */
export const langfuseLayer = (options: LangfuseOptions | undefined) => {
  if (options === undefined) {
    return Layer.empty;
  }
  return OtlpTracer.layer({
    ...langfuseExport(options),
    resource: { serviceName: "effect-pi" },
    exportInterval: "1 second",
  }).pipe(
    Layer.provide(OtlpSerialization.layerJson),
    Layer.provide(FetchHttpClient.layer)
  );
};
