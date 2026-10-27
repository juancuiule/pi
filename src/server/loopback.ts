// The server listens on 127.0.0.1 only, but binding there does not stop a browser: any page can POST to
// http://127.0.0.1:4000, and a DNS-rebound name reaches it too. So every request must name a loopback host, and a
// browser's Origin (and the Next proxy's X-Forwarded-Host) must be loopback as well. Non-browser clients send no
// Origin and pass on Host alone. A `publicUrl` (PUBLIC_URL: a tunnel such as cloudflared that forwards to this
// machine) is accepted beside loopback: its exact host in Host and X-Forwarded-Host, its exact origin in Origin.
import { Effect } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

type Headers = Readonly<Record<string, string | undefined>>;

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

/** Whether `host` (a Host-style header) is the public URL's host, port included. */
const isPublicHost = (host: string, publicUrl: URL | undefined) =>
  publicUrl !== undefined && hostUrl(host)?.host === publicUrl.host;

export interface AllowedOrigins {
  /** The ports a browser page may call from: the console's and this server's. Unset, any loopback port. */
  readonly pagePorts?: readonly number[] | undefined;
  /** Where a tunnel serves the console from the outside (`PUBLIC_URL`); accepted beside loopback. */
  readonly publicUrl?: URL | undefined;
}

/**
 * Whether a request with these headers comes from this machine's own pages or tools, or through the public URL.
 * With `pagePorts`, a loopback browser Origin (and the Next proxy's X-Forwarded-Host) must also be on one of them.
 */
export const isLoopbackRequest = (
  headers: Headers,
  options: AllowedOrigins = {}
): boolean => {
  const { host, origin } = headers;
  const forwardedHost = headers["x-forwarded-host"];
  const { publicUrl } = options;
  const ports =
    options.pagePorts === undefined ? undefined : new Set(options.pagePorts);
  return (
    host !== undefined &&
    (isAllowedPage(hostUrl(host)) || isPublicHost(host, publicUrl)) &&
    (origin === undefined ||
      isAllowedPage(originUrl(origin), ports) ||
      (publicUrl !== undefined && origin === publicUrl.origin)) &&
    (forwardedHost === undefined ||
      isAllowedPage(hostUrl(forwardedHost), ports) ||
      isPublicHost(forwardedHost, publicUrl))
  );
};

/**
 * Whether the request reached this server through an https public URL, so the browser sees https and a `Secure`
 * session cookie is stored. Read after `loopbackOnly` accepted the request.
 */
export const viaHttpsPublicUrl = (
  headers: Headers,
  publicUrl?: URL
): boolean => {
  if (publicUrl?.protocol !== "https:") {
    return false;
  }
  const forwardedHost = headers["x-forwarded-host"];
  return forwardedHost === undefined
    ? isPublicHost(headers.host ?? "", publicUrl)
    : isPublicHost(forwardedHost, publicUrl);
};

/** Global middleware that answers 403 to any request `isLoopbackRequest` rejects. */
export const loopbackOnly = (options: AllowedOrigins) =>
  HttpRouter.middleware(
    (httpEffect) =>
      HttpServerRequest.HttpServerRequest.pipe(
        Effect.flatMap((request) =>
          isLoopbackRequest(request.headers, options)
            ? httpEffect
            : Effect.succeed(
                HttpServerResponse.text("Forbidden origin", { status: 403 })
              )
        )
      ),
    { global: true }
  );
