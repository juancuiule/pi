// Conversation titles from the model: a one-shot completion over the first (and latest) exchange, its
// answer cleaned and capped into `ConversationMeta.title`.
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";

/** The most a title may say, the same cap `titleOf` applies to prompt-derived titles. */
export const TITLE_CAP = 60;

/** The most of each exchange part a title request carries. */
export const SOURCE_CAP = 4000;

// One run of quote marks a model may wrap its answer in, at either end.
const QUOTES = /^["'“”‘’«»]+|["'“”‘’«»]+$/gu;

/** A usable title in a model's raw answer; `undefined` when nothing is left. */
export const cleanTitle = (raw: string): string | undefined => {
  const line = raw.split("\n", 1)[0] ?? "";
  const title = line.replace(QUOTES, "").replaceAll(/\s+/gu, " ").trim();
  return title === "" ? undefined : title;
};

/** `text` cut at `cap` characters, never inside a code point. */
export const capText = (text: string, cap: number): string =>
  [...text].slice(0, cap).join("");

/** Past the cap, the last character is an ellipsis — `titleOf`'s rule. */
export const capTitle = (text: string): string => {
  const chars = [...text];
  return chars.length <= TITLE_CAP
    ? text
    : `${chars.slice(0, TITLE_CAP - 1).join("")}…`;
};

/** The title in an assistant answer: its text blocks joined, cleaned and capped. */
export const titleText = (message: AssistantMessage): string | undefined => {
  const raw = message.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("");
  const title = cleanTitle(raw);
  return title === undefined ? undefined : capTitle(title);
};

/**
 * The request that asks the model to name a conversation: the first exchange, and the latest when it is
 * another one, each part capped at SOURCE_CAP.
 */
export const titleMessages = (input: {
  readonly firstUser?: string | undefined;
  readonly firstAnswer?: string | undefined;
  readonly latestUser?: string | undefined;
  readonly latestAnswer?: string | undefined;
}): Message[] => {
  const timestamp = Date.now();
  const listing = (
    [
      ["First message", input.firstUser],
      ["First answer", input.firstAnswer],
      ["Latest message", input.latestUser],
      ["Latest answer", input.latestAnswer],
    ] as const
  )
    .flatMap(([label, text]) =>
      text === undefined ? [] : [`${label}:\n${capText(text, SOURCE_CAP)}`]
    )
    .join("\n\n");
  return [
    {
      role: "system",
      content:
        "You name conversations. Answer with a short title for the conversation below: at most 60 characters, a single line, no surrounding quotes, in the language the person writes in. An emoji is allowed. Answer with the title only.",
      timestamp,
    },
    { role: "user", content: listing, timestamp },
  ];
};
