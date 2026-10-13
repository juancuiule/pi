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
import { HttpRouter } from "effect/http";

import { mcpServers } from "./mcp.config.ts";
import { Agents } from "./src/agents/agents.ts";
import * as config from "./src/config.ts";
import { langfuseLayer } from "./src/langfuse.ts";
import { modelFromConfig } from "./src/models.ts";
import * as DockerSandboxes from "./src/sandbox/docker.ts";
import { saveScreenshotsTo } from "./src/screenshots.ts";
import { Conversations } from "./src/server/conversations.ts";
import { echoModel } from "./src/server/faux.ts";
import { ApiLayer } from "./src/server/handlers.ts";
import { Skills } from "./src/skills/skills.ts";

const configured = await Effect.runPromise(modelFromConfig(config.model));
const setup = configured ?? echoModel();
if (configured === undefined) {
  console.warn("No model configured, the echo model answers");
}

// Conversations survive restarts in a WAL SQLite file; the harness closes it on shutdown. The opener
// creates the directory.
const storage = await openNodeSqliteStorage(config.paths.db);

const AgentsLive = Agents.layer({
  ...setup,
  storage,
  saveScreenshot: saveScreenshotsTo(config.paths.screenshots),
  mcp: mcpServers,
  mcpConnectTimeoutMs: config.mcpConnectTimeoutMs,
}).pipe(
  Layer.provide(DockerSandboxes.layer()),
  Layer.provide(Skills.directory(config.paths.skills))
);

const ConversationsLive = Conversations.layer(config.server).pipe(
  Layer.provide(AgentsLive)
);

const NodeHttpServerLayer = NodeHttpServer.layer(createServer, {
  port: config.server.port,
  // Loopback only, on purpose: the API has no auth (see src/server/loopback.ts).
  host: "127.0.0.1",
  // SSE connections never close on their own; do not wait for them long (the default is 20s) before removing sandboxes.
  gracefulShutdownTimeout: Duration.millis(config.server.shutdownTimeoutMs),
});

const LangfuseLayer = langfuseLayer(config.langfuse);

const ServerLive = HttpRouter.serve(ApiLayer).pipe(
  Layer.provide(ConversationsLive),
  Layer.provide(AgentsLive),
  Layer.provide(NodeHttpServerLayer),
  Layer.provide(LangfuseLayer)
);

// runMain runs every finalizer on SIGINT/SIGTERM, so stopping the server removes all sandboxes.
Layer.launch(ServerLive).pipe(NodeRuntime.runMain);
