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

- `npm start` runs `index.ts` (Node strips the types; a faux model is used when `ANTHROPIC_API_KEY` is unset)
- `npm run typecheck` runs `tsc`; run it after code changes
