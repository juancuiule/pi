// The app's configuration, read once from the environment varlock validated against .env.schema. Only the entry point
// (server.ts) imports this module, after `varlock/auto-load`; everything else takes plain options, so tests
// never need an environment. To add a variable, declare it in .env.schema, then map it here.
import { ENV } from "varlock/env";

import { langfuseOptions } from "./langfuse.ts";
import type { ModelConfig } from "./models.ts";

/**
 * For a variable without a default, a blank value from the shell (`X= pnpm server`) arrives as "", while a blank in
 * .env arrives unset; this treats both as unset. (A blank shell value for a variable with a default fails validation.)
 */
const unset = <T extends string>(value: T | undefined): T | undefined =>
  value === "" ? undefined : value;

/** Langfuse export options, or `undefined` when tracing is off; a half-configured key pair throws at startup. */
export const langfuse = langfuseOptions({
  publicKey: ENV.LANGFUSE_PUBLIC_KEY,
  secretKey: ENV.LANGFUSE_SECRET_KEY,
  baseUrl: ENV.LANGFUSE_BASE_URL,
});

/** Which model runs; pi-ai reads the API keys from process.env itself, so only their presence is passed on. */
export const model: ModelConfig = {
  provider: unset(ENV.MODEL_PROVIDER),
  modelId: unset(ENV.MODEL_ID),
  ollamaUrl: ENV.OLLAMA_URL,
  hasAnthropicKey: unset(ENV.ANTHROPIC_API_KEY) !== undefined,
  hasGatewayKey: unset(ENV.AI_GATEWAY_API_KEY) !== undefined,
  hasOpenAIKey: unset(ENV.OPENAI_API_KEY) !== undefined,
};

/** The HTTP server and its conversations; durations are milliseconds (varlock's `duration` type). */
export const server = {
  port: ENV.SERVER_PORT,
  idleTimeoutMs: ENV.CONVERSATION_IDLE_TIMEOUT,
  sweepEveryMs: ENV.CONVERSATION_SWEEP_INTERVAL,
  shutdownTimeoutMs: ENV.SHUTDOWN_TIMEOUT,
};

/** How many Seats, shell Sandboxes and desktop Sandboxes run at once. */
export const capacity = {
  seats: ENV.MAX_SEATS,
  shells: ENV.MAX_SHELLS,
  desktops: ENV.MAX_DESKTOPS,
};

/** Where the server keeps conversations, where skills are read from, and where desktop screenshots go. */
export const paths = {
  db: ENV.EFFECT_PI_DB,
  skills: ENV.SKILLS_DIR,
  screenshots: ENV.SCREENSHOTS_DIR,
};

/** How long to wait for each MCP server when the agents start. */
export const mcpConnectTimeoutMs = ENV.MCP_CONNECT_TIMEOUT;
