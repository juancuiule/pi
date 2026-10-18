// What the search index takes from a transcript: the text of the person's and the assistant's
// messages, and nothing else — tool arguments and results, thinking blocks, system and boundary
// entries never reach the index (the kind allowlist is the whole policy). `matchQuery` is the
// only place user input meets FTS5 syntax: raw input throws inside MATCH, so it emits a
// sanitized expression.
import type { EntryRecord } from "@earendil-works/pi-durable";

/** The indexable text of one transcript entry, with its role and when it was written. */
export interface IndexedText {
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly createdAt: number;
}

/**
 * The text a transcript entry contributes to the index, or `undefined` for anything outside
 * `pi.user`/`pi.assistant` and for entries with no text.
 */
export const indexedText = (_entry: EntryRecord): IndexedText | undefined =>
  undefined;

/**
 * An FTS5 MATCH expression for raw input, or `undefined` when it holds no word characters.
 */
export const matchQuery = (_q: string): string | undefined => undefined;

/** One span of a search snippet; `match` flags the part that hit the query. */
export interface SnippetSegment {
  readonly text: string;
  readonly match: boolean;
}

/** The snippet the store returns, split into segments on its match markers. */
export const splitSnippet = (_raw: string): SnippetSegment[] => [];
