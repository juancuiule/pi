// Pure helpers for rendering a transcript, kept out of the components so they can be unit-tested.
import type { Message } from "effect-pi/api";

export const SCROLL_THRESHOLD_PX = 80;

/** Whether a scroll container is close enough to its bottom that new content should keep it pinned there. */
export const isNearBottom = (
  metrics: { scrollHeight: number; scrollTop: number; clientHeight: number },
  threshold = SCROLL_THRESHOLD_PX
): boolean =>
  metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= threshold;

/** Enter submits; Shift+Enter (a newline) and IME composition do not. */
export const shouldSubmit = (event: {
  key: string;
  shiftKey: boolean;
  isComposing: boolean;
}): boolean => event.key === "Enter" && !event.shiftKey && !event.isComposing;

type UserMessage = Extract<Message, { role: "user" }>;

export interface UserParts {
  readonly text: string;
  readonly images: readonly { readonly src: string }[];
}

/** An image block's inline `data:` URL. */
export const imageSrc = (block: {
  readonly mimeType: string;
  readonly data: string;
}): string => `data:${block.mimeType};base64,${block.data}`;

/** The text of a user message (text blocks joined) and its images as data URLs. */
export const userParts = (message: UserMessage): UserParts => {
  if (typeof message.content === "string") {
    return { text: message.content, images: [] };
  }
  const texts: string[] = [];
  const images: { src: string }[] = [];
  for (const block of message.content) {
    if (block.type === "text") {
      texts.push(block.text);
    } else {
      images.push({ src: imageSrc(block) });
    }
  }
  return { text: texts.join("\n"), images };
};
