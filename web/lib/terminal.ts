// The shell panel's text: the agent's bash commands and their output, in order, as the terminal expects (CRLF newlines).
import { approvalOf } from "./approval";
import { toolResultOf } from "./conversation-state";
import type { ConversationState } from "./conversation-state";

const crlf = (text: string) => text.replaceAll(/\r?\n/gu, "\r\n");

// wterm has no reset(): RIS clears the screen, ED 3 clears scrollback, and DECTCEM hides the (always-on) cursor.
export const TERMINAL_RESET = "\u001Bc\u001B[3J\u001B[?25l";

/** What to write when the display text changes: the appended suffix, or a full reset + rewrite after a snapshot. */
export const terminalWrite = (previous: string, next: string): string =>
  next.startsWith(previous)
    ? next.slice(previous.length)
    : TERMINAL_RESET + next;

/** The raw ANSI stream the server keeps in `details.ansi`, when the bash wrapper provided one. */
export const ansiOf = (details: unknown): string | undefined =>
  typeof details === "object" &&
  details !== null &&
  typeof (details as { ansi?: unknown }).ansi === "string"
    ? (details as { ansi: string }).ansi
    : undefined;

/** The display output for one bash call; `undefined` while it awaits approval, or after a deny or a Stop before one. */
const callOutput = (
  state: ConversationState,
  callId: string
): string | undefined => {
  const result = toolResultOf(state, callId);
  const toolResult = result?.role === "toolResult" ? result : undefined;
  const approval =
    approvalOf(toolResult?.details) ?? approvalOf(state.tools[callId]?.details);
  if (
    approval?.state === "pending" ||
    approval?.state === "denied" ||
    approval?.state === "stopped"
  ) {
    return undefined;
  }
  return (
    ansiOf(toolResult?.details) ??
    ansiOf(state.tools[callId]?.details) ??
    (toolResult === undefined
      ? (state.tools[callId]?.output ?? "")
      : toolResult.content
          .flatMap((c) => (c.type === "text" ? [c.text] : []))
          .join("\n"))
  );
};

export const terminalText = (state: ConversationState): string => {
  const messages = [
    ...state.entries.flatMap((entry) => entry.model ?? []),
    ...(state.streaming === undefined ? [] : [state.streaming]),
  ];
  const calls = messages.flatMap((m) =>
    m.role === "assistant"
      ? m.content.filter((c) => c.type === "toolCall" && c.name === "bash")
      : []
  );
  return calls
    .map((call) => {
      if (call.type !== "toolCall") {
        return "";
      }
      const command = String(call.arguments?.command ?? "");
      const output = callOutput(state, call.id);
      // A call that never ran (still waiting for a decision, denied, or stopped first) shows nothing.
      if (output === undefined) {
        return "";
      }
      const trimmed = output.replace(/\r?\n$/u, "");
      const shown = crlf(trimmed);
      // Every command starts on its own line, even after output without a trailing newline.
      const ended =
        shown === "" || shown.endsWith("\r\n") ? shown : `${shown}\r\n`;
      return `$ ${command}\r\n${ended}`;
    })
    .join("")
    .replace(/\r\n$/u, "");
};
