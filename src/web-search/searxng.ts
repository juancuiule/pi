// The SearXNG client: one GET to /search?format=json with a timeout, decoded into format.ts's RawResponse keeping
// only the fields that are read, so a field added by a SearXNG update does not break it. A 403 almost always means
// `json` is missing from `search.formats` in the instance's settings.
import { Effect, Schema } from "effect";

import type { RawResponse } from "./format.ts";

/** A search that could not run: unreachable, timed out, refused, or answered malformed JSON. */
export class WebSearchError extends Schema.TaggedError<WebSearchError>()(
  "WebSearchError",
  { message: Schema.String }
) {}

/** How to reach a SearXNG instance and what to send it on every query. */
export interface SearxngOptions {
  readonly url: string;
  readonly timeoutMs: number;
  /** SearXNG's `language` param; `auto` lets it detect the language. */
  readonly language: string;
  /** SearXNG's `safesearch` param: 0 none, 1 moderate, 2 strict. */
  readonly safeSearch: number;
}

const SearxResult = Schema.Struct({
  url: Schema.optionalKey(Schema.String),
  title: Schema.optionalKey(Schema.String),
  content: Schema.optionalKey(Schema.String),
  // SearXNG sends `publishedDate: null` on undated results.
  publishedDate: Schema.optionalKey(Schema.NullOr(Schema.String)),
});

const SearxAnswer = Schema.Union([
  Schema.String,
  Schema.Struct({
    answer: Schema.optionalKey(Schema.String),
    url: Schema.optionalKey(Schema.String),
  }),
]);

const SearxResponse = Schema.Struct({
  results: Schema.optionalKey(Schema.Array(SearxResult)),
  answers: Schema.optionalKey(Schema.Array(SearxAnswer)),
  suggestions: Schema.optionalKey(Schema.Array(Schema.String)),
  unresponsive_engines: Schema.optionalKey(Schema.Array(Schema.Unknown)),
});

/** The search's paging options: a recency window for engines that support it, a result page. */
export interface SearchPaging {
  readonly count?: number | undefined;
  readonly recency?: "day" | "month" | "year" | undefined;
  readonly page?: number | undefined;
}

const searchUrl = (
  options: SearxngOptions,
  query: string,
  paging: SearchPaging
) => {
  const url = new URL(`${options.url.replace(/\/+$/u, "")}/search`);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("categories", "general");
  url.searchParams.set("language", options.language);
  url.searchParams.set("safesearch", String(options.safeSearch));
  if (paging.recency !== undefined) {
    url.searchParams.set("time_range", paging.recency);
  }
  if (paging.page !== undefined && paging.page !== 1) {
    url.searchParams.set("pageno", String(paging.page));
  }
  return url;
};

const fail = (message: string) => new WebSearchError({ message });

/**
 * One search against the instance. Interrupting the effect aborts the request; the request is also capped at
 * `timeoutMs`, reported as a timeout rather than a connection failure.
 */
export const searxngSearch = (
  options: SearxngOptions,
  query: string,
  paging: SearchPaging = {}
): Effect.Effect<RawResponse, WebSearchError> =>
  Effect.gen(function* () {
    const url = searchUrl(options, query, paging);
    const response = yield* Effect.tryPromise({
      try: (signal) =>
        fetch(url, {
          signal: AbortSignal.any([
            signal,
            AbortSignal.timeout(options.timeoutMs),
          ]),
        }),
      catch: (cause) =>
        fail(
          cause instanceof DOMException && cause.name === "TimeoutError"
            ? `The search timed out after ${options.timeoutMs}ms`
            : `The search could not reach ${options.url}: ${cause instanceof Error ? cause.message : String(cause)}`
        ),
    });
    if (!response.ok) {
      return yield* fail(
        response.status === 403
          ? `SearXNG answered 403 Forbidden: enable json in search.formats in its settings`
          : `SearXNG answered ${response.status} ${response.statusText}`
      );
    }
    const body = yield* Effect.tryPromise({
      try: () => response.json() as Promise<unknown>,
      catch: (cause) =>
        fail(`SearXNG answered malformed JSON: ${String(cause)}`),
    });
    return yield* Schema.decodeUnknownEffect(SearxResponse)(body).pipe(
      Effect.mapError((cause) =>
        fail(`SearXNG's response did not decode: ${cause.message}`)
      )
    );
  });
