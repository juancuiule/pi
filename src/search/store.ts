// The search index itself: one SQLite file of its own (SEARCH_DB), a resumable projection of the
// transcript log. `search_fts` holds one FTS5 row per indexable entry (rowid = the entry id, which
// is unique across conversations since entry ids come from one global sequence) plus one title row
// per conversation (rowid = -conversation_id); `search_cursors` is how far each conversation has
// been scanned. `putPage` writes a page's rows and advances the cursor in one transaction, so
// re-runs are idempotent and a crash resumes where the index left off.
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { IndexedText } from "./format.ts";

// The markers snippet() wraps matches in; control characters — indexedText strips them from
// stored text so a pasted \x02 cannot spoof a highlight.
const MATCH_OPEN = "\u0002";
const MATCH_CLOSE = "\u0003";

interface FtsRow {
  conversation_id: number;
  entry_id: number | null;
  role: string;
  snippet: string;
  created_at: number;
  rank: number;
}

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
   * One scanned page: `rows` are its indexable entries (each carrying the id of the conversation
   * that actually owns it — fork ancestors keep the parent's id) and `upTo` its last scanned
   * entry id — skipped entries advance the cursor too. Rows and cursor land in one transaction,
   * so a crash resumes without losing progress and a re-run replaces rows rather than duplicating.
   */
  putPage(
    conversationId: number,
    upTo: number,
    rows: readonly (IndexedText & {
      readonly entryId: number;
      readonly conversationId: number;
    })[]
  ): void;
  /** The best `limit` rows matching a sanitized FTS5 expression, best rank first. */
  /** The best `limit` rows matching `match` among `conversations`' rows only. */
  query(
    match: string,
    limit: number,
    conversations: readonly number[]
  ): QueryRow[];
  close(): void;
}

/** The index in a SQLite file (`:memory:` for tests), tables created if missing. */
export const sqliteIndex = (file: string): SearchIndex => {
  if (file !== ":memory:") {
    mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  }
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA busy_timeout = 5000;
    CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(
      text,
      conversation_id UNINDEXED,
      entry_id UNINDEXED,
      role UNINDEXED,
      created_at UNINDEXED
    );
    CREATE TABLE IF NOT EXISTS search_cursors(
      conversation_id INTEGER PRIMARY KEY,
      indexed_up_to INTEGER NOT NULL
    );
  `);
  const transaction = <A>(run: () => A): A => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = run();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };
  const insert = db.prepare(
    `INSERT OR REPLACE INTO search_fts(rowid, text, conversation_id, entry_id, role, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  const advance = db.prepare(
    `INSERT INTO search_cursors(conversation_id, indexed_up_to) VALUES (?, ?)
     ON CONFLICT(conversation_id)
     DO UPDATE SET indexed_up_to = MAX(indexed_up_to, excluded.indexed_up_to)`
  );
  const cursorGet = db.prepare(
    "SELECT indexed_up_to FROM search_cursors WHERE conversation_id = ?"
  );
  const search = db.prepare(
    `SELECT conversation_id, entry_id, role, created_at,
            snippet(search_fts, 0, ?, ?, '…', 32) AS snippet,
            bm25(search_fts) AS rank
     FROM search_fts
     WHERE search_fts MATCH ?
       AND conversation_id IN (SELECT value FROM json_each(?))
     ORDER BY rank
     LIMIT ?`
  );
  return {
    cursorOf: (conversationId) =>
      (cursorGet.get(conversationId) as { indexed_up_to: number } | undefined)
        ?.indexed_up_to ?? 0,
    putTitle: (conversationId, title, createdAt) => {
      insert.run(
        -conversationId,
        title,
        conversationId,
        null,
        "title",
        createdAt
      );
    },
    putPage: (conversationId, upTo, rows) =>
      transaction(() => {
        for (const row of rows) {
          insert.run(
            row.entryId,
            row.text,
            row.conversationId,
            row.entryId,
            row.role,
            row.createdAt
          );
        }
        advance.run(conversationId, upTo);
      }),
    query: (match, limit, conversations) =>
      (
        search.all(
          MATCH_OPEN,
          MATCH_CLOSE,
          match,
          JSON.stringify(conversations),
          limit
        ) as unknown as FtsRow[]
      ).map((row) => ({
        conversationId: row.conversation_id,
        entryId: row.entry_id ?? undefined,
        role: row.role as QueryRow["role"],
        snippet: row.snippet,
        createdAt: row.created_at,
        rank: row.rank,
      })),
    close: () => db.close(),
  };
};
