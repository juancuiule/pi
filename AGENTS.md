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

When using these packages, read the package's `README.md`, `src/` and `test/` for real API usage instead of guessing. `packages/durable/docs/` has additional documentation.

@repos/pi/AGENTS.md contains rules for contributors to the pi repo itself. Those rules do not apply to this project.

To update: `git subtree pull --prefix=repos/pi https://github.com/earendil-works/pi.git v<version> --squash` (currently `v1.1.0`)

## Commands

Use pnpm, never npm or yarn.

- `pnpm start [--sandbox none|shell|desktop] [prompt]` runs `index.ts` with `.env` loaded (Node strips the types); the model comes from the environment, see Models below, and a faux model runs when none is configured
- `pnpm typecheck` runs `tsc` (TypeScript 7)
- `pnpm lint` / `pnpm lint:fix` run oxlint with the Ultracite core and vitest presets (`oxlint.config.ts`)
- `pnpm format` / `pnpm format:check` run oxfmt with the Ultracite preset (`oxfmt.config.ts`)
- `pnpm test` runs vitest over `src/**/*.test.ts`; tests use pi-ai's faux provider, never a real model, and local-directory sandboxes (`src/testing/sandboxes.ts`)
- `pnpm sandbox:build` builds the Docker sandbox images; `pnpm test:docker` runs the `*.docker.test.ts` integration tests against real containers (not part of `pnpm check` or the hooks)
- `pnpm langfuse:up` / `pnpm langfuse:down` start and stop a local Langfuse (see Observability)
- `pnpm check` runs all of the above; run it after code changes

Lefthook (`lefthook.yml`) runs these as git hooks: pre-commit formats and lint-fixes staged files, then runs typecheck and tests; pre-push runs `pnpm check`. Fix failures instead of skipping hooks.

Some Ultracite rules are turned off in `oxlint.config.ts` because they conflict with Effect idioms; the reasons are in comments there.

## Sandboxes

The user picks a sandbox when a conversation starts: `Agents.start({ sandbox: "none" | "shell" | "desktop" })` in `src/agents.ts`.

- The sandbox is created before the conversation and recorded in its `SandboxDoc` (`src/sandbox/sandbox.ts`) in the creating commit. The harness `env` function reads that document on every tool call; subagents inherit their owner's sandbox through `conversationCreated`.
- The sandbox is removed when the scope around `start` closes.
- The sandbox choice also selects extensions (`extensionsFor`): `shell` adds pi's `CodingTools`, `desktop` adds those plus the desktop tools in `src/tools/desktop.ts`.
- Backend: local Docker (`src/sandbox/docker.ts`, images in `docker/sandbox/`). Each container gets the `@earendil-works/pi-env` daemon and is reached through `RemoteExecutionEnv` over `docker exec -i`. The desktop image follows E2B's desktop template (XFCE, Xvfb, xdotool, scrot, noVNC on 6080) and publishes noVNC on a random localhost port (`SandboxInfo.vncUrl`).
- `Agents.layer({ saveScreenshot })` keeps every desktop screenshot on the host (`src/screenshots.ts`); `index.ts` saves them to `screenshots/<sandbox id>/001.png`, `002.png`, ... (git-ignored).
- microsandbox can replace Docker for `shell` on Apple Silicon or Linux with KVM; it does not run on this Intel Mac. A new backend only implements the `Sandboxes` service.

## Skills

`skills/<name>/SKILL.md` folders are [Agent Skills](https://agentskills.io/specification); `skills/README.md` explains the format for authors.

- `src/skills.ts` loads and validates them (`loadSkills`), lists names and descriptions in a `skills` system prompt section, and adds a `skill` tool that returns `SKILL.md` or a bundled file from the host, so skills work without a sandbox. `Agents.layer({ skills })` installs them; sandboxed conversations also get a copy at `.skills/<name>/` (`installSkills`, through the sandbox's `ExecutionEnv`), so bundled scripts run there.
- `/skill:<name> <request>` as the prompt forces a skill (`expandSkillCommand`); `disable-model-invocation: true` hides a skill from the list.
- pi-durable passes sections as `sections` on the system message, beside `content`; the provider assembles the prompt. Tests that inspect the prompt read `sections`.
- A test loads `skills/` and fails on any problem, so edits to a skill are checked by `pnpm test`.

## Models

`src/models.ts` picks the model from environment variables:

- `MODEL_PROVIDER`: `anthropic` (`ANTHROPIC_API_KEY`), `vercel` (Vercel AI Gateway, `AI_GATEWAY_API_KEY`) or `ollama`. Unset, a set API key picks its provider.
- `MODEL_ID` overrides the default model: `claude-sonnet-5-5`, `anthropic/claude-sonnet-5.5`, `qwen3.5:4b-64k`.
- `OLLAMA_URL`: the Ollama server, `http://192.168.1.20:11434` by default (a LAN machine).

Ollama goes through its OpenAI-compatible API. The model's tools, vision, thinking and context size are read from Ollama's `/api/show` at startup; a model without `num_ctx` set is assumed to have a 4096-token context.

## Observability

Agents are traced with Effect spans, exported to Langfuse over OTLP.

- `src/tracing.ts`: pi-durable runs model requests and tool calls outside Effect, so a `tracing` extension (selected by every conversation) opens and closes their spans from `GenerationTask` and `ToolTask` hooks. Spans nest under the `AgentConversation.ask` span of their conversation; a subagent's spans go under the tool call that created it, in the same Langfuse session. Attributes follow Langfuse's OpenTelemetry mapping (`langfuse.observation.*`); base64 data such as screenshots is replaced by its size.
- `src/langfuse.ts`: the OTLP exporter, enabled when `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY` are set (`LANGFUSE_BASE_URL` defaults to `http://localhost:3000`). Without them spans go to Effect's default tracer, which exports nothing.
- `docker/langfuse/`: Langfuse's official compose file, bound to localhost. `pnpm langfuse:up` runs `init-env.ts` first, which writes random secrets and a headless-initialized org, project, API keys and user to `docker/langfuse/.env`, and the app's keys to `.env` (both git-ignored); it prints the login.
- Langfuse v4 serves observations at `/api/public/v2/observations` (pass `fields=core,basic,io,usage,model`); `/api/public/traces` is gone.
