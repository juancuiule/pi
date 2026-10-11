import { defineConfig } from "oxlint";
import core from "ultracite/oxlint/core";
import vitest from "ultracite/oxlint/vitest";

export default defineConfig({
  extends: [core, vitest],
  // Vendored source is read-only reference material, see AGENTS.md
  ignorePatterns: [...(core.ignorePatterns ?? []), "repos/**"],
  rules: {
    // Rules that conflict with the idioms in repos/effect/LLMS.md:
    // `Effect.gen(function* () {...})` takes an anonymous generator
    "func-names": "off",
    // A service and its tagged errors live in the same module
    "max-classes-per-file": "off",
    // Service interfaces are written with method signatures
    "typescript/method-signature-style": "off",
    // Misfires on `Schema.TaggedError<T>()("Tag", {...})` class factories
    "unicorn/throw-new-error": "off",
    // Keeps natural key order such as `{ try, catch }` and `{ type, content }`
    "sort-keys": "off",
  },
});
