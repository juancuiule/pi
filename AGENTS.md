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
- `pnpm test:integration` runs the `*.integration.test.ts` tests against real network services (a live SearXNG for web search); not part of `pnpm check` or the hooks
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
- The Level also selects extensions (`extensionsFor`): `shell` adds pi's `CodingTools`, `desktop` adds those plus the desktop tools in `src/tools/desktop.ts`.
- Upgrade raises the Level (none, shell, desktop; never down). `Seat.upgrade` claims the new Level's resource, creates a Sandbox over the same Workspace files, records it, adds the Level's extensions with pi-durable's `configure`, then removes the old Sandbox and releases its claim; without a Seat (`Agents.upgrade`) it only records the Level. The person upgrades from the console (`POST /conversations/:id/upgrade`; at a limit, the Capacity dialog). The agent has an `upgrade_workspace` tool (`src/tools/workspace.ts`, gated by approvals under `ask`) whose claim waits for room: it is listed under `waiting` in `GET /api/capacity`, the console offers to pause a holder or cancel (`POST /conversations/:id/upgrade/cancel`, which ends the tool call with an error).
- Software (`src/sandbox/software.ts`): a catalog of what a person can add on top of a Level's image (Node.js, uv, Python data science, ImageMagick, FFmpeg; Google Chrome from `desktop` up and only on x64 hosts; each entry installs on its own), each with its install commands and what the agent's `workspace` section says. `WorkspaceDoc.software` records it in catalog order; it only grows. Docker builds one image per selection on first use, `FROM` the Level's image with one `RUN` layer per entry, tagged `effect-pi/sandbox-<kind>:sw-<hash of the base image id and Dockerfile>` and labelled `effect-pi.software`; builds are serialized. An Upgrade takes `{ level?, software? }` and reaches the higher Level and the union of software; adding software alone replaces the Sandbox at the same Level under the Seat's own claim (the Level claim has a scope of its own beside the Sandbox's). Decisions and measurements: `docs/plans/software.md`.
- `Workspaces` (`src/workspaces/workspaces.ts`) creates a conversation's Sandbox over its Workspace's files, which live in storage behind `WorkspaceStorage` (Docker volumes in `src/workspaces/docker-volume.ts`, mounted at `/workspace`; temporary directories in tests) and outlive the Sandbox. `WorkspaceDoc` records the Level and the storage reference. Capacity (`src/capacity.ts`) limits Seats, shells and desktops; terms are in `GLOSSARY.md`, the plan in `docs/plans/seats-and-workspaces.md`.
- An adapter that copies files in and out instead of mounting storage directly implements `WorkspaceStorage`'s optional `restore`, `save` and `evict` (`docker-volume` implements none). `Workspaces.sandbox` restores after creating the Sandbox, saves before removing it (skipped when the restore failed, since a half-populated mount must not overwrite a good snapshot) and evicts after; a failed save keeps the cache. `Workspaces.save` serializes saves of one Workspace, so a Run-end checkpoint and the closing save never overlap; `Conversations` forks one into the layer scope when a Run ends, and the release's save joins it through the lock.
- `s3-copied` (`src/workspaces/s3-copied.ts`, `WORKSPACE_STORAGE=s3-copied`, which needs `STORAGE=s3`) keeps the snapshot at `<id>/files.tar.zst` in the `workspaces` bucket: `save` tars /workspace inside the Sandbox (`tar cf`, leaving out `.attachments` and `.skills`, which every Seat copies in again), reads it out through `openBinaryReader`, zstd-compresses it on the host and uploads it; `restore` streams it back through `appendFile` and `tar xf`. The mounted Docker volume is only a cache: a populated one (an Upgrade's remount) skips the download, `evict` deletes it once the Sandbox is gone but tolerates one still mounted, and Archive's `remove` deletes the prefix and the cache. Tests run the same adapter over the local-directory Sandboxes and a directory `SandboxCache` (`src/testing/sandboxes.ts`).
- Backend: local Docker (`src/sandbox/docker.ts`, images in `docker/sandbox/`; desktop is built `FROM` the shell image). Each container gets the `@earendil-works/pi-env` daemon and is reached through `RemoteExecutionEnv` over `docker exec -i`. The desktop image follows E2B's desktop template (XFCE, Xvfb, xdotool, scrot, noVNC on 6080) and publishes noVNC on a random localhost port (`SandboxInfo.vncUrl`); the console embeds it through `/desktop-frame`, a same-origin page whose own `frame-src http://127.0.0.1:*` lets the loopback port load while artifact pages stay under `frame-src 'self'`.
- The console's Shell tab is a live PTY in the Sandbox (`Sandboxes.shell` wrapped by `shellSession` in `src/sandbox/shell-session.ts`, surfaced as `Seat.shell`), separate from `env`: `bash -l` runs through the Docker Engine API over the Unix socket (exec create/start/resize; the CLI cannot resize an exec). It reaches the console over `GET /api/conversations/:id/shell`, a WebSocket upgrade guarded by `loopbackOnly` like every route. The PTY is a session owned by the Sandbox's lifetime (`machine.scope`): sockets attach and detach — each attach replays recent scrollback then follows live, a later attach's size wins — and only closing the seat's scope kills the PTY's process group. The local test Sandboxes run it under `python3 pty.spawn`.
- `Agents.layer({ saveScreenshot })` keeps every desktop screenshot on the host (`src/screenshots.ts`); `server.ts` saves them to `screenshots/<sandbox id>/001.png`, `002.png`, ... (git-ignored).
- microsandbox can replace Docker for `shell` on Apple Silicon or Linux with KVM; it does not run on this Intel Mac. A new backend only implements the `Sandboxes` service.

## Skills

`skills/<name>/SKILL.md` folders are [Agent Skills](https://agentskills.io/specification); `skills/README.md` explains the format for authors.

- `src/skills/` is split by concern: `source.ts` has `SkillSource`, where skill folders are stored: it lists, reads, writes (`put`) and deletes (`remove`) folders in two namespaces. `builtin` is the repository's skills, converged by `convergeBuiltin`; `org` is the writable overlay that `PUT /api/skills/:name` and the agent's `skill_save` write and that shadows builtin. Every folder carries its `origin` — `builtin`, `org`, or `overridden` (an org folder shadowing a builtin). `directory(root, orgRoot)` keeps org skills outside the checkout — `SKILLS_ORG_DIR`, `data/skills` by default, beside the database; a legacy `skills/org/` is migrated into it on boot, a legacy folder losing to an org one of the same id; `memory(files)` is for tests; `s3(store, bucket)` holds both namespaces under the `skills` bucket. `format.ts` has the pure parts: the frontmatter `Schema`, the `skill` tool's text, the `skills` system prompt section, and `/skill:` parsing. `skills.ts` has the `Skills` service — `catalog`, `read`, `expand`, `install`, and the validated write side `save` (a whole folder at once, `created`/`updated`/`shadowed`), `remove` (the org copy: `removed`/`reverted`/`unchanged`/`missing`) and `folder` — and the pi-durable extension, with a `skill` tool that reads through the source, so skills work without a sandbox.
- The extension's `skill_save` and `skill_delete` let the agent author skills: both are `withApproval` tools (they wait for the person under the `ask` policy), and a write reaches the conversation's settings through the hooks in `Agents.layer` — a created skill turns on in that conversation, an edited one that is on gets its `.skills/` copy refreshed, a deleted one turns off, and a reverted one falls back to the builtin. The `skills` extension is on by default — it carries these write tools even with no skills — and turning it off is a durable per-conversation choice. Under the `auto` approval policy `skill_save` and `skill_delete` run without per-call approval; `ask` is the control for gating writes.
- `Agents.layer` requires `Skills` (`Skills.layer` over the `SkillSource` `server.ts` picks: `s3` under `STORAGE=s3`, `directory(SKILLS_DIR, SKILLS_ORG_DIR)` otherwise; `Skills.none` by default in `fauxAgents`). Every new conversation reads the catalog again and records it in its `SkillsDoc` in the creating commit; the section and tool read that doc. A skill added to the source shows up in the next conversation, not in running ones; `PATCH /api/conversations/:id/agent` accepts `{ refreshSkills: "all" }` (or a list of names) to re-read them into a running conversation, which the console exposes as "Re-sync skills". Sandboxed conversations also get a copy at `.skills/<name>/` (`Skills.install`, through the sandbox's `ExecutionEnv`), so bundled scripts run there. Problems are logged once, when the layer is built.
- `GET /api/skills/:name` returns a folder's provenance, its text files and the names of its binary ones; `DELETE /api/skills/:name` removes the org copy — gone, or reverted to the builtin it shadowed (a builtin-only skill is a 204 no-op). The console edits skills on `/skills`, which shows each skill's provenance and mounts the folder editor (`web/components/console/skill-editor.tsx`).
- `/skill:<name> <request>` as the prompt forces a skill (the web console's composer, or any API client; `Agents.expandSkill` on create, and on send against the conversation's own skills). The message becomes `<skill name="…">` + SKILL.md + `</skill>` + the request, which the console shows as a chip; an unknown skill is a 400 (`SkillNotFound`). `disable-model-invocation: true` hides a skill from the list.
- `/skill:<name>` anywhere else (after whitespace) is a hint, not a command: the message keeps the text and gains a `<skill_hints>` block with each mentioned skill's description, and the model decides whether to load it. Unknown names are left as text; hidden skills can be hinted. The console drops the block and shows the mentions as chips (`web/lib/skill-message.ts`); the composer autocompletes a mention at the cursor once `/s` is typed (`web/lib/skill-autocomplete.ts`).
- pi-durable passes sections as `sections` on the system message, beside `content`; the provider assembles the prompt. Tests that inspect the prompt read `sections`.
- A test loads `skills/` and fails on any problem, so edits to a skill are checked by `pnpm test`.

## Attachments

Files people send with messages (TXT, Markdown, HTML, CSV/TSV, text PDFs, PNG/JPEG/WebP); the decisions are in `docs/plans/attachments.md`, the term in `GLOSSARY.md`.

- `src/attachments/`: `format.ts` is the pure part (classifying an upload by name, reported type and signature; decoding text; numbered pages and lines; the message's `<attachment>` blocks; `read_attachment` ranges and `search_attachment` matches). `html.ts` turns HTML into text with htmlparser2, running and fetching nothing. `table.ts` parses CSV/TSV (quoted fields, delimiter detection) into one line per row, cells as written, so line numbers are row numbers. `extract.ts` prepares a file (unpdf, sharp) and runs only inside a worker thread (`worker.ts`, with a timeout and a memory limit). `store.ts` has the `BlobStore` (a local directory, `ATTACHMENTS_DIR`) and the `attachments` table in the `EFFECT_PI_DB` file. `attachments.ts` has the `Attachments` service and the `attachments` extension.
- Upload: `POST /api/attachments` (multipart `file`, optional `conversation`) checks and prepares the file before answering; a refused file keeps nothing (`AttachmentRefused`), a file over `ATTACHMENT_MAX_FILE_MB` is cut off while it streams (413). Without `conversation` the upload is staged and `create`'s `attachments` claims it, all or none; `send`'s `attachments` only takes the conversation's own unsent uploads. Ids are random; anything outside its scope is `AttachmentNotFound`. Unsent uploads expire (`ATTACHMENT_UNSENT_TTL`); sent ones stay through Pause and Archive. `GET /api/attachments/:id/original?conversation=` always downloads (`nosniff`, CSP sandbox).
- A message is the typed text (the only part `/skill:` reads), then one block per file: document text inline, whole lines, up to `ATTACHMENT_INLINE_CHARS` per message, and a note saying what is left; images follow as image content when the model takes them. PDF pages without text are listed as needing OCR (statuses `partial`, `needs_ocr`); there is no OCR yet. Tables are cited by row; reads from further down repeat the header, and the prompt section tells the agent to compute totals with the shell (or, at Level `none`, to say it cannot) instead of estimating.
- The `attachments` extension is locked on (its tools too) and selected by every conversation: `read_attachment` and `search_attachment` run on the host, at every Level, over the conversation's sent attachments. Shell and desktop Sandboxes also get each sent original at `/workspace/.attachments/<id>/<name>`.
- Traces carry the size of attachment text, not the text, unless `TRACE_ATTACHMENT_TEXT=true`.
- The console uploads a file when it is added to the composer (picker, drop, paste; `web/lib/use-draft-attachments.ts`), and shows sent files as chips (`web/lib/attachments.ts` parses the blocks) that open a viewer (`attachment-viewer.tsx`): details and warnings, the image, a table, the text the agent reads, or a PDF's pages. PDF pages are drawn as WebP images by the server (`GET /api/attachments/:id/pages/:page`, `renderPdfPage` in the worker with `@napi-rs/canvas`, kept after the first time), so the browser never opens an uploaded PDF itself.
- Tests: `fauxAgents` provides temporary `Attachments` (`attachmentLimits`, and `vision: false` for a model without images); `src/testing/files.ts` builds PDFs and images.

## Artifacts

Sandboxed HTML pages the agent writes for the person; the decisions are in `docs/plans/artifacts.md`, the term in `GLOSSARY.md`.

- `src/artifacts/`: `store.ts` has the `artifacts` and `artifact_versions` tables in `EFFECT_PI_DB` (an in-memory variant for tests). `artifacts.ts` has the `Artifacts` service (`create`, `update`, `view`, `html`, `list`, `remove`) and the `artifacts` extension with its prompt section and `artifact_create`/`artifact_update` tools, locked on at every Level. `refs.ts` parses a page's external references with htmlparser2; `create`/`update` refuse anything the render CSP would block (`ArtifactRefused`), so the model reads the refusal instead of shipping a silently broken page. `domains.ts` has the `TrustedDomains` service and host matching.
- `GET /api/artifacts/:id/render?v=` serves a version with a strict CSP: inline scripts only plus same-origin libraries (`GET /api/artifact-libs/<file>` allowlist), no frames/forms/connections, `img-src` for `data:`, `blob:`, `'self'` and the person's Trusted domains. The console embeds it in `<iframe sandbox="allow-scripts">` and guards navigation.
- A page may only load images that are same-origin, inline (`data:`/`blob:`), or from a **Trusted domain** — a host the person lists under Settings → Trusted domains (`GET/POST/DELETE /api/trusted-domains`, the `trusted_domains` table). Entries are normalized hosts (`cdn.example.com`, `*.example.com` for subdomains, either with `:port`); the render CSP and the prompt section read the live list, so a domain added mid-conversation applies on the next call. Other remote loads (scripts, styles, fonts, media, frames) are always refused — the page fetches nothing else.
- Tests: `fauxAgents` provides `TrustedDomains.memory()` and `Artifacts.temporary(trusted)` (`trustedDomains` option); `src/artifacts/domains.test.ts` and `refs.test.ts` cover normalization/matching and the page scan.

## MCP

`mcp.config.ts` lists the remote MCP servers (Streamable HTTP only; pi-mcp has no legacy SSE transport). `Agents.layer({ mcp })` connects them when the layer is built (`src/mcp.ts`, 10s timeout each) and closes them on teardown.

- Each tool becomes `mcp_<server>_<tool>` in its server's `mcp-<server>` extension, which every conversation selects and can switch off as a whole; calls run on the host, so chat conversations have them. MCP `isError` results reach the model as failed calls. MCP tools are not gated by approvals.
- A server that fails to connect is logged and reported `unavailable`; there is no reconnect, restart the server.
- A server entry can `transform` results before the model sees them — trim a verbose payload to the fields the model needs (see `mcp.test.ts` for the shape).
- Tests use `fakeMcpServer` (`src/testing/mcp.ts`, pi-mcp's in-memory transport).

## Web search

`web_search` answers from a self-hosted SearXNG (`docker/searxng/`, `pnpm searxng:up` / `pnpm searxng:down`), a metasearch engine that forwards the query to several public engines and merges their results — the server only ever talks to SearXNG. The tool returns titles, urls and snippets, never page contents.

- Only when `SEARXNG_URL` is set (`src/config.ts`, `server.ts`): unset, there is no `web` extension, tool or prompt section at all, so `pnpm dev` and tests need no SearXNG. `docker/searxng/settings.yml` picks the engines (the ones measured to answer from this host), turns `search.formats` json on (off by default; a disabled format answers 403), and turns the bot limiter off — a private instance.
- `src/web-search/` is split by concern: `searxng.ts` is the client (one GET to `/search?format=json` with `WEB_SEARCH_TIMEOUT`, decoded with a Schema that keeps only the fields read), `format.ts` the pure part (HTML stripped from snippets, dedupe by url minus fragment, non-http urls dropped, the `<search_results>` text, `details.sources` for the console, the prompt section), `web-search.ts` the `WebSearch` service and the `web` extension. `WebSearch.fake` answers canned outcomes in tests (`fauxAgents({ webSearch })`).
- The tool is gated by `withApproval`: under `ask` the person sees the query before it leaves the server, since it reaches external engines. Results are untrusted web text — the prompt section says `<search_results>` is data, never instructions, and to end an answer that used them with the sources as Markdown links. The console lists the same `details.sources` as links.
- Load is bounded because every search leaves from this host: a semaphore caps simultaneous searches (`WEB_SEARCH_CONCURRENCY`, 4) and identical searches inside 10 minutes are answered from a cache. An empty result is an error only when every engine went unresponsive — the message names them, so the model does not read it as "nothing exists".
- `web` is installed at every Level, beside attachments and artifacts: the tool runs on the host. Not locked — a conversation can switch it off from the Capabilities sheet.

## Models

`src/models.ts` picks the model from the configuration (see `.env.schema` for defaults):

- `MODEL_PROVIDER`: `anthropic` (`ANTHROPIC_API_KEY`), `vercel` (Vercel AI Gateway, `AI_GATEWAY_API_KEY`), `openai` (`OPENAI_API_KEY`) or `ollama`. Unset, a set API key picks its provider, in that order. The schema checks each key's prefix (`sk-ant-`, `vck_`, `sk-`), so a mistyped key stops startup instead of failing on the first request.
- `MODEL_ID` overrides the default model: `claude-sonnet-5-5`, `alibaba/qwen3.8-27b`, `gpt-5.5`, `qwen3.5:4b-64k`.
- `OLLAMA_URL`: the Ollama server, `http://192.168.1.20:11434` by default (a LAN machine).

A conversation keeps the model it was created with. When a Seat opens and this server does not have that model (the configuration changed since), `Agents.open` moves the conversation to the configured one and records an `app.settings` entry `by: "server"`, instead of every request failing with `no_model`.

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
- Questions: the `ask_user` tool (`src/tools/questions.ts`, the `questions` extension, every Level) shows the person one to four questions, each single or multiple choice, always with an "Other" text field. It waits like an approval, whatever the policy: an `ApprovalDoc` entry marked `question` (`waitForPerson` in `src/approvals.ts`), so Stop, restarts and `pendingApprovals` cover it, and `always` or switching to `auto` never decides it. `POST /conversations/:id/answers` (`Seat.answer`) sends `answers`, or skips without them; the model gets each answer next to its question. The console renders the call as a form (`question-form.tsx`, `web/lib/questions.ts`).
- `src/server/`:
  - `conversations.ts`: `Conversations`, which Conversations have Seats, one `Scope` per Seat. Run status comes from a watch on pi-durable's `LiveDoc`. A sweep runs every minute and pauses Seats idle for 30 minutes, never running ones.
  - `api.ts`: the `HttpApi` definition, shared with `web/` as `effect-pi/api`, with no runtime pi imports;
  - `handlers.ts`;
  - `faux.ts`: echo model, used when no model is configured.
- Events: `Agents.events(id)` wraps pi-durable's `watchEvents` and attaches its watch when the effect runs, not when the stream is run. The returned stream is single-use and must be run; interrupting it stops the watch. SSE sends one `ConversationEvent` per message (`src/conversation-events.ts`), `snapshot` first; the snapshot adds `unanswered`, the user messages whose run ended without an answer (read from storage's submissions), and live `submission` events add to it. The console shows the reason under the message (`web/lib/unanswered-note.ts`). pi-durable emits `task_failed` only for faulted or orphaned tasks, so a generation that fails (`no_model`, `model_error`) shows only this way.
- `web/`: Next.js App Router, shadcn, and TanStack Query for REST (`web/lib/queries.ts`). A Zustand store (`web/lib/store.ts`) is fed by the pure `applyEvent` in `web/lib/conversation-state.ts`.
  - `web/lib/subscribe.ts` and `refcount.ts`: one shared SSE subscription per conversation id, stopped when its last caller unsubscribes. It reconnects after a drop and stops on a 404 (`ConversationNotFound`). Each subscription holds one of the browser's 6 connections per host.
  - `terminal.ts` and `vnc.ts`: pure helpers for the terminal text and the noVNC URL. `export.ts` builds the header menu's Markdown/JSON Lines downloads (`ansi` details supply terminal colors; tool cards stay clean).
  - Assistant text renders as markdown through `components/console/markdown.tsx` (react-markdown + remark-gfm, no raw HTML); fenced code becomes a `CodeBlock` with syntax highlighting.
  - The agent's steps — thinking, tool calls, the Working/Resuming line — are `Trace` lines (`components/ui/trace.tsx`, `code-block.tsx`, `hooks/use-highlighted-code.ts` are shadcn-generated; `tool-call.tsx` maps a call's approval/error/running state onto them, and tool output is highlighted as `ansi` so terminal colors survive).
  - `format.ts` and `tool-summary.ts`: pure display helpers (cost/tokens/relative times, one-line tool-call summaries).
  - `GET /api/capabilities` lists every installed extension (its tools, which need approval, its prompt sections, hooks, and the Levels that select it), skills and MCP servers; `GET /conversations/:id/agent` is one conversation's settings (extensions with their tools, skills, approval policy; what the Level allows, what is locked) and `PATCH` changes them (`src/agents/settings.ts` holds the rules; one commit reads and writes them, so concurrent changes cannot undo each other; changes apply from the next model request; an Upgrade keeps them; `POST .../agent/reset` goes back to the Level's defaults, keeping the approval policy). Each change, and each Upgrade, is recorded as an `app.settings` entry the model never sees (the console shows it in the transcript) and as an `event` observation on the conversation's Langfuse session. The create payload's `settings` changes a new conversation's defaults. The sidebar's Capabilities sheet shows and switches them, and New conversation has a Customize section, and clicking a skill puts `/skill:<name> ` in the composer (`web/lib/draft.ts`). `Composer` autocompletes `/skill:` in both text areas (`web/lib/skill-autocomplete.ts`).
  - Fonts come from the shadcn preset: IBM Plex Sans, IBM Plex Mono and Montserrat headings (`layout.tsx`, `--font-*` in `globals.css`).
  - The shell panel uses wterm (`@wterm/react`), output-only (no-op `onData`); the first write happens in `onReady` (earlier writes are dropped), and colors/font come from `.console-terminal` CSS variables; `html`/`body` are `h-dvh overflow-hidden` and only inner regions scroll.
- `web/next.config.ts` rewrites `/api/*` to `API_URL` with compression off, so SSE isn't buffered, and `experimental.proxyTimeout` at a day: the proxy otherwise cuts any stream silent for 30s, and the server sends no heartbeat.

## Commits

- Commit your work when the task is done — on a feature branch, not the default branch. Stage the files you changed by path, never `git add -A`/`git add .`; changes that are not yours stay uncommitted unless the person asks for them.

## Pull requests

- After opening a PR, generate an explain-diff walkthrough of the branch's diff against its base (the `explain-diff` skill turns it into a self-contained HTML page) and report where the reviewer can read it, so the explanation sits beside the PR.
- When the diff changes runtime behavior a static explanation can't make intuitive — lifecycles, concurrency, protocols, migrations, multi-step flows — also build a micro-world (Geoffrey Litt, "Understanding is the new bottleneck"): a throwaway interactive page or script the reviewer drives, triggering events and watching state move, saved next to the explainer. It is a review artifact, not shipped code; skip it for diffs a reader can fully get from prose.
