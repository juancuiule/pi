"use client";

import { FitAddon } from "@xterm/addon-fit";
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
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    const element = container.current;
    // Fitting resizes the grid and keeps the buffer, so it never clears what was written.
    const refit = () => {
      if (element !== null && element.clientWidth > 0) {
        fit.fit();
      }
    };
    const observer = new ResizeObserver(refit);
    if (element !== null) {
      terminal.open(element);
      refit();
      observer.observe(element);
    }
    term.current = terminal;
    written.current = "";
    return () => {
      observer.disconnect();
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
