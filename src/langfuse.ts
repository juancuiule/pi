// Sends the agents' traces to Langfuse over OTLP when LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY are set
// (`pnpm langfuse:up` writes them to .env for the local Langfuse). LANGFUSE_BASE_URL defaults to the local one.
import { Layer } from "effect";
import { FetchHttpClient } from "effect/http";
import { OtlpSerialization, OtlpTracer } from "effect/observability";

export const DEFAULT_LANGFUSE_URL = "http://localhost:3000";

/** The OTLP traces endpoint and headers for a Langfuse project. */
export const langfuseExport = (options: {
  readonly baseUrl: string;
  readonly publicKey: string;
  readonly secretKey: string;
}) => ({
  url: `${options.baseUrl.replace(/\/+$/u, "")}/api/public/otel/v1/traces`,
  headers: {
    authorization: `Basic ${Buffer.from(`${options.publicKey}:${options.secretKey}`).toString("base64")}`,
    "x-langfuse-ingestion-version": "4",
  },
});

/** A tracer exporting to Langfuse, or nothing when the environment has no Langfuse keys. */
export const langfuseLayer = (env: NodeJS.ProcessEnv) => {
  const { LANGFUSE_PUBLIC_KEY: publicKey, LANGFUSE_SECRET_KEY: secretKey } =
    env;
  if (publicKey === undefined || secretKey === undefined) {
    return Layer.empty;
  }
  return OtlpTracer.layer({
    ...langfuseExport({
      baseUrl: env.LANGFUSE_BASE_URL ?? DEFAULT_LANGFUSE_URL,
      publicKey,
      secretKey,
    }),
    resource: { serviceName: "effect-pi" },
    exportInterval: "1 second",
  }).pipe(
    Layer.provide(OtlpSerialization.layerJson),
    Layer.provide(FetchHttpClient.layer)
  );
};
