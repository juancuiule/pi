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

/** Where the server keeps conversations and attachments, where skills are read from, and where desktop screenshots go. */
export const paths = {
  db: ENV.EFFECT_PI_DB,
  skills: ENV.SKILLS_DIR,
  screenshots: ENV.SCREENSHOTS_DIR,
  attachments: ENV.ATTACHMENTS_DIR,
};

/** The S3 endpoint and credentials when STORAGE=s3, `undefined` otherwise; missing credentials throw at startup. */
const s3 = () => {
  if (ENV.STORAGE !== "s3") {
    return;
  }
  const accessKeyId = unset(ENV.S3_ACCESS_KEY_ID);
  const secretAccessKey = unset(ENV.S3_SECRET_ACCESS_KEY);
  if (accessKeyId === undefined || secretAccessKey === undefined) {
    throw new Error(
      "STORAGE=s3 needs S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY (docker/seaweedfs/init-env.ts generates them)"
    );
  }
  return { endpoint: ENV.S3_ENDPOINT, accessKeyId, secretAccessKey };
};

/** Where objects (STORAGE) and workspace files (WORKSPACE_STORAGE) are kept, and the screenshots expiry in days. */
export const storage = {
  mode: ENV.STORAGE,
  workspace: ENV.WORKSPACE_STORAGE,
  screenshotTtlDays: ENV.SCREENSHOT_TTL_DAYS,
  s3: s3(),
};

const MB = 1024 * 1024;

/** Limits on attachments; sizes in bytes, durations in milliseconds. */
export const attachments = {
  maxFileBytes: ENV.ATTACHMENT_MAX_FILE_MB * MB,
  maxFilesPerMessage: ENV.ATTACHMENT_MAX_FILES,
  maxUnsentBytes: ENV.ATTACHMENT_MAX_UNSENT_MB * MB,
  maxPdfPages: ENV.ATTACHMENT_MAX_PDF_PAGES,
  maxImagePixels: ENV.ATTACHMENT_MAX_IMAGE_MEGAPIXELS * 1_000_000,
  extractTimeoutMs: ENV.ATTACHMENT_EXTRACT_TIMEOUT,
  extractMemoryMb: ENV.ATTACHMENT_EXTRACT_MEMORY_MB,
  extractConcurrency: ENV.ATTACHMENT_EXTRACT_CONCURRENCY,
  unsentTtlMs: ENV.ATTACHMENT_UNSENT_TTL,
  inlineChars: ENV.ATTACHMENT_INLINE_CHARS,
  readChars: ENV.ATTACHMENT_READ_CHARS,
};

/** Keep attachment text in traces. */
export const traceAttachmentText = ENV.TRACE_ATTACHMENT_TEXT;

/** How long to wait for each MCP server when the agents start. */
export const mcpConnectTimeoutMs = ENV.MCP_CONNECT_TIMEOUT;
