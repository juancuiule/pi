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

- `pnpm start [--sandbox none|shell|desktop] [prompt]` runs `index.ts` (Node strips the types; a faux model is used when `ANTHROPIC_API_KEY` is unset)
- `pnpm typecheck` runs `tsc` (TypeScript 7)
- `pnpm lint` / `pnpm lint:fix` run oxlint with the Ultracite core and vitest presets (`oxlint.config.ts`)
- `pnpm format` / `pnpm format:check` run oxfmt with the Ultracite preset (`oxfmt.config.ts`)
- `pnpm test` runs vitest over `src/**/*.test.ts`; tests use pi-ai's faux provider, never a real model, and local-directory sandboxes (`src/testing/sandboxes.ts`)
- `pnpm sandbox:build` builds the Docker sandbox images; `pnpm test:docker` runs the `*.docker.test.ts` integration tests against real containers (not part of `pnpm check` or the hooks)
- `pnpm check` runs all of the above; run it after code changes

Lefthook (`lefthook.yml`) runs these as git hooks: pre-commit formats and lint-fixes staged files, then runs typecheck and tests; pre-push runs `pnpm check`. Fix failures instead of skipping hooks.

Some Ultracite rules are turned off in `oxlint.config.ts` because they conflict with Effect idioms; the reasons are in comments there.

## Sandboxes

The user picks a sandbox when a conversation starts: `Agents.start({ sandbox: "none" | "shell" | "desktop" })` in `src/agents.ts`.

- The sandbox is created before the conversation and recorded in its `SandboxDoc` (`src/sandbox/sandbox.ts`) in the creating commit. The harness `env` function reads that document on every tool call; subagents inherit their owner's sandbox through `conversationCreated`.
- The sandbox is removed when the scope around `start` closes.
- The sandbox choice also selects extensions (`extensionsFor`): `shell` adds pi's `CodingTools`, `desktop` adds those plus the desktop tools in `src/tools/desktop.ts`.
- Backend: local Docker (`src/sandbox/docker.ts`, images in `docker/sandbox/`). Each container gets the `@earendil-works/pi-env` daemon and is reached through `RemoteExecutionEnv` over `docker exec -i`. The desktop image follows E2B's desktop template (XFCE, Xvfb, xdotool, scrot, noVNC on 6080) and publishes noVNC on a random localhost port (`SandboxInfo.vncUrl`).
- microsandbox can replace Docker for `shell` on Apple Silicon or Linux with KVM; it does not run on this Intel Mac. A new backend only implements the `Sandboxes` service.
