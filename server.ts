// The agent console's server: the HTTP API in src/server/, on SERVER_PORT (4000 by default).
// Configuration comes from the environment, validated against .env.schema (see src/config.ts); without a model,
// an echo model answers.
// Run: pnpm server

// Validates the environment against .env.schema and loads .env before anything reads it (pi-ai reads API keys itself).
import "varlock/auto-load";
import { createServer } from "node:http";

import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import {
  NodeFileSystem,
  NodeHttpServer,
  NodePath,
  NodeRuntime,
} from "@effect/platform-node";
import { Duration, Effect, Layer } from "effect";
import { HttpRouter, Multipart } from "effect/http";

import { mcpServers } from "./mcp.config.ts";
import { Agents } from "./src/agents/agents.ts";
import { Artifacts } from "./src/artifacts/artifacts.ts";
import { TrustedDomains } from "./src/artifacts/domains.ts";
import { Attachments } from "./src/attachments/attachments.ts";
import { s3Blobs } from "./src/attachments/store.ts";
import { Capacity } from "./src/capacity.ts";
import * as config from "./src/config.ts";
import { langfuseLayer } from "./src/langfuse.ts";
import { modelFromConfig } from "./src/models.ts";
import {
  saveScreenshotsTo,
  saveScreenshotsToBlobs,
} from "./src/screenshots.ts";
import { Conversations } from "./src/server/conversations.ts";
import { echoModel } from "./src/server/faux.ts";
import { apiLayer } from "./src/server/handlers.ts";
import { shellRoute } from "./src/server/shell.ts";
import { Skills } from "./src/skills/skills.ts";
import { convergeBuiltin, SkillSource } from "./src/skills/source.ts";
import { BUCKETS, s3 } from "./src/storage/object-store.ts";
import * as DockerVolumes from "./src/workspaces/docker-volume.ts";

const configured = await Effect.runPromise(modelFromConfig(config.model));
const setup = configured ?? echoModel();
if (configured === undefined) {
  console.warn("No model configured, the echo model answers");
}

// Conversations survive restarts in a WAL SQLite file; the harness closes it on shutdown. The opener
// creates the directory.
const storage = await openNodeSqliteStorage(config.paths.db);

// With s3 storage the server owns its buckets: startup ensures all of them and the screenshots expiry, which
// is also the connectivity check — an unreachable store fails here. STORAGE=local builds nothing.
const ensureBuckets = async () => {
  if (config.storage.s3 === undefined) {
    return;
  }
  const objects = s3(config.storage.s3);
  await Promise.all(
    Object.values(BUCKETS).map((bucket) => objects.ensure(bucket))
  );
  await objects.setExpiration(
    BUCKETS.screenshots,
    config.storage.screenshotTtlDays
  );
  return objects;
};
export const store = await ensureBuckets();

const NodeContext = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer);

// Under s3 the skills bucket's builtin/ prefix mirrors the repo's skills/ directory: converge it before serving,
// so git stays the source of the built-in skills; org/ holds the skills the PUT endpoint wrote.
if (store !== undefined) {
  await Effect.runPromise(
    convergeBuiltin({
      store,
      bucket: BUCKETS.skills,
      dir: config.paths.skills,
    }).pipe(Effect.provide(NodeContext))
  );
}

// Locally the directory source serves both namespaces: skills/* are builtin, skills/org/* the writable overlay.
const SkillSourceLive = (
  store === undefined
    ? SkillSource.directory(config.paths.skills)
    : SkillSource.s3(store, BUCKETS.skills)
).pipe(Layer.provide(NodeContext));

const SkillsLive = Skills.layer.pipe(Layer.provide(SkillSourceLive));

// Attachments' metadata is a table of its own in the same SQLite file; their bytes are in ATTACHMENTS_DIR, or the
// attachments bucket when STORAGE=s3.
const AttachmentsLive =
  store === undefined
    ? Attachments.local({
        directory: config.paths.attachments,
        database: config.paths.db,
        limits: config.attachments,
      })
    : Attachments.local({
        blobs: s3Blobs(store, BUCKETS.attachments),
        database: config.paths.db,
        limits: config.attachments,
      });

const TrustedDomainsLive = TrustedDomains.local({
  database: config.paths.db,
});

// Artifacts checks each new version's references against the trusted list, live: a domain added in Settings is in
// effect on the next call.
const ArtifactsLive = Layer.unwrap(
  Effect.gen(function* () {
    const trusted = yield* TrustedDomains;
    return Artifacts.local({ database: config.paths.db, trusted });
  })
).pipe(Layer.provideMerge(TrustedDomainsLive));

// One Capacity for both: Conversations claims Seats, Agents claims Sandboxes (and waits for one on an Upgrade).
const CapacityLive = Capacity.layer(config.capacity);

const AgentsLive = Agents.layer({
  ...setup,
  storage,
  saveScreenshot:
    store === undefined
      ? saveScreenshotsTo(config.paths.screenshots)
      : saveScreenshotsToBlobs(store, BUCKETS.screenshots),
  mcp: mcpServers,
  mcpConnectTimeoutMs: config.mcpConnectTimeoutMs,
  traceAttachmentText: config.traceAttachmentText,
}).pipe(
  Layer.provide(DockerVolumes.workspaces()),
  Layer.provide(SkillsLive),
  Layer.provide(CapacityLive),
  Layer.provideMerge(AttachmentsLive),
  Layer.provideMerge(ArtifactsLive)
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

const ServerLive = HttpRouter.serve(
  // Where the console reaches this server directly, skipping Next's rewrite (the shell's socket needs it).
  Layer.mergeAll(
    apiLayer({ apiUrl: `http://127.0.0.1:${config.server.port}` }),
    shellRoute
  )
).pipe(
  Layer.provide(ConversationsLive),
  Layer.provide(AgentsLive),
  // The skills group writes through the same source the Skills service reads.
  Layer.provide(SkillSourceLive),
  Layer.provide(NodeHttpServerLayer),
  Layer.provide(UploadLimits),
  Layer.provide(LangfuseLayer)
);

// runMain runs every finalizer on SIGINT/SIGTERM, so stopping the server removes all sandboxes.
Layer.launch(ServerLive).pipe(NodeRuntime.runMain);
