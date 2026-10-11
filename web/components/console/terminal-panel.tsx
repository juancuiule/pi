"use client";

import { Terminal } from "@xterm/xterm";

import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef } from "react";

import type { ConversationState } from "@/lib/conversation-state";
import { terminalText } from "@/lib/terminal";

export const TerminalPanel = ({ state }: { state: ConversationState }) => {
  const container = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const written = useRef("");
  const text = terminalText(state);

  useEffect(() => {
    const terminal = new Terminal({
      convertEol: false,
      disableStdin: true,
      fontSize: 12,
      theme: { background: "transparent" },
    });
    if (container.current !== null) {
      terminal.open(container.current);
    }
    term.current = terminal;
    written.current = "";
    return () => {
      terminal.dispose();
      term.current = null;
    };
  }, []);

  useEffect(() => {
    const terminal = term.current;
    if (terminal === null) {
      return;
    }
    if (text.startsWith(written.current)) {
      terminal.write(text.slice(written.current.length));
    } else {
      // A snapshot after reconnect replaced what was shown.
      terminal.reset();
      terminal.write(text);
    }
    written.current = text;
  }, [text]);

  return <div ref={container} className="h-full w-full overflow-hidden p-2" />;
};
