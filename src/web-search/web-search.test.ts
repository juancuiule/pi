// The WebSearch service — its cache, semaphore and validation over a counting query function — and the `web`
// extension through fauxAgents: the tool result and its details, the approval under `ask`, switching the extension
// off, and what the capabilities list when no SearXNG is configured.
import type { AgentEvent } from "@earendil-works/pi-durable";
import { Context, Effect, Layer, Ref, Scope, Stream } from "effect";
import { describe, expect, it } from "vitest";

import { Agents } from "../agents/agents.ts";
import type { SandboxChoice } from "../sandbox/sandbox.ts";
import {
  callTool,
  echoToolResult,
  fauxAgents,
  offered,
  offeredIn,
  openSeat,
} from "../testing/faux.ts";
import type { RawResponse } from "./format.ts";
import type { WebSearchError } from "./searxng.ts";
import { WebSearch } from "./web-search.ts";

// A wire result (the client's RawResult: `content`) for `counting`, and a cleaned one (SearchResult: `snippet`) for
// `WebSearch.fake`, which skips the wire entirely.
const result = (n: number) => ({
  url: `https://example.com/${n}`,
  title: `Result ${n}`,
  content: `Snippet ${n}`,
});

const shown = (n: number) => ({
  url: `https://example.com/${n}`,
  title: `Result ${n}`,
  snippet: `Snippet ${n}`,
});

/** A WebSearch whose `run` answers each search, counting calls and the most ever in flight. */
const counting = (
  run: (query: string) => RawResponse,
  options: { concurrency?: number; cacheTtlMs?: number } = {}
) => {
  const stats = { calls: 0, inFlight: 0, maxInFlight: 0 };
  const layer = WebSearch.layer({
    query: (query) =>
      Effect.gen(function* () {
        stats.calls += 1;
        stats.inFlight += 1;
        stats.maxInFlight = Math.max(stats.maxInFlight, stats.inFlight);
        yield* Effect.sleep("30 millis");
        stats.inFlight -= 1;
        return run(query);
      }),
    ...options,
  });
  return {
    stats,
    layer,
    // The layer acquires nothing scoped; building it under `Effect.scoped` only satisfies Layer.build's Scope.
    service: Effect.runPromise(
      Effect.scoped(
        Effect.map(Layer.build(layer), (context) =>
          Context.get(context, WebSearch)
        )
      )
    ),
  };
};

const ok = (results = [result(1)]): RawResponse => ({ results });

const failureMessage = async (
  effect: Effect.Effect<unknown, WebSearchError>
) => {
  const error = await Effect.runPromise(Effect.flip(effect));
  return error.message;
};

describe(WebSearch, () => {
  it("answers an identical search from the cache, a changed one from SearXNG", async () => {
    const { stats, service } = counting(() => ok());
    const webSearch = await service;

    await Effect.runPromise(webSearch.search("effect v4"));
    const again = await Effect.runPromise(webSearch.search("effect v4"));
    expect(stats.calls).toBe(1);
    expect(again.results[0]?.url).toBe("https://example.com/1");

    // The options are part of the key.
    await Effect.runPromise(webSearch.search("effect v4", { count: 3 }));
    await Effect.runPromise(webSearch.search("effect v5"));
    expect(stats.calls).toBe(3);
  });

  it("refetches once a cached search is older than the ttl", async () => {
    const { stats, service } = counting(() => ok(), { cacheTtlMs: 30 });
    const webSearch = await service;

    await Effect.runPromise(webSearch.search("q"));
    await Effect.runPromise(webSearch.search("q"));
    await Effect.runPromise(Effect.sleep("60 millis"));
    await Effect.runPromise(webSearch.search("q"));
    expect(stats.calls).toBe(2);
  });

  it("never runs more than `concurrency` searches at once", async () => {
    const { stats, service } = counting(() => ok(), { concurrency: 2 });
    const webSearch = await service;

    await Effect.runPromise(
      Effect.all(
        ["a", "b", "c", "d", "e"].map((query) => webSearch.search(query)),
        { concurrency: "unbounded" }
      )
    );
    expect(stats.calls).toBe(5);
    expect(stats.maxInFlight).toBe(2);
  });

  it("fails an empty result whose engines all went unresponsive, naming them", async () => {
    const { service } = counting(() => ({
      results: [],
      unresponsive_engines: [
        ["duckduckgo", "CAPTCHA"],
        ["brave", "timeout"],
      ],
    }));
    const webSearch = await service;

    const error = await Effect.runPromise(
      Effect.flip(webSearch.search("anything"))
    );
    expect(error.message).toContain("duckduckgo (CAPTCHA)");
    expect(error.message).toContain("brave (timeout)");
  });

  it("treats an empty result as a result, suggestions included", async () => {
    const { service } = counting(() => ({
      results: [],
      suggestions: ["effect pi"],
    }));
    const webSearch = await service;

    const outcome = await Effect.runPromise(webSearch.search("effect p1"));
    expect(outcome.results).toStrictEqual([]);
    expect(outcome.suggestions).toStrictEqual(["effect pi"]);
  });

  it("refuses an empty query or one over 400 characters without searching", async () => {
    const { stats, service } = counting(() => ok());
    const webSearch = await service;

    await expect(failureMessage(webSearch.search("   "))).resolves.toContain(
      "empty"
    );
    await expect(
      failureMessage(webSearch.search("x".repeat(401)))
    ).resolves.toContain("400");
    expect(stats.calls).toBe(0);
  });

  it("refuses out-of-range options without searching", async () => {
    const { stats, service } = counting(() => ok());
    const webSearch = await service;

    await expect(
      failureMessage(webSearch.search("q", { count: 0 }))
    ).resolves.toContain("count is 1 to 10");
    await expect(
      failureMessage(webSearch.search("q", { count: 11 }))
    ).resolves.toContain("count is 1 to 10");
    await expect(
      failureMessage(webSearch.search("q", { page: 4 }))
    ).resolves.toContain("page 1 to 3");
    expect(stats.calls).toBe(0);
  });

  it("cleans the wire response and keeps the first `count` results", async () => {
    const { service } = counting(() => ({
      results: [
        ...Array.from({ length: 8 }, (_, index) => result(index)),
        // oxlint-disable-next-line no-script-url -- a scheme to drop, not a URL to run
        { url: "javascript:x", title: "bad" },
      ],
    }));
    const webSearch = await service;

    const outcome = await Effect.runPromise(
      webSearch.search("q", { count: 3 })
    );
    expect(outcome.results.map((each) => each.url)).toStrictEqual([
      "https://example.com/0",
      "https://example.com/1",
      "https://example.com/2",
    ]);
  });
});

describe("WebSearch.fake", () => {
  it("answers with the canned outcome, a function of the query, or an error", async () => {
    const fixed = await Effect.runPromise(
      Effect.gen(function* () {
        const webSearch = yield* WebSearch;
        return yield* webSearch.search("q");
      }).pipe(Effect.provide(WebSearch.fake({ results: [shown(7)] })))
    );
    expect(fixed.results[0]?.url).toBe("https://example.com/7");

    const byQuery = await Effect.runPromise(
      Effect.gen(function* () {
        const webSearch = yield* WebSearch;
        return yield* webSearch.search("which");
      }).pipe(
        Effect.provide(
          WebSearch.fake((query) => ({
            results: [{ ...shown(1), title: `for ${query}` }],
          }))
        )
      )
    );
    expect(byQuery.results[0]?.title).toBe("for which");

    const error = await Effect.runPromise(
      Effect.flip(
        Effect.gen(function* () {
          const webSearch = yield* WebSearch;
          return yield* webSearch.search("q");
        }).pipe(Effect.provide(WebSearch.fake(new Error("searxng is down"))))
      )
    );
    expect(error.message).toContain("searxng is down");
  });
});

const waitUntil = (check: Effect.Effect<boolean, unknown>, timeoutMs = 8000) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < timeoutMs / 10; attempt += 1) {
      if (yield* check) {
        return;
      }
      yield* Effect.sleep("10 millis");
    }
    return yield* Effect.die(new Error("timed out waiting"));
  });

const hasRunEnd = (ref: Ref.Ref<AgentEvent[]>) =>
  Ref.get(ref).pipe(
    Effect.map((all) => all.some((event) => event.type === "run_end"))
  );

const toolResults = (ref: Ref.Ref<AgentEvent[]>) =>
  Ref.get(ref).pipe(
    Effect.map((all) =>
      all.flatMap((event) =>
        event.type === "tool_execution_end" && event.entry !== undefined
          ? (event.entry.model ?? []).flatMap((message) =>
              message.role === "toolResult" ? [message] : []
            )
          : []
      )
    )
  );

const pendingKey = (ref: Ref.Ref<AgentEvent[]>) =>
  Ref.get(ref).pipe(
    Effect.map((all) => {
      const update = all.find(
        (event) =>
          event.type === "tool_execution_update" &&
          typeof event.details === "object" &&
          event.details !== null &&
          "approval" in event.details &&
          (event.details as { approval?: string }).approval === "pending"
      );
      return update !== undefined && update.type === "tool_execution_update"
        ? (update.details as { approvalKey?: string }).approvalKey
        : undefined;
    })
  );

/** Open a conversation, follow its events into `ref`, send the prompt, and hand back the seat. */
const converse = (sandbox: SandboxChoice, approvals: "ask" | "auto") =>
  Effect.gen(function* () {
    const agents = yield* Agents;
    const conversation = yield* openSeat({ sandbox, approvals });
    const ref = yield* Ref.make<AgentEvent[]>([]);
    const events = yield* agents.events(conversation.id);
    const scope = yield* Scope.Scope;
    yield* Stream.runForEach(events, (event) =>
      Ref.update(ref, (all) => [...all, event])
    ).pipe(Effect.forkIn(scope));
    yield* conversation.send("search for me");
    return { agents, conversation, ref };
  });

const FAKE_OUTCOME = {
  results: [
    {
      title: "Effect 4.0 is out",
      url: "https://effect.website/blog/effect-4",
      snippet: "Effect 4.0 brings a smaller runtime",
      publishedDate: "2026-09-30",
    },
  ],
};

describe("the web extension", () => {
  it("answers with the <search_results> text and details.sources for the console", async () => {
    const { layer } = fauxAgents(
      [callTool("web_search", { query: "effect v4" }), echoToolResult],
      { webSearch: WebSearch.fake(FAKE_OUTCOME) }
    );

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { ref } = yield* converse("none", "auto");
          yield* waitUntil(hasRunEnd(ref));
          const results = yield* toolResults(ref);
          const text = (results[0]?.content ?? [])
            .flatMap((c) => (c.type === "text" ? [c.text] : []))
            .join("");
          expect(text).toContain('<search_results query="effect v4">');
          expect(text).toContain("[1] Effect 4.0 is out");
          expect(text).toContain("(2026-09-30)");
          const details = results[0]?.details as
            | { query?: string; sources?: { url: string }[] }
            | undefined;
          expect(details?.query).toBe("effect v4");
          expect(details?.sources?.[0]?.url).toBe(
            "https://effect.website/blog/effect-4"
          );
        })
      ).pipe(Effect.provide(layer))
    );
  });

  it("holds the call for approval under ask, and its details gain approvalWaitMs", async () => {
    const { layer } = fauxAgents(
      [callTool("web_search", { query: "effect v4" }), echoToolResult],
      { webSearch: WebSearch.fake(FAKE_OUTCOME) }
    );

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { conversation, ref } = yield* converse("none", "ask");
          yield* waitUntil(
            conversation.pendingApprovals.pipe(
              Effect.map((count) => count === 1)
            )
          );
          const key = yield* waitUntil(
            pendingKey(ref).pipe(Effect.map((k) => k !== undefined))
          ).pipe(Effect.andThen(pendingKey(ref)));
          yield* conversation.decide(key as string, "approve");
          yield* waitUntil(hasRunEnd(ref));
          const results = yield* toolResults(ref);
          expect(results[0]?.isError).not.toBeTruthy();
          expect(
            (results[0]?.details as { approvalWaitMs?: number } | undefined)
              ?.approvalWaitMs
          ).toBeTypeOf("number");
        })
      ).pipe(Effect.provide(layer))
    );
  });

  it("offers web_search and its section at every Level, and neither once switched off", async () => {
    const { layer } = fauxAgents([offered, offered], {
      webSearch: WebSearch.fake(FAKE_OUTCOME),
    });

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const agents = yield* Agents;
          const id = yield* agents.create({
            prompt: "",
            title: "",
            level: "none",
            createdAt: 0,
          });
          const seat = yield* agents.open(id);
          const before = offeredIn(yield* seat.ask("What do you have?"));
          expect(before.tools).toContain("web_search");
          expect(before.system).toContain("web_search");

          yield* agents.configure(id, { extensions: { web: false } });
          const after = offeredIn(yield* seat.ask("And now?"));
          expect(after.tools).not.toContain("web_search");
          expect(after.system).not.toContain(
            "Use web_search to look up anything"
          );
        })
      ).pipe(Effect.provide(layer))
    );
  });

  it("lists web in the capabilities, unlocked at every Level; without the service, it is absent", async () => {
    const { layer } = fauxAgents([offered], {
      webSearch: WebSearch.fake(FAKE_OUTCOME),
    });

    const capabilities = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const agents = yield* Agents;
          return yield* agents.capabilities;
        })
      ).pipe(Effect.provide(layer))
    );
    const web = capabilities.extensions.find((each) => each.name === "web");
    expect(web).toMatchObject({
      levels: ["none", "shell", "desktop"],
      locked: false,
    });
    expect(web?.tools.map((tool) => tool.name)).toContain("web_search");

    const without = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const agents = yield* Agents;
          return yield* agents.capabilities;
        })
      ).pipe(Effect.provide(fauxAgents([offered]).layer))
    );
    expect(without.extensions.map((each) => each.name)).not.toContain("web");
  });
});
