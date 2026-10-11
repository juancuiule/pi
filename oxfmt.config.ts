import { defineConfig } from "oxfmt";
import ultracite from "ultracite/oxfmt";

export default defineConfig({
  ...ultracite,
  // Vendored source is read-only reference material, see AGENTS.md
  ignorePatterns: [
    ...(ultracite.ignorePatterns ?? []),
    "repos/**",
    "web/.next/**",
  ],
});
