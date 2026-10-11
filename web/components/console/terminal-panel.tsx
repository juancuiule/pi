"use client";

import { Terminal } from "@wterm/react";
import type { TerminalHandle } from "@wterm/react";
import "@wterm/react/css";
import { SquareTerminal } from "lucide-react";
import { useEffect, useRef } from "react";

import type { ConversationState } from "@/lib/conversation-state";
import { TERMINAL_RESET, terminalText, terminalWrite } from "@/lib/terminal";

// The panel is output-only; typed input is dropped here instead of echoing into the terminal.
const ignoreInput = () => {
  // Intentionally empty.
};

export const TerminalPanel = ({ state }: { state: ConversationState }) => {
  const term = useRef<TerminalHandle | null>(null);
  // What the terminal shows; `null` until onReady (writes before init are dropped).
  const written = useRef<string | null>(null);
  const latest = useRef("");
  const text = terminalText(state);

  const repaint = (terminal: TerminalHandle) => {
    // wterm's core does not rewrap on resize — cells written at a wider column count would be
    // cropped. Since we hold the full text, replay it from scratch whenever the grid resizes.
    terminal.write(TERMINAL_RESET + latest.current);
    written.current = latest.current;
  };

  useEffect(() => {
    latest.current = text;
    const terminal = term.current;
    if (terminal === null || written.current === null) {
      return;
    }
    const next = terminalWrite(written.current, text);
    if (next !== "") {
      terminal.write(next);
    }
    written.current = text;
  }, [text]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b px-2">
        <SquareTerminal className="text-muted-foreground size-4" />
        <span className="text-ui font-medium">Terminal</span>
      </div>
      <div className="relative min-h-0 flex-1">
        <Terminal
          ref={term}
          autoResize
          cursorBlink={false}
          onData={ignoreInput}
          onResize={() => {
            const terminal = term.current;
            if (terminal !== null && written.current !== null) {
              repaint(terminal);
            }
          }}
          onReady={(wt) => {
            // Hide the cursor (this terminal has no input), then write what exists so far.
            const initial = latest.current;
            wt.write(`\u001B[?25l${initial}`);
            written.current = initial;
          }}
          tabIndex={-1}
          aria-label="Agent terminal output"
          className="console-terminal h-full w-full p-2"
        />
        {text === "" ? (
          <p className="text-muted-foreground pointer-events-none absolute inset-0 flex items-center justify-center p-4 text-center text-sm">
            Commands the agent runs appear here.
          </p>
        ) : null}
      </div>
    </div>
  );
};
