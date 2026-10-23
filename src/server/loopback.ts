// The server only serves this machine (sessions travel over plain http), but binding to 127.0.0.1 does not
// stop a browser: any page can POST to http://127.0.0.1:4000, and a DNS-rebound name reaches it too. So every
// request must name a loopback host, and a browser's Origin (and the Next proxy's X-Forwarded-Host)
// must be loopback as well. Non-browser clients send no Origin and pass on Host alone.
import { Effect } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** A host's URL, or `undefined` when `host` is not one. */
const hostUrl = (host: string): URL | undefined => {
  try {
    return new URL(`http://${host}`);
  } catch {
    return undefined;
  }
};

const originUrl = (origin: string): URL | undefined => {
  try {
    return new URL(origin);
  } catch {
    return undefined;
  }
};

const DEFAULT_PORT: Readonly<Record<string, number>> = {
  "http:": 80,
  "https:": 443,
};

const portOf = (url: URL) =>
  url.port === "" ? DEFAULT_PORT[url.protocol] : Number(url.port);

/**
 * Whether a browser's page at `url` may drive the API: a loopback host, on one of `ports` when given. Ports matter
 * once sessions exist: a session cookie is sent to every port of the host, so a page served by any other local
 * program would otherwise act as the signed-in User.
 */
const isAllowedPage = (url: URL | undefined, ports?: ReadonlySet<number>) =>
  url !== undefined &&
  LOOPBACK.has(url.hostname) &&
  (ports === undefined || ports.has(portOf(url) ?? 0));

/**
 * Whether a request with these headers comes from this machine's own pages or tools. With `pagePorts`, a browser's
 * Origin (and the Next proxy's X-Forwarded-Host) must also be on one of them: the console's and this server's.
 */
export const isLoopbackRequest = (
  headers: Readonly<Record<string, string | undefined>>,
  pagePorts?: readonly number[]
): boolean => {
  const { host, origin } = headers;
  const forwardedHost = headers["x-forwarded-host"];
  const ports = pagePorts === undefined ? undefined : new Set(pagePorts);
  return (
    host !== undefined &&
    isAllowedPage(hostUrl(host)) &&
    (origin === undefined || isAllowedPage(originUrl(origin), ports)) &&
    (forwardedHost === undefined ||
      isAllowedPage(hostUrl(forwardedHost), ports))
  );
};

/**
 * Global middleware that answers 403 to any request `isLoopbackRequest` rejects. `pagePorts` unset accepts a page
 * on any loopback port (tests).
 */
export const loopbackOnly = (options: {
  readonly pagePorts?: readonly number[] | undefined;
}) =>
  HttpRouter.middleware(
    (httpEffect) =>
      HttpServerRequest.HttpServerRequest.pipe(
        Effect.flatMap((request) =>
          isLoopbackRequest(request.headers, options.pagePorts)
            ? httpEffect
            : Effect.succeed(
                HttpServerResponse.text("Forbidden origin", { status: 403 })
              )
        )
      ),
    { global: true }
  );
