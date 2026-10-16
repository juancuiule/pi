"use client";

import { Terminal } from "@wterm/react";
import type { TerminalHandle, WTerm } from "@wterm/react";
import "@wterm/react/css";
import { LoaderCircle, SquareTerminal } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useInfo } from "@/lib/queries";
import type { Shell } from "@/lib/shell";
import { connectShell } from "@/lib/shell";

const encoder = new TextEncoder();

/** Extra attempts after a `sandbox` or `disconnected` close; a live shell (any output) resets the count. */
const MAX_RECONNECTS = 2;

const placeholderText = (resuming: boolean): string =>
  resuming
    ? "Resuming — the sandbox is starting."
    : "The conversation has no live seat. The shell comes back when it resumes.";

/**
 * A live PTY in the conversation's Sandbox, over `connectShell`'s socket. Unlike the agent view this is a raw
 * stream: output appends as it arrives and there is nothing to repaint on resize.
 */
export const ShellTerminal = ({
  id,
  live,
  resuming = false,
}: {
  id: number;
  /** The conversation has a Seat, so a Sandbox to run the shell in. */
  live: boolean;
  /** A resume is in flight: the seat's sandbox is still starting. */
  resuming?: boolean;
}) => {
  const term = useRef<TerminalHandle | null>(null);
  const shell = useRef<Shell | null>(null);
  const size = useRef({ columns: 80, rows: 24 });
  const reconnects = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [wt, setWt] = useState<WTerm | null>(null);
  const { data: info } = useInfo();
  const apiUrl = info?.apiUrl;

  useEffect(() => {
    if (wt === null || apiUrl === undefined || !live) {
      return;
    }
    let disposed = false;
    const connect = () => {
      const client = connectShell({
        apiUrl,
        conversation: id,
        columns: size.current.columns,
        rows: size.current.rows,
      });
      shell.current = client;
      client.onOutput((bytes) => {
        // A shell that produces output works: later `sandbox` closes may reconnect again.
        reconnects.current = 0;
        term.current?.write(bytes);
      });
      client.onClosed((reason) => {
        shell.current = null;
        if (disposed) {
          return;
        }
        // `sandbox`: Upgrade swapped the Sandbox out from under the shell; the new socket lands in the new
        // container, which needs a moment to be recorded. `disconnected`: the socket dropped but the PTY is
        // a seat-scoped session now — a reconnect lands back in it with scrollback replayed.
        if (
          (reason === "sandbox" || reason === "disconnected") &&
          reconnects.current < MAX_RECONNECTS
        ) {
          reconnects.current += 1;
          term.current?.write(
            reason === "sandbox"
              ? "\r\n[sandbox changed — reconnecting]\r\n"
              : "\r\n[connection lost — reconnecting]\r\n"
          );
          timer.current = setTimeout(connect, 500);
          return;
        }
        term.current?.write(`\r\n[shell closed: ${reason}]\r\n`);
      });
    };
    connect();
    return () => {
      disposed = true;
      if (timer.current !== null) {
        clearTimeout(timer.current);
      }
      shell.current?.close();
      shell.current = null;
    };
  }, [wt, apiUrl, live, id]);

  if (!live) {
    return (
      <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-2 p-4">
        {resuming ? (
          <LoaderCircle
            aria-hidden
            className="size-5 motion-safe:animate-spin"
          />
        ) : (
          <SquareTerminal className="size-5" />
        )}
        <p className="text-sm">{placeholderText(resuming)}</p>
      </div>
    );
  }

  return (
    <div className="relative h-full min-h-0">
      <Terminal
        ref={term}
        autoResize
        onData={(data) => shell.current?.send(encoder.encode(data))}
        onBinary={(data) => shell.current?.send(data)}
        onResize={(cols, rows) => {
          size.current = { columns: cols, rows };
          shell.current?.resize(cols, rows);
        }}
        onReady={(w) => {
          size.current = { columns: w.cols, rows: w.rows };
          setWt(w);
        }}
        aria-label="Sandbox shell"
        className="console-terminal h-full w-full p-2"
      />
      {wt === null || apiUrl === undefined ? (
        <p className="text-muted-foreground pointer-events-none absolute inset-0 flex items-center justify-center p-4 text-center text-sm">
          Connecting to the shell…
        </p>
      ) : null}
    </div>
  );
};
