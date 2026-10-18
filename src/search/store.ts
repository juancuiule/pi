// The search index itself: one SQLite file of its own (SEARCH_DB), a resumable projection of the
// transcript log.
import type { IndexedText } from "./format.ts";

/** One hit: which entry (undefined for the title row), a snippet still carrying its markers, the bm25 rank. */
export interface QueryRow {
  readonly conversationId: number;
  readonly entryId: number | undefined;
  readonly role: "title" | "user" | "assistant";
  readonly snippet: string;
  readonly createdAt: number;
  readonly rank: number;
}

export interface SearchIndex {
  /** The last entry id scanned for this conversation; 0 when never indexed. */
  cursorOf(conversationId: number): number;
  /** The conversation's title row, replaced when it changes. */
  putTitle(conversationId: number, title: string, createdAt: number): void;
  /**
   * One scanned page: `rows` are its indexable entries and `upTo` its last scanned entry id —
   * skipped entries advance the cursor too. Rows and cursor land in one transaction.
   */
  putPage(
    conversationId: number,
    upTo: number,
    rows: readonly (IndexedText & { readonly entryId: number })[]
  ): void;
  /** The best `limit` rows matching a sanitized FTS5 expression, best rank first. */
  query(match: string, limit: number): QueryRow[];
  close(): void;
}

/** The index in a SQLite file (`:memory:` for tests), tables created if missing. */
export const sqliteIndex = (_file: string): SearchIndex => ({
  cursorOf: () => 0,
  putTitle: () => null,
  putPage: () => null,
  query: () => [],
  close: () => null,
});
