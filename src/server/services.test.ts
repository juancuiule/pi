// The edge's forward_auth check (GET /api/services/:name) and the console's list, over HTTP as Caddy sends them: the
// browser's cookie, Host and Origin copied onto a GET.
import { NodeHttpServer } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/http";
import { describe, expect, it } from "vitest";

import { Auth } from "../auth/auth.ts";
import { Search } from "../search/search.ts";
import type { ServiceName } from "../services.ts";
import { mayOpenServices, parseServiceNames } from "../services.ts";
import { Skills } from "../skills/skills.ts";
import { SkillSource } from "../skills/source.ts";
import { signIn } from "../testing/auth.ts";
import { fauxAgents } from "../testing/faux.ts";
import { Conversations } from "./conversations.ts";
import { apiLayer } from "./handlers.ts";

const PUBLIC = new URL("https://pi.example.com");

const server = (services: {
  readonly enabled?: readonly ServiceName[];
  readonly users?: readonly string[];
}) =>
  HttpRouter.serve(
    apiLayer({
      apiUrl: "http://127.0.0.1",
      tracing: false,
      publicUrls: [PUBLIC],
      services,
    }),
    { disableListenLog: true, disableLogger: true }
  ).pipe(
    Layer.provide(
      Conversations.layer({ idleTimeoutMs: 60_000, sweepEveryMs: 60_000 })
    ),
    Layer.provideMerge(Search.temporary),
    Layer.provide(fauxAgents([]).layer),
    Layer.provide(Skills.layer.pipe(Layer.provide(SkillSource.memory({})))),
    Layer.provideMerge(NodeHttpServer.layerTest),
    Layer.provideMerge(Auth.temporary())
  );

/** What the edge gets back for `path`, sent as forward_auth sends it: through the public URL, with `cookie`. */
const ask = (path: string, cookie?: string, origin?: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(
      HttpClientRequest.get(path).pipe(
        HttpClientRequest.setHeaders({
          host: PUBLIC.host,
          "x-forwarded-host": PUBLIC.host,
          ...(cookie === undefined ? {} : { cookie }),
          ...(origin === undefined ? {} : { origin }),
        })
      )
    );
    return response.status;
  }).pipe(Effect.scoped);

/** The Service names `GET /api/services` lists for `cookie`. */
const listed = (cookie: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.get("/api/services", {
      headers: { cookie },
    });
    const body = (yield* response.json) as readonly {
      readonly name: string;
    }[];
    return body.map((service) => service.name);
  }).pipe(Effect.scoped);

describe("services", () => {
  it("forwards only a signed-in account that may open the Services, and only to those served", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const alice = yield* signIn("alice");
        const bob = yield* signIn("bob");
        return {
          anonymous: yield* ask("/api/services/langfuse"),
          stale: yield* ask(
            "/api/services/langfuse",
            "effect_pi_session=not-a-token"
          ),
          alice: yield* ask("/api/services/langfuse", alice.cookie),
          // A POST from a Langfuse page carries the public origin; forward_auth turns it into this GET.
          aliceFromPage: yield* ask(
            "/api/services/langfuse",
            alice.cookie,
            PUBLIC.origin
          ),
          aliceFromElsewhere: yield* ask(
            "/api/services/langfuse",
            alice.cookie,
            "https://evil.example"
          ),
          notServed: yield* ask("/api/services/seaweedfs", alice.cookie),
          unknown: yield* ask("/api/services/grafana", alice.cookie),
          bob: yield* ask("/api/services/langfuse", bob.cookie),
          aliceList: yield* listed(alice.cookie),
          bobList: yield* listed(bob.cookie),
        };
      }).pipe(Effect.provide(server({ enabled: ["searxng", "langfuse"] })))
    );
    expect(result).toStrictEqual({
      anonymous: 401,
      stale: 401,
      alice: 200,
      aliceFromPage: 200,
      aliceFromElsewhere: 403,
      notServed: 404,
      unknown: 404,
      bob: 403,
      aliceList: ["searxng", "langfuse"],
      bobList: [],
    });
  }, 30_000);

  it("lets SERVICE_USERS name the accounts instead of the oldest", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const alice = yield* signIn("alice");
        const bob = yield* signIn("bob");
        return {
          alice: yield* ask("/api/services/searxng", alice.cookie),
          bob: yield* ask("/api/services/searxng", bob.cookie),
        };
      }).pipe(Effect.provide(server({ enabled: ["searxng"], users: ["bob"] })))
    );
    expect(result).toStrictEqual({ alice: 403, bob: 200 });
  }, 30_000);
});

describe(parseServiceNames, () => {
  it("keeps catalog order and each name once, and refuses an unknown one", () => {
    expect(parseServiceNames("")).toStrictEqual([]);
    expect(parseServiceNames(" searxng, langfuse,searxng ,")).toStrictEqual([
      "langfuse",
      "searxng",
    ]);
    expect(() => parseServiceNames("langfuse,grafana")).toThrow(/grafana/u);
  });
});

describe(mayOpenServices, () => {
  const alice = { id: "a", name: "alice" };

  it("defaults to the oldest account", () => {
    expect(
      mayOpenServices(alice, { users: [], oldest: { id: "a" } })
    ).toBeTruthy();
    expect(
      mayOpenServices(alice, { users: [], oldest: { id: "b" } })
    ).toBeFalsy();
    expect(
      mayOpenServices(alice, { users: ["alice"], oldest: undefined })
    ).toBeTruthy();
  });
});
