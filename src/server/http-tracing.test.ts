import { NodeHttpServer } from "@effect/platform-node";
import { Effect, Layer, Tracer } from "effect";
import { HttpClient, HttpRouter, HttpServerResponse } from "effect/http";
import { describe, expect, it } from "vitest";

import {
  httpTracingMiddleware,
  httpTracingReferences,
  requestSpanName,
} from "./http-tracing.ts";

const recordingTracer = () => {
  const spans: Tracer.NativeSpan[] = [];
  const tracer = Tracer.make({
    span(options) {
      const span = new Tracer.NativeSpan(options);
      spans.push(span);
      return span;
    },
  });
  return { spans, tracer };
};

const handled = Effect.succeed(HttpServerResponse.text("ok")).pipe(
  Effect.withSpan("Service.call")
);

const routes = Layer.mergeAll(
  HttpRouter.add("GET", "/api/conversations/:id", handled),
  HttpRouter.add("POST", "/api/conversations/:id/messages", handled),
  httpTracingMiddleware
);

/** The server's spans (not the test client's) after one request, as "name < parent". */
const serverSpansOf = async (
  request: (client: HttpClient.HttpClient) => Effect.Effect<unknown, unknown>
) => {
  const { spans, tracer } = recordingTracer();
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* request(yield* HttpClient.HttpClient);
    }).pipe(
      Effect.provide(
        HttpRouter.serve(routes, {
          disableListenLog: true,
          disableLogger: true,
        }).pipe(
          Layer.provide(httpTracingReferences),
          Layer.provideMerge(NodeHttpServer.layerTest)
        )
      ),
      Effect.provideService(Tracer.Tracer, tracer)
    )
  );
  return spans
    .filter((span) => span.kind !== "client")
    .map(
      (span) =>
        `${span.name} < ${span.parent._tag === "Some" && span.parent.value._tag === "Span" ? span.parent.value.name : "-"}`
    );
};

describe("HTTP tracing", () => {
  it("leaves reads untraced, the server span and the spans it would parent", async () => {
    await expect(
      serverSpansOf((client) => client.get("/api/conversations/7"))
    ).resolves.toStrictEqual([]);
  });

  it("names a write's span by its route shape, parenting what it calls", async () => {
    await expect(
      serverSpansOf((client) => client.post("/api/conversations/7/messages"))
    ).resolves.toStrictEqual([
      "POST /api/conversations/:id/messages < -",
      "Service.call < POST /api/conversations/:id/messages",
    ]);
  });
});

describe(requestSpanName, () => {
  it("replaces ids and drops the query", () => {
    expect(
      requestSpanName({
        method: "PATCH",
        url: "/api/attachments/att_3fa9/pages/2?conversation=12",
      })
    ).toBe("PATCH /api/attachments/:id/pages/:id");
  });
});
