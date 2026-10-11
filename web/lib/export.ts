// Export builders for a conversation: JSON Lines of the raw entry records, or a Markdown document
// a person can read. Pure, so both are unit-tested.
import type { ConversationSummary } from "effect-pi/api";

import type { ConversationState } from "./conversation-state";
import { toolResultOf } from "./conversation-state";
import { SANDBOX_LABEL } from "./sandbox-info";
import { toolSummary } from "./tool-summary";
import { userParts } from "./transcript";

/** `title-id` for download filenames: lowercase, dashes, no trailing dash. */
export const exportSlug = (title: string, id: number): string =>
  `${title
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/-+/gu, "-")
    .replaceAll(/^-|-$/gu, "")}-${id}`;

/** One committed entry record per line, in transcript order, with a trailing newline. */
export const toJsonl = (state: ConversationState): string =>
  `${state.entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;

/** A code fence one backtick longer than the longest run inside, so nested fences can't break it. */
const fence = (content: string): string => {
  let longest = 0;
  for (const match of content.matchAll(/`+/gu)) {
    longest = Math.max(longest, match[0].length);
  }
  return "`".repeat(Math.max(3, longest + 1));
};

const fenced = (content: string, language?: string): string => {
  const f = fence(content);
  return `${f}${language ?? ""}\n${content}\n${f}`;
};

/** The text of a tool result's content blocks; images become `[image]`. */
const resultText = (
  state: ConversationState,
  callId: string
): { output: string; failed: boolean } => {
  const result = toolResultOf(state, callId);
  if (result === undefined || result.role !== "toolResult") {
    return { output: "(no result)", failed: false };
  }
  const output = result.content
    .map((block) => (block.type === "text" ? block.text : "[image]"))
    .join("\n");
  return { output, failed: result.isError === true };
};

export const toMarkdown = (
  summary: ConversationSummary,
  state: ConversationState
): string => {
  const parts: string[] = [
    `# ${summary.title}`,
    "",
    `Sandbox: ${SANDBOX_LABEL[summary.sandbox]} · Started ${new Date(summary.createdAt).toISOString()}`,
    "",
  ];
  for (const entry of state.entries) {
    for (const message of entry.model ?? []) {
      if (message.role === "user") {
        const { text, images } = userParts(message);
        parts.push("## User", "");
        if (text !== "") {
          parts.push(text, "");
        }
        for (const _image of images) {
          parts.push("[image]", "");
        }
        continue;
      }
      if (message.role !== "assistant") {
        continue;
      }
      for (const block of message.content) {
        if (block.type === "text") {
          parts.push("## Assistant", "", block.text, "");
        } else if (block.type === "toolCall") {
          const { output, failed } = resultText(state, block.id);
          parts.push(
            `### Tool: ${block.name}${failed ? " (failed)" : ""}`,
            "",
            toolSummary(block.name, block.arguments),
            "",
            fenced(JSON.stringify(block.arguments ?? {}, null, 2), "json"),
            "",
            fenced(output),
            ""
          );
        }
        // Thinking blocks are omitted.
      }
    }
  }
  return parts.join("\n").replaceAll(/\n{3,}/gu, "\n\n");
};
