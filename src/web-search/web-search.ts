// Web search for the agent: a `web_search` tool answered by a self-hosted SearXNG instance (docker/searxng/), which
// forwards the query to several public engines and merges what they return. The tool runs on the host, so every
// conversation has it whatever its Level; under the `ask` approval policy the person approves the query first. The
// service bounds the load the instance puts on the engines: a semaphore caps concurrent searches and identical
// searches inside ten minutes are answered from a cache.
import { Type } from "@earendil-works/pi-ai";
import {
  defineExtension,
  defineTool,
  section,
} from "@earendil-works/pi-durable";
import type { Extension } from "@earendil-works/pi-durable";
import { Context, Effect, Layer, Semaphore } from "effect";

import { withApproval } from "../approvals.ts";
import {
  detailsOf,
  formatSearch,
  outcomeOf,
  QUERY_MAX_CHARS,
  webSearchSection,
} from "./format.ts";
import type { RawResponse, SearchOutcome } from "./format.ts";
import { searxngSearch, WebSearchError } from "./searxng.ts";
import type { SearchPaging, SearxngOptions } from "./searxng.ts";

export { WebSearchError } from "./searxng.ts";
export type { SearchOutcome } from "./format.ts";

const COUNT_DEFAULT = 5;
const COUNT_MAX = 10;
const PAGE_MAX = 3;
const CACHE_TTL_MS = 10 * 60 * 1000;

/** The search's options: how many results, a recency window, a result page. */
export interface SearchOptions {
  readonly count?: number | undefined;
  readonly recency?: "day" | "month" | "year" | undefined;
  readonly page?: number | undefined;
}

const normalize = (options: SearchOptions) => ({
  count:
    options.count === undefined ? COUNT_DEFAULT : Math.trunc(options.count),
  recency: options.recency,
  page: options.page === undefined ? 1 : Math.trunc(options.page),
});

const cacheKey = (query: string, options: SearchOptions): string =>
  JSON.stringify([query, options.count, options.recency, options.page]);

export class WebSearch extends Context.Service<
  WebSearch,
  {
    /**
     * Run `query` and return the cleaned outcome: numbered results (at most `count`), direct answers first,
     * spelling suggestions when nothing was found. Fails `WebSearchError` when no engine answered.
     */
    readonly search: (
      query: string,
      options?: SearchOptions
    ) => Effect.Effect<SearchOutcome, WebSearchError>;
  }
>()("effect-pi/web-search/WebSearch") {
  /**
   * A WebSearch over a raw query function: the cache and the semaphore live here, and an empty result with every
   * engine unresponsive becomes a `WebSearchError` naming them, so the model does not read it as "nothing exists".
   */
  static readonly layer = (options: {
    readonly query: (
      query: string,
      paging: SearchPaging
    ) => Effect.Effect<RawResponse, WebSearchError>;
    readonly concurrency?: number | undefined;
    readonly cacheTtlMs?: number | undefined;
  }) =>
    Layer.effect(
      WebSearch,
      Effect.gen(function* () {
        const slots = yield* Semaphore.make(options.concurrency ?? 4);
        const ttl = options.cacheTtlMs ?? CACHE_TTL_MS;
        const cache = new Map<
          string,
          { readonly at: number; readonly outcome: SearchOutcome }
        >();
        return WebSearch.of({
          search: Effect.fnUntraced(function* (
            query: string,
            searchOptions: SearchOptions = {}
          ) {
            const paging = normalize(searchOptions);
            const trimmed = query.trim();
            if (trimmed === "") {
              return yield* new WebSearchError({
                message: "The query is empty.",
              });
            }
            if (trimmed.length > QUERY_MAX_CHARS) {
              return yield* new WebSearchError({
                message: `The query is over ${QUERY_MAX_CHARS} characters long; make it shorter.`,
              });
            }
            if (
              paging.count < 1 ||
              paging.count > COUNT_MAX ||
              paging.page < 1 ||
              paging.page > PAGE_MAX
            ) {
              return yield* new WebSearchError({
                message: `count is 1 to ${COUNT_MAX} and page 1 to ${PAGE_MAX}.`,
              });
            }
            const key = cacheKey(trimmed, paging);
            const hit = cache.get(key);
            if (hit !== undefined && Date.now() - hit.at < ttl) {
              return hit.outcome;
            }
            const response = yield* options
              .query(trimmed, paging)
              .pipe(slots.withPermits(1));
            const outcome = outcomeOf(response, paging.count);
            if (
              outcome.results.length === 0 &&
              outcome.answers.length === 0 &&
              outcome.unresponsive.length > 0
            ) {
              return yield* new WebSearchError({
                message: `The search engines did not answer: ${outcome.unresponsive
                  .map(([engine, reason]) =>
                    reason === "" ? engine : `${engine} (${reason})`
                  )
                  .join(", ")}.`,
              });
            }
            cache.set(key, { at: Date.now(), outcome });
            return outcome;
          }),
        });
      })
    );

  /** A WebSearch over a SearXNG instance. */
  static readonly searxng = (
    options: SearxngOptions & { readonly concurrency?: number | undefined }
  ) =>
    WebSearch.layer({
      query: (query, paging) => searxngSearch(options, query, paging),
      concurrency: options.concurrency,
    });

  /**
   * A WebSearch that answers with canned data, for tests: a fixed outcome, a function of the query, or an Error to
   * make searches fail.
   */
  static readonly fake = (
    what:
      | Partial<SearchOutcome>
      | Error
      | ((
          query: string,
          options: SearchOptions
        ) => Partial<SearchOutcome> | Error)
  ): Layer.Layer<WebSearch> =>
    Layer.succeed(
      WebSearch,
      WebSearch.of({
        search: (query, options = {}) =>
          Effect.gen(function* () {
            const found =
              typeof what === "function" ? what(query, options) : what;
            if (found instanceof Error) {
              return yield* new WebSearchError({ message: found.message });
            }
            return {
              results: found.results ?? [],
              answers: found.answers ?? [],
              suggestions: found.suggestions ?? [],
              unresponsive: found.unresponsive ?? [],
            };
          }),
      })
    );
}

const Parameters = Type.Object({
  query: Type.String({
    description: "What to search for",
    maxLength: QUERY_MAX_CHARS,
  }),
  count: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: COUNT_MAX,
      description: `How many results to return, ${COUNT_DEFAULT} by default`,
    })
  ),
  recency: Type.Optional(
    Type.Union(
      [Type.Literal("day"), Type.Literal("month"), Type.Literal("year")],
      {
        description:
          "Only results from the last day, month or year, for engines that support it",
      }
    )
  ),
  page: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: PAGE_MAX,
      description: "The result page, 1 by default",
    })
  ),
});

/**
 * The `web` extension: the `web_search` tool and its prompt section. Not locked — a conversation can switch it off
 * from the Capabilities sheet. A search is a read, so `replay: "safe"` lets an interrupted call rerun after a crash.
 */
export const webSearchExtension = (
  webSearch: WebSearch["Service"]
): Extension =>
  defineExtension({
    name: "web",
    sections: [section("web_search", () => webSearchSection(new Date()))],
    tools: [
      withApproval(
        defineTool({
          name: "web_search",
          description: `Search the web through this server's SearXNG instance and get numbered results: a title, URL and snippet each, plus direct answers when there are any. ${QUERY_MAX_CHARS} characters at most per query.`,
          parameters: Parameters,
          // A search is a read; rerunning it after a crash is harmless.
          replay: "safe",
          execute: async ({ query, count, recency, page }, _api, context) => {
            const outcome = await Effect.runPromise(
              webSearch.search(query, { count, recency, page }),
              context.abortSignal === undefined
                ? {}
                : { signal: context.abortSignal }
            ).catch((error: unknown) => {
              throw error instanceof WebSearchError
                ? new Error(error.message)
                : error;
            });
            return {
              content: [{ type: "text", text: formatSearch(query, outcome) }],
              details: detailsOf(query, outcome),
            };
          },
        })
      ),
    ],
  });
