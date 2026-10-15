// Where attachments are kept: bytes in a `BlobStore` (a local directory; remote storage would be another one), and
// metadata in an `attachments` table of its own in a SQLite file (the server's EFFECT_PI_DB). Records are written
// once and only ever move from staged (no conversation) to a conversation, then to sent.
import { mkdir, readFile, rm, writeFile, copyFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  AttachmentInfo,
  AttachmentKind,
  AttachmentStatus,
} from "./format.ts";
import { ATTACHMENT_ID } from "./format.ts";

/** Bytes by key, under one folder per attachment (`<id>/<file>`). */
export interface BlobStore {
  /** Store a local file's bytes, or bytes in memory, under `key`. */
  put(key: string, from: { readonly path: string } | Uint8Array): Promise<void>;
  /** The bytes under `key`; `undefined` when there are none. */
  get(key: string): Promise<Uint8Array | undefined>;
  /** Everything under one attachment's folder. */
  removeAll(id: string): Promise<void>;
}

/** Each key's segments must be plain names: no traversal out of the root. */
const resolveKey = (root: string, key: string) => {
  const segments = key.split("/");
  if (
    segments.some(
      (segment) =>
        segment === "" ||
        segment === "." ||
        segment === ".." ||
        segment.includes("\\")
    )
  ) {
    throw new Error(`Invalid blob key: ${key}`);
  }
  return path.join(root, ...segments);
};

/** A BlobStore in a local directory, created on first write. */
export const directoryBlobs = (root: string): BlobStore => ({
  put: async (key, from) => {
    const target = resolveKey(root, key);
    await mkdir(path.dirname(target), { recursive: true });
    await (from instanceof Uint8Array
      ? writeFile(target, from)
      : copyFile(from.path, target));
  },
  get: async (key) => {
    try {
      return new Uint8Array(await readFile(resolveKey(root, key)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw error;
    }
  },
  removeAll: async (id) => {
    if (!ATTACHMENT_ID.test(id)) {
      throw new Error(`Invalid attachment id: ${id}`);
    }
    await rm(path.join(root, id), { recursive: true, force: true });
  },
});

/** One attachment's stored metadata. */
export interface AttachmentRecord extends AttachmentInfo {
  readonly sha256: string;
  readonly extractor: string;
  /** Set once a conversation owns it: on upload to one, or when `create` claims a staged upload. */
  readonly conversationId: number | undefined;
  /** When a message took it; unsent ones expire. */
  readonly sentAt: number | undefined;
}

interface Row {
  id: string;
  conversation_id: number | null;
  claim: string | null;
  name: string;
  media_type: string;
  kind: string;
  size: number;
  sha256: string;
  status: string;
  details: string;
  created_at: number;
  sent_at: number | null;
}

type Details = Pick<
  AttachmentRecord,
  "pages" | "chars" | "ocrPages" | "warnings" | "width" | "height" | "extractor"
>;

const toRecord = (row: Row): AttachmentRecord => {
  const details = JSON.parse(row.details) as Details;
  return {
    ...details,
    id: row.id,
    name: row.name,
    mediaType: row.media_type,
    kind: row.kind as AttachmentKind,
    size: row.size,
    sha256: row.sha256,
    status: row.status as AttachmentStatus,
    createdAt: row.created_at,
    conversationId: row.conversation_id ?? undefined,
    sentAt: row.sent_at ?? undefined,
  };
};

/** The metadata table: every method is one statement or one transaction. */
export interface AttachmentRecords {
  insert(record: AttachmentRecord): void;
  get(id: string): AttachmentRecord | undefined;
  /** Delete an unsent record; false when there is none. */
  removeUnsent(id: string): boolean;
  /** The bytes of every unsent upload. */
  unsentBytes(): number;
  /**
   * Reserve staged uploads under `claim`, all or none: each must exist, belong to no conversation, be unsent and be
   * unreserved. Returns the ids that could not be reserved (empty when all were).
   */
  reserve(ids: readonly string[], claim: string): readonly string[];
  /** Give a reservation's uploads to a conversation. */
  assign(claim: string, conversationId: number): void;
  /** Free a reservation's uploads, staged again. */
  release(claim: string): void;
  /** The conversation's records among `ids`, in that order; unknown and others' ids are left out. */
  ofConversation(
    conversationId: number,
    ids: readonly string[]
  ): readonly AttachmentRecord[];
  /** Mark a conversation's uploads as sent; false (and nothing changed) unless every one was unsent. */
  markSent(conversationId: number, ids: readonly string[], at: number): boolean;
  /** Every sent attachment of a conversation, oldest first. */
  sent(conversationId: number): readonly AttachmentRecord[];
  /** Delete unsent records created before `before`, returning their ids. */
  expire(before: number): readonly string[];
}

/** The table in a SQLite file (`:memory:` for tests), created if missing. */
export const sqliteRecords = (
  file: string
): AttachmentRecords & { close(): void } => {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS attachments (
      id TEXT PRIMARY KEY,
      conversation_id INTEGER,
      claim TEXT,
      name TEXT NOT NULL,
      media_type TEXT NOT NULL,
      kind TEXT NOT NULL,
      size INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      status TEXT NOT NULL,
      details TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      sent_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS attachments_conversation ON attachments (conversation_id, sent_at);
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
  const getRow = db.prepare("SELECT * FROM attachments WHERE id = ?");
  const one = (id: string) => getRow.get(id) as Row | undefined;
  return {
    insert: (record) => {
      const details: Details = {
        ocrPages: record.ocrPages,
        warnings: record.warnings,
        extractor: record.extractor,
        ...(record.pages === undefined ? {} : { pages: record.pages }),
        ...(record.chars === undefined ? {} : { chars: record.chars }),
        ...(record.width === undefined ? {} : { width: record.width }),
        ...(record.height === undefined ? {} : { height: record.height }),
      };
      db.prepare(
        `INSERT INTO attachments (id, conversation_id, name, media_type, kind, size, sha256, status, details, created_at, sent_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        record.id,
        record.conversationId ?? null,
        record.name,
        record.mediaType,
        record.kind,
        record.size,
        record.sha256,
        record.status,
        JSON.stringify(details),
        record.createdAt,
        record.sentAt ?? null
      );
    },
    get: (id) => {
      const row = one(id);
      return row === undefined ? undefined : toRecord(row);
    },
    removeUnsent: (id) =>
      db
        .prepare("DELETE FROM attachments WHERE id = ? AND sent_at IS NULL")
        .run(id).changes > 0,
    unsentBytes: () =>
      Number(
        (
          db
            .prepare(
              "SELECT COALESCE(SUM(size), 0) AS total FROM attachments WHERE sent_at IS NULL"
            )
            .get() as {
            total: number;
          }
        ).total
      ),
    reserve: (ids, claim) =>
      transaction(() => {
        const refused = ids.filter((id) => {
          const row = one(id);
          return (
            row === undefined ||
            row.conversation_id !== null ||
            row.sent_at !== null ||
            row.claim !== null
          );
        });
        if (refused.length === 0) {
          const update = db.prepare(
            "UPDATE attachments SET claim = ? WHERE id = ?"
          );
          for (const id of ids) {
            update.run(claim, id);
          }
        }
        return refused;
      }),
    assign: (claim, conversationId) => {
      db.prepare(
        "UPDATE attachments SET conversation_id = ?, claim = NULL WHERE claim = ?"
      ).run(conversationId, claim);
    },
    release: (claim) => {
      db.prepare("UPDATE attachments SET claim = NULL WHERE claim = ?").run(
        claim
      );
    },
    ofConversation: (conversationId, ids) =>
      ids.flatMap((id) => {
        const row = one(id);
        return row?.conversation_id === conversationId ? [toRecord(row)] : [];
      }),
    markSent: (conversationId, ids, at) =>
      transaction(() => {
        const ready = ids.every((id) => {
          const row = one(id);
          return (
            row?.conversation_id === conversationId && row.sent_at === null
          );
        });
        if (ready) {
          const update = db.prepare(
            "UPDATE attachments SET sent_at = ? WHERE id = ?"
          );
          for (const id of ids) {
            update.run(at, id);
          }
        }
        return ready;
      }),
    sent: (conversationId) =>
      (
        db
          .prepare(
            "SELECT * FROM attachments WHERE conversation_id = ? AND sent_at IS NOT NULL ORDER BY sent_at, created_at"
          )
          .all(conversationId) as unknown as Row[]
      ).map(toRecord),
    expire: (before) =>
      transaction(() => {
        const rows = db
          .prepare(
            "SELECT id FROM attachments WHERE sent_at IS NULL AND created_at < ?"
          )
          .all(before) as unknown as { id: string }[];
        db.prepare(
          "DELETE FROM attachments WHERE sent_at IS NULL AND created_at < ?"
        ).run(before);
        return rows.map((row) => row.id);
      }),
    close: () => db.close(),
  };
};
