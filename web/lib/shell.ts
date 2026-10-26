// The interactive shell's socket (src/server/shell.ts): binary frames carry the PTY in both directions, a text
// frame {"type":"resize","columns":n,"rows":n} resizes it, and the server announces the end with
// {"type":"closed","reason":...} before its CloseEvent; {"type":"open",...} is the shell's `open` command,
// sent only while it happens, never for scrollback. Where the socket goes is `serverSocketUrl`'s rule.
import { serverSocketUrl } from "./server-socket";
import { normalizeWorkspacePath, WORKSPACE_ROOT } from "./workspace-links";
import type {
  OpenTarget,
  WorkspaceIndex,
  WorkspaceKind,
} from "./workspace-links";

const CLOSE_REASONS = [
  "exited",
  "sandbox",
  "disconnected",
  "unavailable",
] as const;
export type ShellCloseReason = (typeof CLOSE_REASONS)[number];

export interface ShellOptions {
  /** The server's own http URL, from /api/info. */
  apiUrl: string;
  /** The origin this page was loaded from (`window.location.origin`). */
  pageOrigin: string;
  conversation: number;
  columns: number;
  rows: number;
}

/** An `open` frame as received: an absolute container path, untrusted until shellOpenTargetOf. */
export interface ShellOpen {
  readonly path: string;
  readonly kind: WorkspaceKind;
}

/** A text frame from the server. */
export type ShellControl =
  | { readonly type: "closed"; readonly reason: ShellCloseReason }
  | { readonly type: "open"; readonly open: ShellOpen };

/** A server text frame, or undefined for anything else. A `closed` reason it does not know is unavailable. */
export const shellControlOf = (text: string): ShellControl | undefined => {
  let message: unknown;
  try {
    message = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof message !== "object" || message === null || !("type" in message)) {
    return undefined;
  }
  if (
    message.type === "closed" &&
    "reason" in message &&
    typeof message.reason === "string"
  ) {
    return {
      type: "closed",
      reason: (CLOSE_REASONS as readonly string[]).includes(message.reason)
        ? (message.reason as ShellCloseReason)
        : "unavailable",
    };
  }
  if (
    message.type === "open" &&
    "path" in message &&
    typeof message.path === "string" &&
    "kind" in message &&
    (message.kind === "file" || message.kind === "directory")
  ) {
    return { type: "open", open: { path: message.path, kind: message.kind } };
  }
  return undefined;
};

/**
 * Where an `open` from the shell lands. A file opens even when the tree index does not list it
 * (node_modules, past the cap): `open` saw it exist and /files/content confines the read. The tree can
 * only expand a folder it listed, so a folder reveals its nearest listed ancestor, or else the root.
 */
export const shellOpenTargetOf = (
  open: ShellOpen,
  index: WorkspaceIndex
): OpenTarget | undefined => {
  if (open.path === "/workspace") {
    return WORKSPACE_ROOT;
  }
  if (!open.path.startsWith("/workspace/")) {
    return undefined;
  }
  const path = normalizeWorkspacePath(open.path);
  if (path === undefined) {
    return undefined;
  }
  if (open.kind === "file") {
    return { path, kind: "file" };
  }
  for (const segments = path.split("/"); segments.length > 0; segments.pop()) {
    const ancestor = normalizeWorkspacePath(segments.join("/"));
    if (ancestor !== undefined && index.get(ancestor) === "directory") {
      return { path: ancestor, kind: "directory" };
    }
  }
  return WORKSPACE_ROOT;
};

/** The socket's URL: the shell route, with the PTY's size in the query. */
export const shellUrl = ({
  apiUrl,
  pageOrigin,
  conversation,
  columns,
  rows,
}: ShellOptions): string =>
  serverSocketUrl({
    apiUrl,
    pageOrigin,
    pathname: `/api/conversations/${conversation}/shell`,
    search: `cols=${columns}&rows=${rows}`,
  });

/** One shell session's socket. Reconnects are the caller's: a closed session stays closed. */
export interface Shell {
  /** Raw PTY stdin. Bytes sent while the socket connects go once it opens; after close they are dropped. */
  send(bytes: Uint8Array): void;
  /** The `resize` control frame; ignored while the socket is connecting or for an empty size. */
  resize(columns: number, rows: number): void;
  /** PTY output frames, as they arrive. */
  onOutput(cb: (bytes: Uint8Array) => void): void;
  /**
   * Once, when the session ends: with the server's `closed` reason, or "disconnected" when the socket drops
   * without one. `close()` does not fire it.
   */
  onClosed(cb: (reason: ShellCloseReason) => void): void;
  /** Each `open` the person runs while this socket is attached. */
  onOpen(cb: (open: ShellOpen) => void): void;
  close(): void;
}

export const connectShell = (options: ShellOptions): Shell => {
  const socket = new WebSocket(shellUrl(options));
  socket.binaryType = "arraybuffer";
  const pending: Uint8Array<ArrayBuffer>[] = [];
  let output: ((bytes: Uint8Array) => void) | undefined;
  let closed: ((reason: ShellCloseReason) => void) | undefined;
  let opened: ((open: ShellOpen) => void) | undefined;
  // The server's `closed` frame wins over the socket's own drop as the reported reason.
  let reason: ShellCloseReason | undefined;
  let ended = false;

  const finish = (withReason: ShellCloseReason) => {
    if (ended) {
      return;
    }
    ended = true;
    closed?.(withReason);
  };

  socket.addEventListener("open", () => {
    for (const bytes of pending.splice(0)) {
      socket.send(bytes);
    }
  });
  socket.addEventListener(
    "message",
    (event: MessageEvent<string | ArrayBuffer>) => {
      if (typeof event.data === "string") {
        const control = shellControlOf(event.data);
        if (control?.type === "closed") {
          ({ reason } = control);
          finish(control.reason);
        } else if (control?.type === "open" && !ended) {
          opened?.(control.open);
        }
        return;
      }
      if (!ended) {
        output?.(new Uint8Array(event.data));
      }
    }
  );
  socket.addEventListener("close", () => finish(reason ?? "disconnected"));

  return {
    send: (bytes) => {
      if (ended) {
        return;
      }
      // The copy is ArrayBuffer-backed (what send() takes) and pins the bytes queued while connecting.
      const frame = new Uint8Array(bytes);
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(frame);
      } else if (socket.readyState === WebSocket.CONNECTING) {
        pending.push(frame);
      }
    },
    resize: (columns, rows) => {
      if (ended || columns <= 0 || rows <= 0) {
        return;
      }
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "resize", columns, rows }));
      }
    },
    // oxlint-disable-next-line promise/prefer-await-to-callbacks -- event registration, not a computation to await
    onOutput: (cb) => {
      output = cb;
    },
    // oxlint-disable-next-line promise/prefer-await-to-callbacks -- event registration, not a computation to await
    onClosed: (cb) => {
      closed = cb;
    },
    // oxlint-disable-next-line promise/prefer-await-to-callbacks -- event registration, not a computation to await
    onOpen: (cb) => {
      opened = cb;
    },
    close: () => {
      ended = true;
      pending.length = 0;
      socket.close();
    },
  };
};
