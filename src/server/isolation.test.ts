// What one User can reach of another's. The endpoint matrix is read from `Api` itself, so a route added later is
// covered without editing this file: every endpoint outside `auth` answers 401 without a session, and every one
// addressed by a Conversation answers 404 when the Conversation is someone else's.
import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { NodeHttpServer } from "@effect/platform-node";
import { NodeWS } from "@effect/platform-node/NodeSocket";
import { Effect, Layer } from "effect";
import {
  HttpBody,
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServer,
} from "effect/http";
import { HttpApiClient } from "effect/http-api";
import type * as NetAddress from "effect/net/NetAddress";
import sharp from "sharp";
import { describe, expect, it } from "vitest";

import { Auth } from "../auth/auth.ts";
import { Search } from "../search/search.ts";
import { Skills } from "../skills/skills.ts";
import { SkillSource } from "../skills/source.ts";
import { signedIn, signIn } from "../testing/auth.ts";
import { fauxAgents } from "../testing/faux.ts";
import { Api } from "./api.ts";
import { Conversations } from "./conversations.ts";
import { apiLayer } from "./handlers.ts";
import { shellRoute } from "./shell.ts";

const SECRET = "wombat-secret";

const server = () =>
  HttpRouter.serve(
    Layer.mergeAll(
      apiLayer({ apiUrl: "http://127.0.0.1", tracing: false }),
      shellRoute
    ),
    { disableListenLog: true, disableLogger: true }
  ).pipe(
    Layer.provide(
      Conversations.layer({ idleTimeoutMs: 60_000, sweepEveryMs: 60_000 })
    ),
    Layer.provideMerge(Search.temporary),
    Layer.provide(
      fauxAgents([
        fauxAssistantMessage(
          [
            fauxToolCall(
              "artifact_create",
              { title: `${SECRET} page`, html: `<p>${SECRET}</p>` },
              { id: "alice-page" }
            ),
          ],
          { stopReason: "toolUse" }
        ),
        fauxAssistantMessage([fauxText(`The ${SECRET} answer.`)]),
      ]).layer
    ),
    Layer.provide(Skills.layer.pipe(Layer.provide(SkillSource.memory({})))),
    Layer.provideMerge(NodeHttpServer.layerTest),
    Layer.provideMerge(Auth.temporary()),
    (served) => signedIn("alice").pipe(Layer.provideMerge(served))
  );

interface Route {
  readonly name: string;
  readonly method: string;
  readonly path: string;
}

const routes: readonly Route[] = Object.values(Api.groups).flatMap((group) =>
  // `auth` is how a session starts; `attachmentImages` is reached by capability (its own test below).
  group.identifier === "auth" || group.identifier === "attachmentImages"
    ? []
    : Object.values(group.endpoints).map((endpoint) => ({
        name: `${group.identifier}.${endpoint.identifier}`,
        method: endpoint.method,
        path: endpoint.path.startsWith("/api")
          ? endpoint.path
          : `/api${endpoint.path}`,
      }))
);

/** Whether a route is addressed by a Conversation: `/conversations/:id/...`, or a `conversation` query it scopes by. */
const scopedBy = (route: Route) =>
  route.path.startsWith("/api/conversations/:id") ||
  (/^\/api\/(?:attachments|artifacts)\/:id/u.test(route.path) &&
    route.name !== "attachments.remove");

/** The route's URL with every param filled; the Conversation ones (path and query) set to `conversation`. */
const urlOf = (route: Route, conversation: number) => {
  const filled = route.path
    .replace(
      /^\/api\/conversations\/:id/u,
      `/api/conversations/${conversation}`
    )
    .replaceAll(/:submission|:page/gu, "1")
    .replaceAll(/:[a-z]+/gu, "x");
  return scopedBy(route) && !route.path.startsWith("/api/conversations/")
    ? `${filled}?conversation=${conversation}`
    : filled;
};

const send = (client: HttpClient.HttpClient, route: Route, url: string) =>
  client
    .execute(
      HttpClientRequest.make(
        route.method as "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
      )(url).pipe(
        route.method === "GET" || route.method === "DELETE"
          ? (request) => request
          : HttpClientRequest.setBody(HttpBody.text("{}", "application/json"))
      )
    )
    .pipe(
      Effect.flatMap((response) =>
        Effect.gen(function* () {
          return { status: response.status, body: yield* response.text };
        })
      ),
      Effect.scoped
    );

/** POST a 64×64 PNG to `conversation` as `client`; the upload's id and status. */
const uploadImage = (client: HttpClient.HttpClient, conversation: number) =>
  Effect.gen(function* () {
    const png = yield* Effect.promise(() =>
      sharp({
        create: { width: 64, height: 64, channels: 3, background: "#e07a5f" },
      })
        .png()
        .toBuffer()
    );
    const data = new FormData();
    data.append(
      "file",
      new Blob([new Uint8Array(png)], { type: "image/png" }),
      "dot.png"
    );
    data.append("conversation", String(conversation));
    const response = yield* client.execute(
      HttpClientRequest.post("/api/attachments").pipe(
        HttpClientRequest.setBody(HttpBody.formData(data))
      )
    );
    const body = (yield* response.json) as { id?: string };
    return { status: response.status, id: body.id ?? "" };
  }).pipe(Effect.scoped);

describe("isolation between Users", () => {
  it("serves an attachment's images to whoever holds its id, only with its own conversation", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const alice = yield* HttpApiClient.make(Api);
        const created = yield* alice.conversations.create({
          payload: { sandbox: "none", prompt: "a picture" },
        });
        const signed = yield* HttpClient.HttpClient;
        const uploaded = yield* uploadImage(signed, created.id);
        // An artifact's iframe sends no cookie at all.
        const anonymous = HttpClient.mapRequest(
          signed,
          HttpClientRequest.removeHeader("cookie")
        );
        const status = (url: string) =>
          anonymous.get(url).pipe(
            Effect.map((response) => response.status),
            Effect.scoped
          );
        const base = `/api/attachments/${uploaded.id}`;
        return {
          uploaded: uploaded.status,
          thumbnail: yield* status(
            `${base}/thumbnail?conversation=${created.id}`
          ),
          otherConversation: yield* status(
            `${base}/thumbnail?conversation=${created.id + 1}`
          ),
          guessedId: yield* status(
            `/api/attachments/att_${"0".repeat(32)}/thumbnail?conversation=${created.id}`
          ),
          original: yield* status(
            `${base}/original?conversation=${created.id}`
          ),
          view: yield* status(`${base}/view?conversation=${created.id}`),
        };
      }).pipe(Effect.provide(server()))
    );
    expect(result).toStrictEqual({
      uploaded: 201,
      thumbnail: 200,
      otherConversation: 404,
      guessedId: 404,
      original: 401,
      view: 401,
    });
  }, 30_000);

  it("covers every endpoint the API defines", () => {
    expect(
      [
        "conversations.events",
        "files.tree",
        "artifacts.render",
        "attachments.original",
      ].filter((name) =>
        routes.some((route) => route.name === name && scopedBy(route))
      )
    ).toHaveLength(4);
  });

  it("answers 401 to every endpoint outside auth without a session", async () => {
    const statuses = await Effect.runPromise(
      Effect.gen(function* () {
        const bare = yield* HttpClient.HttpClient;
        const anonymous = HttpClient.mapRequest(
          bare,
          HttpClientRequest.removeHeader("cookie")
        );
        const answered: (readonly [string, number])[] = [];
        for (const route of routes) {
          const response = yield* send(anonymous, route, urlOf(route, 0));
          answered.push([route.name, response.status]);
        }
        return answered;
      }).pipe(Effect.provide(server()))
    );
    expect(statuses.filter(([, status]) => status !== 401)).toStrictEqual([]);
  }, 30_000);

  it("shows one User nothing of another's, and refuses every route addressed by their Conversation", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const alice = yield* HttpApiClient.make(Api);
        const created = yield* alice.conversations.create({
          payload: { sandbox: "shell", prompt: `about the ${SECRET}` },
        });
        yield* alice.trustedDomains.add({
          payload: { domain: "cdn.alice.com" },
        });
        // The run writes the artifact and answers; wait for it so every listing has something to leak.
        for (let attempt = 0; attempt < 500; attempt += 1) {
          const [listed] = yield* alice.conversations.list();
          const pages = yield* alice.artifacts.list({ query: {} });
          if (listed?.status === "idle" && pages.length > 0) {
            break;
          }
          yield* Effect.sleep("10 millis");
        }
        // Run-end indexing is forked; poll until Alice's own search finds the run.
        let hits = yield* alice.search.query({ query: { q: SECRET } });
        for (
          let attempt = 0;
          attempt < 300 && hits.length === 0;
          attempt += 1
        ) {
          yield* Effect.sleep("10 millis");
          hits = yield* alice.search.query({ query: { q: SECRET } });
        }

        const bob = yield* signIn("bob");
        const asBob = yield* HttpApiClient.make(Api).pipe(
          Effect.provideService(HttpClient.HttpClient, bob.client)
        );
        const scoped: { route: string; status: number; body: string }[] = [];
        for (const route of routes.filter(scopedBy)) {
          const response = yield* send(
            bob.client,
            route,
            urlOf(route, created.id)
          );
          scoped.push({ route: route.name, ...response });
        }
        const uploadData = new FormData();
        uploadData.append(
          "file",
          new Blob(["hello"], { type: "text/plain" }),
          "a.txt"
        );
        uploadData.append("conversation", String(created.id));
        const upload = yield* bob.client
          .execute(
            HttpClientRequest.post("/api/attachments").pipe(
              HttpClientRequest.setBody(HttpBody.formData(uploadData))
            )
          )
          .pipe(
            Effect.map((response) => response.status),
            Effect.scoped
          );

        const { port } = (yield* HttpServer.HttpServer)
          .address as NetAddress.InetAddress;
        const shell = yield* Effect.callback<number>((resume) => {
          const ws = new NodeWS.WebSocket(
            `ws://127.0.0.1:${port}/api/conversations/${created.id}/shell`,
            { headers: { cookie: bob.cookie } }
          );
          ws.on("unexpected-response", (_request, response) => {
            resume(Effect.succeed(response.statusCode ?? 0));
            ws.on("error", () => {});
            ws.terminate();
          });
          ws.on("open", () => {
            resume(Effect.succeed(101));
            ws.close();
          });
        });

        return {
          aliceSaw: {
            conversations: (yield* alice.conversations.list()).length,
            artifacts: (yield* alice.artifacts.list({ query: {} })).length,
            hits: hits.length > 0,
            domains: yield* alice.trustedDomains.list(),
            holdsCapacity: (yield* alice.info.capacity()).some(
              (usage) => usage.holders.length > 0
            ),
          },
          bobSaw: {
            conversations: yield* asBob.conversations.list(),
            artifacts: yield* asBob.artifacts.list({ query: {} }),
            search: yield* asBob.search.query({ query: { q: SECRET } }),
            recent: yield* asBob.search.query({ query: { q: "" } }),
            domains: yield* asBob.trustedDomains.list(),
            holders: (yield* asBob.info.capacity()).flatMap((usage) => [
              ...usage.holders,
              ...usage.waiting,
            ]),
          },
          scoped,
          upload,
          shell,
        };
      }).pipe(Effect.provide(server()))
    );

    // Alice's side is populated, so Bob's empty answers are isolation, not an empty server.
    expect(result.aliceSaw).toStrictEqual({
      conversations: 1,
      artifacts: 1,
      hits: true,
      domains: ["cdn.alice.com"],
      holdsCapacity: true,
    });
    expect(result.bobSaw).toStrictEqual({
      conversations: [],
      artifacts: [],
      search: [],
      recent: [],
      domains: [],
      holders: [],
    });
    expect({
      notRefused: result.scoped.filter(
        (response) =>
          response.status !== 404 ||
          !response.body.includes("ConversationNotFound")
      ),
      leaked: result.scoped.filter((response) =>
        response.body.includes(SECRET)
      ),
      upload: result.upload,
      shell: result.shell,
    }).toStrictEqual({ notRefused: [], leaked: [], upload: 404, shell: 404 });
  }, 60_000);
});
