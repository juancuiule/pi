# effect-pi

## Vendored Repositories

This project vendors external repositories under @repos/ (via `git subtree`).

Each subtree is pinned to the release tag matching the version installed in `package.json`, so the source matches the code that actually runs. When you bump a dependency, pull the matching tag into its subtree.

- Use vendored repositories as read-only reference material when working with related libraries
- Prefer examples and patterns from the vendored source code over generated guesses or web search results
- Do not edit files under @repos/ unless explicitly asked
- Do not import from @repos/ - application code should continue importing from normal package dependencies

### Effect

Before writing any Effect code, read @repos/effect/LLMS.md.

When writing Effect code, inspect @repos/effect/ for examples of idiomatic usage, tests, module structure, and API design. Treat it as the source of truth for Effect patterns.

To update: `git subtree pull --prefix=repos/effect https://github.com/Effect-TS/effect.git effect@<version> --squash` (currently `effect@4.0.2`)

### Pi (`@earendil-works/*`)

@repos/pi/ is the `earendil-works/pi` monorepo, the source of our `@earendil-works/*` dependencies:

- `@earendil-works/pi-ai` → @repos/pi/packages/ai/
- `@earendil-works/pi-durable` → @repos/pi/packages/durable/
- `@earendil-works/chord` → @repos/pi/packages/chord/
- `@earendil-works/pi-mcp` → @repos/pi/packages/mcp/

When using these packages, read the package's `README.md`, `src/` and `test/` for real API usage instead of guessing. `packages/durable/docs/` has additional documentation.

@repos/pi/AGENTS.md contains rules for contributors to the pi repo itself. Those rules do not apply to this project.

To update: `git subtree pull --prefix=repos/pi https://github.com/earendil-works/pi.git v<version> --squash` (currently `v1.1.0`)

## Commands

Use pnpm, never npm or yarn.

- `pnpm typecheck` runs `tsc` (TypeScript 7)
- `pnpm lint` / `pnpm lint:fix` run oxlint with the Ultracite core and vitest presets (`oxlint.config.ts`)
- `pnpm format` / `pnpm format:check` run oxfmt with the Ultracite preset (`oxfmt.config.ts`)
- `pnpm env:check` validates `.env.schema` and `web/.env.schema` against the current environment with varlock (silent when valid) and regenerates `src/env.d.ts` and `web/env.d.ts`; `pnpm env:types` then fails if either differs from what is staged, so a schema change cannot be pushed without its regenerated types
- `pnpm test` runs vitest over `src/**/*.test.ts`; tests use pi-ai's faux provider, never a real model, and local-directory sandboxes (`src/testing/sandboxes.ts`)
- `pnpm sandbox:build` builds the Docker sandbox images; `pnpm test:docker` runs the `*.docker.test.ts` integration tests against real containers (not part of `pnpm check` or the hooks)
- `pnpm test:integration` runs the `*.integration.test.ts` tests against real network services (the eglc MCP server); not part of `pnpm check` or the hooks
- `pnpm langfuse:up` / `pnpm langfuse:down` start and stop a local Langfuse (see Observability)
- `pnpm check` runs `env:check` and `env:types` first, then all of the above; run it after code changes
- `pnpm server` runs the HTTP server (`server.ts`, `SERVER_PORT`; Node strips the types), the only entry point to the agents; configuration is loaded and validated by varlock (see Configuration), and an echo model runs when no model is configured
- `pnpm dev` runs the server in watch mode plus the web console on `WEB_PORT` (3001). The server restarts when a file it imports changes (`node --watch`). Editing `.env` or `.env.schema` does not restart it, on purpose: varlock reads them outside the import graph, and watching them needs `--watch-path`, which Node supports only on macOS and Windows, so restart `pnpm dev` after changing the configuration
- `pnpm --filter web <script>` runs a web script
- `pnpm check` also runs `web`'s typecheck and tests

Lefthook (`lefthook.yml`) runs these as git hooks: pre-commit formats and lint-fixes staged files, then runs typecheck and tests; pre-push runs `pnpm check`. Fix failures instead of skipping hooks.

Some Ultracite rules are turned off in `oxlint.config.ts` because they conflict with Effect idioms; the reasons are in comments there.

## Configuration

`.env.schema` ([varlock](https://varlock.dev)) declares every environment variable with its type, default and sensitivity; values go in `.env` (git-ignored) or the shell, which wins.

- `server.ts` starts with `import "varlock/auto-load"`: invalid values stop startup with varlock's report. `@sensitive` values (API keys, the Langfuse secret) are redacted from console output.
- `src/config.ts` is the only module that reads varlock's `ENV`, and only `server.ts` imports it. Modules and layers take plain options, never `process.env`, so tests pass options directly. pi-ai still reads the API keys from `process.env` itself. A blank value in `.env` means unset, so a variable with a default gets it. From the shell (`X= pnpm server`), a blank is different: for a variable with a default it fails validation (unset the variable instead), and for one without a default it arrives as `""`, which `config.ts` treats as unset.
- To add a variable: declare it in `.env.schema`, run `pnpm env:check` (regenerates both `env.d.ts` files; stage them with the schema), then map it in `src/config.ts`.
- `web/.env.schema` imports only `WEB_PORT`, `API_URL` and `SERVER_PORT` from the root schema (`pick=`), so API keys and secrets never reach the Next process, and sets Next's `PORT` from `WEB_PORT`; a new variable the console needs must be added to that `pick` list; `web`'s scripts run Next through `varlock run`. `API_URL` defaults to the server's `SERVER_PORT`.
- `src/env.d.ts` and `web/env.d.ts` are generated (`processEnv=none`: only `ENV` is typed) and committed; do not edit them.

## Sandboxes

The user picks a Level (`none`, `shell` or `desktop`) when a conversation starts. Terms (Conversation, Seat, Workspace, Sandbox, Pause, ...) are defined in `GLOSSARY.md`. `Agents.create` (`src/agents/agents.ts`) records a Conversation with its Level in `WorkspaceDoc`; `Agents.open(id)` gives it a Seat in the caller's scope, with a Sandbox over its Workspace when the Level needs one.

- The sandbox is created before the conversation and recorded in its `SandboxDoc` (`src/sandbox/sandbox.ts`) in the creating commit. The harness `env` function reads that document on every tool call.
- `open` records the Sandbox in `SandboxDoc` before returning the Seat. When the Seat's scope closes, the conversation is aborted (its run and queued inputs stop), `SandboxDoc` is cleared, then the Sandbox is removed; the Workspace's files stay. Pause closes that scope.
- The sandbox choice also selects extensions (`extensionsFor`): `shell` adds pi's `CodingTools`, `desktop` adds those plus the desktop tools in `src/tools/desktop.ts`.
- `Workspaces` (`src/workspaces/workspaces.ts`) creates a conversation's Sandbox over its Workspace's files, which live in storage behind `WorkspaceStorage` (Docker volumes in `src/workspaces/docker-volume.ts`, mounted at `/workspace`; temporary directories in tests) and outlive the Sandbox. `WorkspaceDoc` records the Level and the storage reference. Capacity (`src/capacity.ts`) limits Seats, shells and desktops; terms are in `GLOSSARY.md`, the plan in `docs/plans/seats-and-workspaces.md`.
- Backend: local Docker (`src/sandbox/docker.ts`, images in `docker/sandbox/`; desktop is built `FROM` the shell image). Each container gets the `@earendil-works/pi-env` daemon and is reached through `RemoteExecutionEnv` over `docker exec -i`. The desktop image follows E2B's desktop template (XFCE, Xvfb, xdotool, scrot, noVNC on 6080) and publishes noVNC on a random localhost port (`SandboxInfo.vncUrl`).
- `Agents.layer({ saveScreenshot })` keeps every desktop screenshot on the host (`src/screenshots.ts`); `server.ts` saves them to `screenshots/<sandbox id>/001.png`, `002.png`, ... (git-ignored).
- microsandbox can replace Docker for `shell` on Apple Silicon or Linux with KVM; it does not run on this Intel Mac. A new backend only implements the `Sandboxes` service.

## Skills

`skills/<name>/SKILL.md` folders are [Agent Skills](https://agentskills.io/specification); `skills/README.md` explains the format for authors.

- `src/skills/` is split by concern: `source.ts` has `SkillSource`, where skill folders are stored: it only lists folders and reads files (`directory(root)` on the host, `memory(files)` for tests; S3 or a database would be another implementation). `format.ts` has the pure parts: the frontmatter `Schema`, the `skill` tool's text, the `skills` system prompt section, and `/skill:` parsing. `skills.ts` has the `Skills` service (`catalog`, `read`, `expand`, `install`) and the pi-durable extension, with a `skill` tool that reads through the source, so skills work without a sandbox.
- `Agents.layer` requires `Skills` (`Skills.directory("skills")` in `server.ts`, `Skills.none` by default in `fauxAgents`). Every new conversation reads the catalog again and records it in its `SkillsDoc` in the creating commit; the section and tool read that doc. A skill added to the source shows up in the next conversation, not in running ones. Sandboxed conversations also get a copy at `.skills/<name>/` (`Skills.install`, through the sandbox's `ExecutionEnv`), so bundled scripts run there. Problems are logged once, when the layer is built.
- `/skill:<name> <request>` as the prompt forces a skill (the web console's composer, or any API client; `Agents.expandSkill` on create, and on send against the conversation's own skills). The message becomes `<skill name="…">` + SKILL.md + `</skill>` + the request, which the console shows as a chip; an unknown skill is a 400 (`SkillNotFound`). `disable-model-invocation: true` hides a skill from the list.
- `/skill:<name>` anywhere else (after whitespace) is a hint, not a command: the message keeps the text and gains a `<skill_hints>` block with each mentioned skill's description, and the model decides whether to load it. Unknown names are left as text; hidden skills can be hinted. The console drops the block and shows the mentions as chips (`web/lib/skill-message.ts`); the composer autocompletes a mention at the cursor once `/s` is typed (`web/lib/skill-autocomplete.ts`).
- pi-durable passes sections as `sections` on the system message, beside `content`; the provider assembles the prompt. Tests that inspect the prompt read `sections`.
- A test loads `skills/` and fails on any problem, so edits to a skill are checked by `pnpm test`.

## MCP

`mcp.config.ts` lists the remote MCP servers (Streamable HTTP only; pi-mcp has no legacy SSE transport). `Agents.layer({ mcp })` connects them when the layer is built (`src/mcp.ts`, 10s timeout each) and closes them on teardown.

- Each tool becomes `mcp_<server>_<tool>` in one `mcp` extension that every conversation selects; calls run on the host, so chat conversations have them. MCP `isError` results reach the model as failed calls. MCP tools are not gated by approvals.
- A server that fails to connect is logged and reported `unavailable`; there is no reconnect, restart the server.
- A server entry can `transform` results before the model sees them: `src/mcp/eglc.ts` trims El Gato y La Caja's `get_wordpress_post` (the body three times as HTML plus WordPress metadata) to the article as text and its metadata, including `id_post`, the id `get_recommendations` takes.
- Tests use `fakeMcpServer` (`src/testing/mcp.ts`, pi-mcp's in-memory transport).

## Models

`src/models.ts` picks the model from the configuration (see `.env.schema` for defaults):

- `MODEL_PROVIDER`: `anthropic` (`ANTHROPIC_API_KEY`), `vercel` (Vercel AI Gateway, `AI_GATEWAY_API_KEY`), `openai` (`OPENAI_API_KEY`) or `ollama`. Unset, a set API key picks its provider, in that order. The schema checks each key's prefix (`sk-ant-`, `vck_`, `sk-`), so a mistyped key stops startup instead of failing on the first request.
- `MODEL_ID` overrides the default model: `claude-sonnet-5-5`, `alibaba/qwen3.8-27b`, `gpt-5.5`, `qwen3.5:4b-64k`.
- `OLLAMA_URL`: the Ollama server, `http://192.168.1.20:11434` by default (a LAN machine).

Ollama goes through its OpenAI-compatible API. The model's tools, vision, thinking and context size are read from Ollama's `/api/show` at startup; a model without `num_ctx` set is assumed to have a 4096-token context.

## Observability

Agents are traced with Effect spans, exported to Langfuse over OTLP.

- `src/tracing.ts`: pi-durable runs model requests and tool calls outside Effect, so a `tracing` extension (selected by every conversation) opens and closes their spans from `GenerationTask` and `ToolTask` hooks. Spans nest under the `Seat.ask` span of their conversation. Session ids are `<run id>-<conversation id>`: conversation ids restart with every process when storage is `MemoryStorage` (persistent SQLite storage reuses them), so the per-process run id still keeps runs apart. Attributes follow Langfuse's OpenTelemetry mapping (`langfuse.observation.*`); base64 data such as screenshots is replaced by its size.
- `src/langfuse.ts`: the OTLP exporter, enabled when both Langfuse keys are set (see `.env.schema`); one key alone stops startup. Without them spans go to Effect's default tracer, which exports nothing.
- `docker/langfuse/`: Langfuse's official compose file, bound to localhost. `pnpm langfuse:up` runs `init-env.ts` first, which writes random secrets and a headless-initialized org, project, API keys and user to `docker/langfuse/.env`, and the app's keys to `.env` (both git-ignored); it prints the login.
- Langfuse v4 serves observations at `/api/public/v2/observations` (pass `fields=core,basic,io,usage,model`); `/api/public/traces` is gone.

## Web console

- `server.ts` (`SERVER_PORT`, 4000 by default, bound to 127.0.0.1, no auth): `src/server/loopback.ts` answers 403 unless `Host`, and any `Origin` or `X-Forwarded-Host`, is loopback, so other websites (or DNS rebinding) cannot drive the API from a browser. `Conversations` with Capacity limits (`MAX_SEATS` 10, `MAX_SHELLS` 3, `MAX_DESKTOPS` 1; `src/capacity.ts`) and a `SHUTDOWN_TIMEOUT` (1s) graceful shutdown, so open SSE streams don't delay sandbox removal. Stopping the server removes all sandboxes. Conversations persist in a WAL SQLite file (`EFFECT_PI_DB`); tests use `MemoryStorage` instead.
- A conversation is `running` or `idle` (it has a Seat), `paused` or `archived`. `send` and `POST /conversations/:id/resume` give a paused one a Seat (claiming Capacity first; at a limit they fail with `CapacityExhausted` and its holders, and the console's Capacity dialog lets the person pick one to pause, then retries). `pause` frees a Seat at once when idle, otherwise after the current Run (`pausing`); a `send` or `resume` cancels that. `stop` aborts the Run and keeps the Seat. `archive` stops, pauses and deletes the Workspace's files; `unarchive` brings it back paused. After a restart every conversation is paused: startup aborts live work and clears `SandboxDoc` and waiting approvals.
- Approvals: `Agents.create({ approvals: "ask" | "auto" })` (default `auto`, create-payload `approvals`). Under `ask`, `withApproval` (src/approvals.ts) gates `write`, `edit`, `bash` and the desktop input tools; a call commits a `pending[key]` entry (`${conversationId}:${callId}`) on the conversation's `ApprovalDoc` and waits for `POST /conversations/:id/approvals` (`Seat.decide`, 404s on unknown keys). `"always"` flips the policy to `auto` and approves every other waiting call. A Stop first decides `stop` for waiting calls (`stopWaitingCalls`), so their aborted results say "Stopped by the user before approval.". `ConversationSummary.pendingApprovals` counts waits.
- `src/server/`:
  - `conversations.ts`: `Conversations`, which Conversations have Seats, one `Scope` per Seat. Run status comes from a watch on pi-durable's `LiveDoc`. A sweep runs every minute and pauses Seats idle for 30 minutes, never running ones.
  - `api.ts`: the `HttpApi` definition, shared with `web/` as `effect-pi/api`, with no runtime pi imports;
  - `handlers.ts`;
  - `faux.ts`: echo model, used when no model is configured.
- Events: `Agents.events(id)` wraps pi-durable's `watchEvents` and attaches its watch when the effect runs, not when the stream is run. The returned stream is single-use and must be run; interrupting it stops the watch. SSE sends one `AgentEvent` per message, `snapshot` first.
- `web/`: Next.js App Router, shadcn, and TanStack Query for REST (`web/lib/queries.ts`). A Zustand store (`web/lib/store.ts`) is fed by the pure `applyEvent` in `web/lib/conversation-state.ts`.
  - `web/lib/subscribe.ts` and `refcount.ts`: one shared SSE subscription per conversation id, stopped when its last caller unsubscribes. It reconnects after a drop and stops on a 404 (`ConversationNotFound`). Each subscription holds one of the browser's 6 connections per host.
  - `terminal.ts` and `vnc.ts`: pure helpers for the terminal text and the noVNC URL. `export.ts` builds the header menu's Markdown/JSON Lines downloads (`ansi` details supply terminal colors; tool cards stay clean).
  - Assistant text renders as markdown through `components/console/markdown.tsx` (react-markdown + remark-gfm, no raw HTML).
  - `format.ts` and `tool-summary.ts`: pure display helpers (cost/tokens/relative times, one-line tool-call summaries).
  - `GET /api/capabilities` lists skills and MCP servers; the sidebar's Capabilities sheet shows them, and clicking a skill puts `/skill:<name> ` in the composer (`web/lib/draft.ts`). `Composer` autocompletes `/skill:` in both text areas (`web/lib/skill-autocomplete.ts`).
  - Fonts come from the shadcn preset: IBM Plex Sans, IBM Plex Mono and Montserrat headings (`layout.tsx`, `--font-*` in `globals.css`).
  - The shell panel uses wterm (`@wterm/react`), output-only (no-op `onData`); the first write happens in `onReady` (earlier writes are dropped), and colors/font come from `.console-terminal` CSS variables; `html`/`body` are `h-dvh overflow-hidden` and only inner regions scroll.
- `web/next.config.ts` rewrites `/api/*` to `API_URL` with compression off, so SSE isn't buffered, and `experimental.proxyTimeout` at a day: the proxy otherwise cuts any stream silent for 30s, and the server sends no heartbeat.
