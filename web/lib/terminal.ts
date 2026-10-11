// The shell panel's text: the agent's bash commands and their output, in order, as xterm expects (CRLF newlines).
import { toolResultOf } from "./conversation-state";
import type { ConversationState } from "./conversation-state";

const crlf = (text: string) => text.replaceAll(/\r?\n/gu, "\r\n");

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
      const result = toolResultOf(state, call.id);
      const output =
        result?.role === "toolResult"
          ? result.content
              .flatMap((c) =>
                c.type === "text" ? [c.text.replace(/\r?\n$/u, "")] : []
              )
              .join("\n")
          : (state.tools[call.id]?.output ?? "");
      const shown = crlf(output);
      // Every command starts on its own line, even after output without a trailing newline.
      const ended =
        shown === "" || shown.endsWith("\r\n") ? shown : `${shown}\r\n`;
      return `$ ${command}\r\n${ended}`;
    })
    .join("")
    .replace(/\r\n$/u, "");
};
