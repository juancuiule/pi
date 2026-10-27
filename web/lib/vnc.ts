import { serverSocketUrl } from "./server-socket";

/**
 * The desktop's socket: the server relays it to the Sandbox's VNC server (src/server/desktop.ts), and the console's
 * own noVNC client draws it, so nothing the Sandbox serves runs in this origin.
 */
export const desktopUrl = (options: {
  readonly apiUrl: string;
  readonly pageOrigin: string;
  readonly conversation: number;
}): string =>
  serverSocketUrl({
    apiUrl: options.apiUrl,
    pageOrigin: options.pageOrigin,
    pathname: `/api/conversations/${options.conversation}/desktop`,
  });
