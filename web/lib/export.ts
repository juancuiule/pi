// Export builders for a conversation: JSON Lines of the raw entry records, or a Markdown document
// a person can read. Pure, so both are unit-tested.
import type { ConversationSummary } from "effect-pi/api";

import type { ConversationState } from "./conversation-state";
import { toolResultOf } from "./conversation-state";
import { SANDBOX_LABEL } from "./sandbox-info";
import { toolSummary } from "./tool-summary";
import { imageSrc, userParts } from "./transcript";
import { unansweredNote } from "./unanswered-note";

/** `title-id` for download filenames: lowercase, dashes, no trailing dash. */
export const exportSlug = (title: string, id: number): string =>
  `${title
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/-+/gu, "-")
    .replaceAll(/^-|-$/gu, "")}-${id}`;

/**
 * One committed entry record per line, in transcript order, with a trailing newline. Records serialize whole, so
 * image blocks keep their base64 `data`. Only entries: why a message went unanswered is a submission's, not an
 * entry's, and shows in the Markdown export.
 */
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

/** The text of a tool result's content blocks, and its images as data URLs. */
const resultParts = (
  state: ConversationState,
  callId: string
): {
  output: string;
  failed: boolean;
  images: readonly { readonly src: string }[];
} => {
  const result = toolResultOf(state, callId);
  if (result === undefined || result.role !== "toolResult") {
    return { output: "(no result)", failed: false, images: [] };
  }
  const texts: string[] = [];
  const images: { src: string }[] = [];
  for (const block of result.content) {
    if (block.type === "text") {
      texts.push(block.text);
    } else {
      images.push({ src: imageSrc(block) });
    }
  }
  return { output: texts.join("\n"), failed: result.isError ?? false, images };
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
        for (const image of images) {
          parts.push(`![image](${image.src})`, "");
        }
        const unanswered = state.unanswered[entry.id];
        const note =
          unanswered === undefined ? undefined : unansweredNote(unanswered);
        if (note !== undefined) {
          parts.push(`> ${note}`, "");
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
          const { output, failed, images } = resultParts(state, block.id);
          parts.push(
            `### Tool: ${block.name}${failed ? " (failed)" : ""}`,
            "",
            toolSummary(block.name, block.arguments),
            "",
            fenced(JSON.stringify(block.arguments ?? {}, null, 2), "json"),
            ""
          );
          // An image-only result has no text to fence; the images render outside one anyway.
          if (output !== "" || images.length === 0) {
            parts.push(fenced(output), "");
          }
          for (const image of images) {
            parts.push(`![image](${image.src})`, "");
          }
        }
        // Thinking blocks are omitted.
      }
    }
  }
  return parts.join("\n").replaceAll(/\n{3,}/gu, "\n\n");
};
