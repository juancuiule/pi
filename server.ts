// The agent console's server: the HTTP API in src/server/ on http://localhost:4000.
// The model comes from the environment (see src/models.ts); without one, an echo model answers.
// Run: pnpm server
import { createServer } from "node:http";

import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import { Duration, Effect, Layer } from "effect";
import { HttpRouter } from "effect/http";

import { mcpServers } from "./mcp.config.ts";
import { Agents } from "./src/agents.ts";
import { langfuseLayer } from "./src/langfuse.ts";
import { modelFromEnv } from "./src/models.ts";
import * as DockerSandboxes from "./src/sandbox/docker.ts";
import { saveScreenshotsTo } from "./src/screenshots.ts";
import { Conversations } from "./src/server/conversations.ts";
import { echoModel } from "./src/server/faux.ts";
import { apiLayer } from "./src/server/handlers.ts";
import { loadSkills } from "./src/skills.ts";

const PORT = 4000;

const { skills, problems } = loadSkills("skills");
for (const problem of problems) {
  console.warn(`skipped skill ${problem}`);
}

const configured = await Effect.runPromise(modelFromEnv(process.env));
const setup = configured ?? echoModel();
if (configured === undefined) {
  console.warn("No model configured, the echo model answers");
}
const modelName = `${setup.model.provider}/${setup.model.modelId}`;

// Conversations survive restarts in a WAL SQLite file; the harness closes it on shutdown. The opener
// creates the directory.
const storage = await openNodeSqliteStorage(
  process.env.EFFECT_PI_DB ?? "data/effect-pi.sqlite"
);

const AgentsLive = Agents.layer({
  ...setup,
  storage,
  saveScreenshot: saveScreenshotsTo("screenshots"),
  skills,
  mcp: mcpServers,
}).pipe(Layer.provide(DockerSandboxes.layer()));

const ConversationsLive = Conversations.layer({
  maxSandboxes: 3,
  idleTimeoutMs: 30 * 60 * 1000,
  sweepEveryMs: 60 * 1000,
}).pipe(Layer.provide(AgentsLive));

const ServerLive = HttpRouter.serve(apiLayer({ model: modelName })).pipe(
  Layer.provide(ConversationsLive),
  Layer.provide(
    NodeHttpServer.layer(createServer, {
      port: PORT,
      host: "127.0.0.1",
      // SSE connections never close on their own; do not wait for them (the default is 20s) before removing sandboxes.
      gracefulShutdownTimeout: Duration.seconds(1),
    })
  ),
  Layer.provide(langfuseLayer(process.env))
);

// runMain runs every finalizer on SIGINT/SIGTERM, so stopping the server removes all sandboxes.
Layer.launch(ServerLive).pipe(NodeRuntime.runMain);
