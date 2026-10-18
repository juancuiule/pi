// What the search index takes from a transcript: the text of the person's and the assistant's
// messages, and nothing else — tool arguments and results, thinking blocks, system and boundary
// entries never reach the index (the kind allowlist is the whole policy, the same rule the
// transcript applies). `matchQuery` is the only place user input meets FTS5 syntax: raw or
// malformed input throws inside MATCH, so it emits a sanitized expression.
import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";
import type { EntryRecord } from "@earendil-works/pi-durable";

/** The indexable text of one transcript entry, with its role and when it was written. */
export interface IndexedText {
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly createdAt: number;
}

const userText = (message: UserMessage) =>
  typeof message.content === "string"
    ? message.content
    : message.content
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("\n");

const assistantText = (message: AssistantMessage) =>
  message.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n");

/**
 * The text a transcript entry contributes to the index, or `undefined` for anything outside
 * `pi.user`/`pi.assistant` — `pi.reset`/`pi.compaction` carry user-role models but are context
 * boundaries — and for entries with no text. `pi.user`: the text parts of its UserMessage (string
 * content is itself; image parts are skipped, attachment text is already inlined in the text).
 * `pi.assistant`: its TextContent parts only.
 */
export const indexedText = (entry: EntryRecord): IndexedText | undefined => {
  const message = entry.model?.[0];
  if (entry.kind === "pi.user" && message?.role === "user") {
    const text = userText(message);
    return text.trim() === ""
      ? undefined
      : { role: "user", text, createdAt: message.timestamp };
  }
  if (entry.kind === "pi.assistant" && message?.role === "assistant") {
    const text = assistantText(message);
    return text.trim() === ""
      ? undefined
      : { role: "assistant", text, createdAt: message.timestamp };
  }
  return undefined;
};

const MAX_TERMS = 10;
const TERM_CHARS = 40;

/**
 * An FTS5 MATCH expression for raw input, or `undefined` when it holds no word characters: each
 * [\p{L}\p{N}_]+ run becomes a quoted prefix term (at most MAX_TERMS, each cut at TERM_CHARS),
 * AND-ed — `"t1"* AND "t2"* AND …`. Quoting, explicit AND and per-term prefix are what makes user
 * input safe for MATCH.
 */
export const matchQuery = (q: string): string | undefined => {
  const terms = (q.match(/[\p{L}\p{N}_]+/gu) ?? [])
    .map((term) => term.slice(0, TERM_CHARS))
    .slice(0, MAX_TERMS);
  return terms.length === 0
    ? undefined
    : terms.map((term) => `"${term}"*`).join(" AND ");
};

/** One span of a search snippet; `match` flags the part that hit the query. */
export interface SnippetSegment {
  readonly text: string;
  readonly match: boolean;
}

/**
 * The snippet the store returns, split into segments on the \x02/\x03 markers it passes to
 * snippet(): text before \x02 is a non-match, between \x02 and \x03 a match, alternating from
 * there; empty parts are dropped.
 */
export const splitSnippet = (raw: string): SnippetSegment[] => {
  const segments: SnippetSegment[] = [];
  let match = false;
  // oxlint-disable-next-line no-control-regex -- markers are control characters by design
  for (const part of raw.split(/[\u0002\u0003]/u)) {
    if (part !== "") {
      segments.push({ text: part, match });
    }
    match = !match;
  }
  return segments;
};
