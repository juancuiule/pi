// The interactive shell's socket (src/server/shell.ts): binary frames carry the PTY in both directions, a text
// frame {"type":"resize","columns":n,"rows":n} resizes it, and the server announces the end with
// {"type":"closed","reason":...} before its CloseEvent. The console's /api rewrite cannot proxy WebSockets, so
// the socket goes to the server's own apiUrl (from /api/info), not this page's origin.

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
  conversation: number;
  columns: number;
  rows: number;
}

/** The reason of a `closed` text frame, or undefined when the frame is something else. */
export const shellClosedReason = (
  text: string
): ShellCloseReason | undefined => {
  try {
    const message: unknown = JSON.parse(text);
    if (
      typeof message === "object" &&
      message !== null &&
      "type" in message &&
      message.type === "closed" &&
      "reason" in message &&
      typeof message.reason === "string"
    ) {
      return (CLOSE_REASONS as readonly string[]).includes(message.reason)
        ? (message.reason as ShellCloseReason)
        : "unavailable";
    }
  } catch {
    // Not JSON: not a control frame.
  }
  return undefined;
};

/** The socket's URL: `apiUrl` with the ws scheme, the shell route and the PTY's size in the query. */
export const shellUrl = ({
  apiUrl,
  conversation,
  columns,
  rows,
}: ShellOptions): string => {
  const url = new URL(apiUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `/api/conversations/${conversation}/shell`;
  url.search = `cols=${columns}&rows=${rows}`;
  return url.toString();
};

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
  close(): void;
}

export const connectShell = (options: ShellOptions): Shell => {
  const socket = new WebSocket(shellUrl(options));
  socket.binaryType = "arraybuffer";
  const pending: Uint8Array<ArrayBuffer>[] = [];
  let output: ((bytes: Uint8Array) => void) | undefined;
  let closed: ((reason: ShellCloseReason) => void) | undefined;
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
        const frame = shellClosedReason(event.data);
        if (frame !== undefined) {
          reason = frame;
          finish(frame);
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
    close: () => {
      ended = true;
      pending.length = 0;
      socket.close();
    },
  };
};
