// The server has no auth and only serves this machine, but binding to 127.0.0.1 does not stop a
// browser: any page can POST to http://127.0.0.1:4000, and a DNS-rebound name reaches it too. So every
// request must name a loopback host, and a browser's Origin (and the Next proxy's X-Forwarded-Host)
// must be loopback as well. Non-browser clients send no Origin and pass on Host alone.
import { Effect } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

const isLoopbackHost = (host: string): boolean => {
  try {
    return LOOPBACK.has(new URL(`http://${host}`).hostname);
  } catch {
    return false;
  }
};

const isLoopbackOrigin = (origin: string): boolean => {
  try {
    return LOOPBACK.has(new URL(origin).hostname);
  } catch {
    return false;
  }
};

/** Whether a request with these headers comes from this machine's own pages or tools. */
export const isLoopbackRequest = (
  headers: Readonly<Record<string, string | undefined>>
): boolean => {
  const { host, origin } = headers;
  const forwardedHost = headers["x-forwarded-host"];
  return (
    host !== undefined &&
    isLoopbackHost(host) &&
    (origin === undefined || isLoopbackOrigin(origin)) &&
    (forwardedHost === undefined || isLoopbackHost(forwardedHost))
  );
};

/** Global middleware that answers 403 to any request `isLoopbackRequest` rejects. */
export const loopbackOnly = HttpRouter.middleware(
  (httpEffect) =>
    HttpServerRequest.HttpServerRequest.pipe(
      Effect.flatMap((request) =>
        isLoopbackRequest(request.headers)
          ? httpEffect
          : Effect.succeed(
              HttpServerResponse.text("Forbidden origin", { status: 403 })
            )
      )
    ),
  { global: true }
);
