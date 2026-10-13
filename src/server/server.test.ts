import type { FauxResponseStep } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxText,
} from "@earendil-works/pi-ai/providers/faux";
import { NodeHttpServer } from "@effect/platform-node";
import { Effect, Exit, Layer, Stream } from "effect";
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import { describe, expect, it } from "vitest";

import { Agents } from "../agents.ts";
import type { AgentError } from "../agents.ts";
import { Skills } from "../skills/skills.ts";
import { fauxAgents } from "../testing/faux.ts";
import { fakeMcpServer } from "../testing/mcp.ts";
import { localSandboxes } from "../testing/sandboxes.ts";
import { Api } from "./api.ts";
import { Conversations } from "./conversations.ts";
import { echoModel } from "./faux.ts";
import { ApiLayer } from "./handlers.ts";

const serverWith = (
  agents: Layer.Layer<Agents, AgentError>,
  maxSandboxes = 3
) =>
  HttpRouter.serve(ApiLayer, {
    disableListenLog: true,
    disableLogger: true,
  }).pipe(
    Layer.provide(
      Conversations.layer({
        maxSandboxes,
        idleTimeoutMs: 60_000,
        sweepEveryMs: 60_000,
      })
    ),
    Layer.provide(agents),
    Layer.provideMerge(NodeHttpServer.layerTest)
  );

const server = (responses: FauxResponseStep[], maxSandboxes = 3) =>
  serverWith(fauxAgents(responses).layer, maxSandboxes);

describe("HTTP API", () => {
  it("lists skills and MCP servers", async () => {
    const echo = fakeMcpServer("test", [
      { name: "echo", call: () => ({ content: [] }) },
    ]);
    const capabilities = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* HttpApiClient.make(Api);
        return yield* client.info.capabilities();
      }).pipe(
        Effect.provide(
          serverWith(
            fauxAgents([fauxAssistantMessage([fauxText("ok")])], {
              skills: Skills.directory("skills"),
              mcp: [echo],
            }).layer
          )
        )
      )
    );
    expect(capabilities.skills.map((s) => s.name)).toContain("unit-conversion");
    expect(capabilities.mcp).toStrictEqual([
      {
        name: "test",
        url: "memory://test",
        status: "connected",
        tools: [{ name: "echo", description: "" }],
      },
    ]);
  });

  it("expands /skill: on create and refuses an unknown skill on send", async () => {
    const agents = fauxAgents(
      [
        fauxAssistantMessage([fauxText("one")]),
        fauxAssistantMessage([fauxText("two")]),
      ],
      { skills: Skills.directory("skills") }
    );
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* HttpApiClient.make(Api);
        const created = yield* client.conversations.create({
          payload: {
            sandbox: "none",
            prompt: "/skill:unit-conversion 3 mi to km",
          },
        });
        const stream = yield* client.conversations.events({
          params: { id: created.id },
        });
        const events = yield* stream.pipe(
          Stream.takeUntil(
            (event) =>
              typeof event === "object" &&
              event !== null &&
              "type" in event &&
              (event.type === "run_end" ||
                (event.type === "snapshot" &&
                  JSON.stringify(event).includes('"one"')))
          ),
          Stream.runCollect
        );
        const unknown = yield* Effect.flip(
          client.conversations.send({
            params: { id: created.id },
            payload: { prompt: "/skill:nope hi" },
          })
        );
        return { created, unknown, events: JSON.stringify([...events]) };
      }).pipe(Effect.provide(serverWith(agents.layer)))
    );
    expect(result.created.title).toBe("/skill:unit-conversion 3 mi to km");
    expect(result.events).toContain('<skill name=\\"unit-conversion\\">');
    expect(result.events).toContain("3 mi to km");
    expect(result.unknown).toMatchObject({
      _tag: "SkillNotFound",
      name: "nope",
    });
    // The rejected send queued nothing: only the first prompt reached the model.
    expect(agents.faux.state.callCount).toBe(1);
  });

  it("refuses requests from a non-loopback origin", async () => {
    const statuses = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        const post = (origin: string) =>
          client
            .execute(
              HttpClientRequest.post("/api/conversations").pipe(
                HttpClientRequest.setHeader("origin", origin),
                HttpClientRequest.bodyJsonUnsafe({
                  sandbox: "none",
                  prompt: "hi",
                })
              )
            )
            .pipe(Effect.map((response) => response.status));
        return [
          yield* post("https://evil.example"),
          yield* post("http://localhost:3001"),
        ];
      }).pipe(Effect.provide(server([fauxAssistantMessage([fauxText("ok")])])))
    );

    expect(statuses).toStrictEqual([403, 201]);
  });

  it("creates a conversation and streams its events over SSE", async () => {
    const events = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* HttpApiClient.make(Api);
        const created = yield* client.conversations.create({
          payload: { sandbox: "none", prompt: "Capital of France?" },
        });
        const stream = yield* client.conversations.events({
          params: { id: created.id },
        });
        return [
          ...(yield* stream.pipe(
            // The run may finish before the stream attaches, then the snapshot already holds the answer.
            Stream.takeUntil(
              (event) =>
                typeof event === "object" &&
                event !== null &&
                "type" in event &&
                (event.type === "run_end" ||
                  (event.type === "snapshot" &&
                    JSON.stringify(event).includes("Paris.")))
            ),
            Stream.runCollect
          )),
        ];
      }).pipe(
        Effect.provide(server([fauxAssistantMessage([fauxText("Paris.")])]))
      )
    );

    expect(events[0]).toMatchObject({ type: "snapshot" });
    expect(JSON.stringify(events)).toContain("Paris.");
  });

  it("lists, sends to and ends conversations", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* HttpApiClient.make(Api);
        const created = yield* client.conversations.create({
          payload: { sandbox: "shell", prompt: "hello" },
        });
        const listed = yield* client.conversations.list();
        expect(listed.map((c) => c.id)).toStrictEqual([created.id]);
        expect(listed[0]?.title).toBe("hello");
        yield* client.conversations.send({
          params: { id: created.id },
          payload: { prompt: "again" },
        });
        yield* client.conversations.end({ params: { id: created.id } });
        // Ended conversations stay listed.
        expect(
          (yield* client.conversations.list()).map((c) => [
            c.id,
            c.status,
            c.endedReason,
          ])
        ).toStrictEqual([[created.id, "ended", "ended"]]);
        const info = yield* client.info.get();
        expect(info.model).toBe("faux/faux-1");
      }).pipe(
        Effect.provide(
          server([
            fauxAssistantMessage([fauxText("one")]),
            fauxAssistantMessage([fauxText("two")]),
          ])
        )
      )
    );
  });

  it("answers 404 for unknown conversations and 409 past the sandbox cap", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* HttpApiClient.make(Api);
        const missing = yield* Effect.exit(
          client.conversations.end({ params: { id: 424_242 } })
        );
        expect(Exit.isFailure(missing)).toBeTruthy();
        expect(JSON.stringify(missing)).toContain("ConversationNotFound");
        const missingEvents = yield* Effect.exit(
          client.conversations.events({ params: { id: 424_242 } })
        );
        expect(JSON.stringify(missingEvents)).toContain("ConversationNotFound");

        yield* client.conversations.create({
          payload: { sandbox: "shell", prompt: "1" },
        });
        const second = yield* Effect.exit(
          client.conversations.create({
            payload: { sandbox: "shell", prompt: "2" },
          })
        );
        expect(JSON.stringify(second)).toContain("SandboxLimitReached");
      }).pipe(
        Effect.provide(server([fauxAssistantMessage([fauxText("a")])], 1))
      )
    );
  });

  it("the echo model answers every prompt", async () => {
    const { models, model } = echoModel();
    const sandboxes = localSandboxes();
    const agents = Agents.layer({ models, model }).pipe(
      Layer.provide(sandboxes.layer),
      Layer.provide(Skills.none)
    );

    const text = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* HttpApiClient.make(Api);
        const created = yield* client.conversations.create({
          payload: { sandbox: "none", prompt: "ping" },
        });
        yield* client.conversations.send({
          params: { id: created.id },
          payload: { prompt: "pong" },
        });
        const stream = yield* client.conversations.events({
          params: { id: created.id },
        });
        const seen: unknown[] = [];
        yield* stream.pipe(
          Stream.takeUntil((event) => {
            seen.push(event);
            return JSON.stringify(seen).includes("echo: pong");
          }),
          Stream.runDrain
        );
        return JSON.stringify(seen);
      }).pipe(Effect.provide(serverWith(agents)))
    );

    expect(text).toContain("echo: ping");
    expect(text).toContain("echo: pong");
  });
});
