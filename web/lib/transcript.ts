// Pure helpers for rendering a transcript, kept out of the components so they can be unit-tested.
import type { Message } from "effect-pi/api";

import type { AttachmentRef } from "./attachments";
import { splitAttachments } from "./attachments";
import type { SkillMessage } from "./skill-message";
import { parseSkillMessage, splitSkillHints } from "./skill-message";

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

export interface DisplayedMessage {
  /** The text as the person typed it: attachment, hint and skill markup stripped. */
  readonly shown: string;
  /** A forced skill's chip data; absent for ordinary text. */
  readonly skill: SkillMessage | undefined;
  /** The `/skill:` names hinted in the text, which render as chips inside `shown`. */
  readonly hinted: readonly string[];
  /** The files the message carried, as chips. */
  readonly attachments: readonly AttachmentRef[];
}

/** What a person's message text resolves to for display: skill chip, text as typed, file chips. */
export const displayParts = (text: string): DisplayedMessage => {
  // Attachment blocks come last, after any skill hints.
  const files = splitAttachments(text);
  const { text: body, hinted } = splitSkillHints(files.text);
  const skill = parseSkillMessage(body);
  return {
    shown: skill === undefined ? body : skill.request,
    skill,
    hinted,
    attachments: files.attachments,
  };
};
