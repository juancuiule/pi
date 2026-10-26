// Where the console opens a WebSocket to the server (the shell, the desktop). The console's /api rewrite cannot
// proxy WebSockets, so a socket goes to the server's own apiUrl (from /api/info), not this page's origin. The session
// cookie was set on the page's host, and cookies are per host, not per port, so a loopback server is reached under
// the page's own loopback name: a page on localhost:3001 and an apiUrl of 127.0.0.1:4000 make ws://localhost:4000.
// A page served through a tunnel (PUBLIC_URL) cannot reach the server's loopback address at all, so its socket goes
// to the page's own origin, and the tunnel routes the socket paths to the server (docs/deploy/raspberry-pi.md).

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The socket URL for `pathname` on the server: `apiUrl` with the ws scheme; its host is the page's when both are
 * loopback, so the browser sends the session cookie, and it is the page's whole origin when only the server is
 * loopback (a page served through a tunnel).
 */
export const serverSocketUrl = ({
  apiUrl,
  pageOrigin,
  pathname,
  search = "",
}: {
  /** The server's own http URL, from /api/info. */
  readonly apiUrl: string;
  /** The origin this page was loaded from (`window.location.origin`). */
  readonly pageOrigin: string;
  readonly pathname: string;
  readonly search?: string;
}): string => {
  const page = new URL(pageOrigin);
  const server = new URL(apiUrl);
  const serverLoopback = LOOPBACK.has(server.hostname);
  const url = serverLoopback && !LOOPBACK.has(page.hostname) ? page : server;
  if (serverLoopback && LOOPBACK.has(page.hostname)) {
    url.hostname = page.hostname;
  }
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = pathname;
  url.search = search;
  return url.toString();
};
