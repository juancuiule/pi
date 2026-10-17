// The SearXNG client against a local HTTP server: the captured fixtures, a 403 (json not in search.formats), a
// non-2xx, a request that never answers (the timeout), malformed JSON, and a response with every engine unresponsive.
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { searxngSearch } from "./searxng.ts";
import type { SearxngOptions, WebSearchError } from "./searxng.ts";

const body = (name: string) =>
  readFileSync(
    new URL(`../testing/fixtures/${name}`, import.meta.url),
    "utf-8"
  );

const options = (url: string, timeoutMs = 5000): SearxngOptions => ({
  url,
  timeoutMs,
  language: "auto",
  safeSearch: 1,
});

/**
 * Run `check` against a server that answers `handler`; `seen` collects the request urls. The handler may leave the
 * response open forever — connections are closed by force in the end, or `close` would hang on it.
 */
const serve = async (
  handler: (res: ServerResponse) => void,
  check: (url: string, seen: string[]) => Promise<void>
) => {
  const seen: string[] = [];
  const http = createServer((request, res) => {
    seen.push(request.url ?? "");
    handler(res);
  });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  try {
    await check(
      `http://127.0.0.1:${(http.address() as AddressInfo).port}`,
      seen
    );
  } finally {
    http.closeAllConnections();
    const closed = once(http, "close");
    http.close();
    await closed;
  }
};

const json = (res: ServerResponse, text: string, status = 200) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(text);
};

const failure = (effect: Effect.Effect<unknown, WebSearchError>) =>
  Effect.runPromise(Effect.flip(effect));

describe(searxngSearch, () => {
  it("GETs /search with the query and the configured params, and decodes the response", async () => {
    await serve(
      (res) => json(res, body("searxng-results.json")),
      async (url, seen) => {
        const response = await Effect.runPromise(
          searxngSearch(options(url), "effect v4 release", {
            recency: "month",
            page: 2,
          })
        );

        const sent = new URL(`http://x${seen[0]}`);
        expect(sent.pathname).toBe("/search");
        expect(Object.fromEntries(sent.searchParams)).toStrictEqual({
          q: "effect v4 release",
          format: "json",
          categories: "general",
          language: "auto",
          safesearch: "1",
          time_range: "month",
          pageno: "2",
        });
        expect(response.results?.length).toBeGreaterThan(0);
      }
    );
  });

  it("leaves time_range and pageno out when not asked", async () => {
    await serve(
      (res) => json(res, body("searxng-empty.json")),
      async (url, seen) => {
        await Effect.runPromise(searxngSearch(options(url), "q"));
        const sent = new URL(`http://x${seen[0]}`);
        expect(sent.searchParams.has("time_range")).toBeFalsy();
        expect(sent.searchParams.has("pageno")).toBeFalsy();
      }
    );
  });

  it("maps a 403 to a message about json in search.formats", async () => {
    await serve(
      (res) => {
        res.writeHead(403).end("forbidden");
      },
      async (url) => {
        const error = await failure(searxngSearch(options(url), "q"));
        expect(error._tag).toBe("WebSearchError");
        expect(error.message).toContain("403");
        expect(error.message).toContain("search.formats");
      }
    );
  });

  it("maps another non-2xx to the status", async () => {
    await serve(
      (res) => json(res, "{}", 502),
      async (url) => {
        const error = await failure(searxngSearch(options(url), "q"));
        expect(error.message).toContain("502");
      }
    );
  });

  it("times out a response that never arrives", async () => {
    await serve(
      // Never answered: the client's own timeout is what ends the request.
      () => {},
      async (url) => {
        const error = await failure(searxngSearch(options(url, 100), "q"));
        expect(error.message).toContain("timed out");
      }
    );
  });

  it("fails a malformed JSON body as such", async () => {
    await serve(
      (res) => json(res, "this is not json"),
      async (url) => {
        const error = await failure(searxngSearch(options(url), "q"));
        expect(error.message).toContain("malformed JSON");
      }
    );
  });

  it("keeps unresponsive_engines so the service can tell an empty result from a dead one", async () => {
    await serve(
      (res) => json(res, body("searxng-empty.json")),
      async (url) => {
        const response = await Effect.runPromise(
          searxngSearch(options(url), "zxqwvortz blorfbleep")
        );
        expect(response.results).toStrictEqual([]);
        expect(response.unresponsive_engines).toStrictEqual([
          ["duckduckgo", "CAPTCHA"],
        ]);
      }
    );
  });

  it("decodes a response that carries fields it does not read", async () => {
    const extra = JSON.stringify({
      results: [{ url: "https://a.example", score: 1.5, unknown: { deep: 1 } }],
      brand_new_field: [1, 2, 3],
    });
    await serve(
      (res) => json(res, extra),
      async (url) => {
        const response = await Effect.runPromise(
          searxngSearch(options(url), "q")
        );
        expect(response.results?.[0]?.url).toBe("https://a.example");
      }
    );
  });

  it("reports a connection failure with the configured url", async () => {
    // A port nobody listens on.
    const error = await failure(
      searxngSearch(options("http://127.0.0.1:1", 2000), "q")
    );
    expect(error.message).toContain("http://127.0.0.1:1");
  });
});
