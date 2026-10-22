// Traces go to Langfuse, which is for the agents' work, and the console polls this server every couple of seconds:
// left alone, every poll was a trace named "GET". So reads leave no trace at all, neither the server span nor the
// spans of the services they call. Any other request keeps its span, named by method and route shape.
import { Effect, Layer } from "effect";
import { HttpMiddleware, HttpRouter, HttpServerRequest } from "effect/http";

/** Whether a request is traced: everything but reads (polls, SSE streams, the shell's socket). */
export const isTracedRequest = (request: { readonly method: string }) =>
  request.method !== "GET" && request.method !== "HEAD";

/** A request's span name: its method and path, with each segment holding a digit (an id) as `:id`. */
export const requestSpanName = (request: {
  readonly method: string;
  readonly url: string;
}) => {
  const path = request.url.split("?")[0] ?? "";
  const route = path
    .split("/")
    .map((segment) => (/\d/u.test(segment) ? ":id" : segment))
    .join("/");
  return `${request.method} ${route}`;
};

/**
 * Merged into the routes: turns off the spans a read's handler would open. The server span is opened outside every
 * middleware, so `httpTracingReferences` turns that one off.
 */
export const httpTracingMiddleware = HttpRouter.middleware(
  (httpEffect) =>
    HttpServerRequest.HttpServerRequest.pipe(
      Effect.flatMap((request) =>
        isTracedRequest(request)
          ? httpEffect
          : httpEffect.pipe(Effect.withTracerEnabled(false))
      )
    ),
  { global: true }
);

/** Provided to `HttpRouter.serve`: no server span for a read, and the others named by `requestSpanName`. */
export const httpTracingReferences = Layer.mergeAll(
  Layer.succeed(HttpMiddleware.TracerDisabledWhen)(
    (request) => !isTracedRequest(request)
  ),
  Layer.succeed(HttpMiddleware.SpanNameGenerator)(requestSpanName)
);
