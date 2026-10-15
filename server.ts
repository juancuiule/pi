// The agent console's server: the HTTP API in src/server/, on SERVER_PORT (4000 by default).
// Configuration comes from the environment, validated against .env.schema (see src/config.ts); without a model,
// an echo model answers.
// Run: pnpm server

// Validates the environment against .env.schema and loads .env before anything reads it (pi-ai reads API keys itself).
import "varlock/auto-load";
import { createServer } from "node:http";

import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import { Duration, Effect, Layer } from "effect";
import { HttpRouter, Multipart } from "effect/http";

import { mcpServers } from "./mcp.config.ts";
import { Agents } from "./src/agents/agents.ts";
import { Attachments } from "./src/attachments/attachments.ts";
import { Capacity } from "./src/capacity.ts";
import * as config from "./src/config.ts";
import { langfuseLayer } from "./src/langfuse.ts";
import { modelFromConfig } from "./src/models.ts";
import { saveScreenshotsTo } from "./src/screenshots.ts";
import { Conversations } from "./src/server/conversations.ts";
import { echoModel } from "./src/server/faux.ts";
import { ApiLayer } from "./src/server/handlers.ts";
import { Skills } from "./src/skills/skills.ts";
import * as DockerVolumes from "./src/workspaces/docker-volume.ts";

const configured = await Effect.runPromise(modelFromConfig(config.model));
const setup = configured ?? echoModel();
if (configured === undefined) {
  console.warn("No model configured, the echo model answers");
}

// Conversations survive restarts in a WAL SQLite file; the harness closes it on shutdown. The opener
// creates the directory.
const storage = await openNodeSqliteStorage(config.paths.db);

// Attachments' metadata is a table of its own in the same SQLite file; their bytes are in ATTACHMENTS_DIR.
const AttachmentsLive = Attachments.local({
  directory: config.paths.attachments,
  database: config.paths.db,
  limits: config.attachments,
});

// One Capacity for both: Conversations claims Seats, Agents claims Sandboxes (and waits for one on an Upgrade).
const CapacityLive = Capacity.layer(config.capacity);

const AgentsLive = Agents.layer({
  ...setup,
  storage,
  saveScreenshot: saveScreenshotsTo(config.paths.screenshots),
  mcp: mcpServers,
  mcpConnectTimeoutMs: config.mcpConnectTimeoutMs,
  traceAttachmentText: config.traceAttachmentText,
}).pipe(
  Layer.provide(DockerVolumes.workspaces()),
  Layer.provide(Skills.directory(config.paths.skills)),
  Layer.provide(CapacityLive),
  Layer.provideMerge(AttachmentsLive)
);

const ConversationsLive = Conversations.layer(config.server).pipe(
  Layer.provide(AgentsLive),
  Layer.provide(CapacityLive)
);

const NodeHttpServerLayer = NodeHttpServer.layer(createServer, {
  port: config.server.port,
  // Loopback only, on purpose: the API has no auth (see src/server/loopback.ts).
  host: "127.0.0.1",
  // SSE connections never close on their own; do not wait for them long (the default is 20s) before removing sandboxes.
  gracefulShutdownTimeout: Duration.millis(config.server.shutdownTimeoutMs),
});

const LangfuseLayer = langfuseLayer(config.langfuse);

// Uploads stream to temporary files; one bigger than the limit is cut off while it streams, not after.
const UploadLimits = Layer.succeedContext(
  Multipart.limitsServices({
    maxFileSize: config.attachments.maxFileBytes,
    maxTotalSize: config.attachments.maxFileBytes + 1024 * 1024,
  })
);

const ServerLive = HttpRouter.serve(ApiLayer).pipe(
  Layer.provide(ConversationsLive),
  Layer.provide(AgentsLive),
  Layer.provide(NodeHttpServerLayer),
  Layer.provide(UploadLimits),
  Layer.provide(LangfuseLayer)
);

// runMain runs every finalizer on SIGINT/SIGTERM, so stopping the server removes all sandboxes.
Layer.launch(ServerLive).pipe(NodeRuntime.runMain);
