// The connectors group over HTTP: Settings → Connections lists the server's connectors with the caller's own
// connection, connects and disconnects, and no response ever carries the secret.
import { NodeHttpServer } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { HttpClient, HttpRouter } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import { describe, expect, it } from "vitest";

import { Auth } from "../auth/auth.ts";
import { Connectors } from "../connectors/connectors.ts";
import { nextcloudConnector } from "../nextcloud/nextcloud.ts";
import { Search } from "../search/search.ts";
import { Skills } from "../skills/skills.ts";
import { signedIn, signIn } from "../testing/auth.ts";
import { fauxAgents } from "../testing/faux.ts";
import { fakeNextcloud } from "../testing/nextcloud.ts";
import { Api } from "./api.ts";
import { Conversations } from "./conversations.ts";
import { apiLayer } from "./handlers.ts";

const serve = (connectors: Layer.Layer<Connectors>) =>
  HttpRouter.serve(apiLayer({ apiUrl: "http://127.0.0.1", tracing: false }), {
    disableListenLog: true,
    disableLogger: true,
  }).pipe(
    Layer.provide(
      Conversations.layer({ idleTimeoutMs: 60_000, sweepEveryMs: 60_000 })
    ),
    Layer.provide(Search.none),
    Layer.provide(fauxAgents([], { connectors }).layer),
    Layer.provide(Skills.none),
    Layer.provideMerge(NodeHttpServer.layerTest),
    Layer.provideMerge(Auth.temporary()),
    (served) => signedIn("alice").pipe(Layer.provideMerge(served))
  );

describe("the connectors API", () => {
  it("lists nothing on a server without connectors", async () => {
    const listed = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* HttpApiClient.make(Api);
        return yield* client.connectors.list();
      }).pipe(Effect.provide(serve(Connectors.none)))
    );
    expect(listed).toStrictEqual([]);
  });

  it("connects, lists only the caller's connection, and disconnects", async () => {
    const nc = fakeNextcloud([
      { login: "alice", password: "alice-pw" },
      { login: "bob", password: "bob-pw" },
    ]);
    const appPassword = nc.appPassword("alice");
    const layer = serve(
      Connectors.temporary([
        nextcloudConnector({ url: nc.url, fetch: nc.fetch }),
      ])
    );
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* HttpApiClient.make(Api);
        const connected = yield* client.connectors.connect({
          params: { id: "nextcloud" },
          payload: { login: "alice", password: appPassword },
        });
        const refused = yield* Effect.flip(
          client.connectors.connect({
            params: { id: "nextcloud" },
            payload: { login: "alice", password: "wrong" },
          })
        );
        const unknown = yield* Effect.flip(
          client.connectors
            .list()
            .pipe(
              Effect.andThen(
                client.connectors.disconnect({ params: { id: "dropbox" } })
              )
            )
        );
        const listed = yield* client.connectors.list();
        const bob = yield* signIn("bob");
        const bobs = yield* HttpApiClient.make(Api).pipe(
          Effect.andThen((other) => other.connectors.list()),
          Effect.provideService(HttpClient.HttpClient, bob.client)
        );
        yield* client.connectors.disconnect({ params: { id: "nextcloud" } });
        const after = yield* client.connectors.list();
        return { connected, refused, unknown, listed, bobs, after };
      }).pipe(Effect.provide(layer))
    );
    expect([
      outcome.connected.connection?.account.login,
      outcome.refused._tag,
      outcome.unknown._tag,
    ]).toStrictEqual(["alice", "ConnectorRefused", "ConnectorNotFound"]);
    expect(outcome.listed[0]).toMatchObject({
      id: "nextcloud",
      title: "Nextcloud",
      url: nc.url,
      loginFlow: true,
    });
    expect(JSON.stringify(outcome)).not.toContain(appPassword);
    expect(outcome.bobs[0]?.connection).toBeUndefined();
    expect(outcome.after[0]?.connection).toBeUndefined();
  });
});
