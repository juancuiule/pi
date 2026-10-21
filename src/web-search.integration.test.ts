// One real search against the SearXNG at SEARXNG_URL (`pnpm searxng:up`), through the same WebSearch layer the
// server wires. `pnpm test:integration`.
import { Context, Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import { formatSearch } from "./web-search/format.ts";
import { WebSearch } from "./web-search/web-search.ts";

const url = process.env.SEARXNG_URL;

describe("web search against SearXNG", () => {
  it.skipIf(url === undefined || url === "")(
    "runs one real search and formats its outcome",
    async () => {
      const layer = WebSearch.searxng({
        url: url as string,
        timeoutMs: 10_000,
        concurrency: 4,
        language: "auto",
        safeSearch: 1,
      });
      const outcome = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const context = yield* Layer.build(layer);
            const webSearch = Context.get(context, WebSearch);
            return yield* webSearch.search("Effect TS release");
          })
        )
      );

      expect(outcome.results.length).toBeGreaterThan(0);
      for (const result of outcome.results) {
        expect(result.url).toMatch(/^https?:\/\//u);
        expect(result.title).not.toBe("");
      }
      const text = formatSearch("Effect TS release", outcome);
      expect(text).toContain('<search_results query="Effect TS release">');
      expect(text).toContain("[1]");
    },
    30_000
  );
});
