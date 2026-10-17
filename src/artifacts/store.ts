// Where artifacts are kept: two tables of their own in a SQLite file (the server's EFFECT_PI_DB), like the
// `attachments` table. `artifacts` is one row per page, `artifact_versions` one per version: the HTML lives in a
// TEXT column, and `call_id` lets a replayed tool call find the version it already wrote.
import { DatabaseSync } from "node:sqlite";

/** One artifact's stored metadata. */
export interface ArtifactRecord {
  readonly id: string;
  readonly conversationId: number;
  readonly title: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** One stored version: a page as written by one tool call. */
export interface ArtifactVersionRecord {
  readonly artifactId: string;
  readonly version: number;
  readonly title: string;
  readonly html: string;
  /** The tool call that wrote it; unique, so a replay finds its version instead of adding one. */
  readonly callId: string;
  readonly createdAt: number;
}

/** A version as the console lists it, without the page. */
export interface ArtifactVersionInfo {
  readonly version: number;
  readonly title: string;
  readonly createdAt: number;
}

interface ArtifactRow {
  id: string;
  conversation_id: number;
  title: string;
  created_at: number;
  updated_at: number;
}

interface VersionRow {
  artifact_id: string;
  version: number;
  title: string;
  html: string;
  call_id: string;
  created_at: number;
}

const toRecord = (row: ArtifactRow): ArtifactRecord => ({
  id: row.id,
  conversationId: row.conversation_id,
  title: row.title,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const toVersion = (row: VersionRow): ArtifactVersionRecord => ({
  artifactId: row.artifact_id,
  version: row.version,
  title: row.title,
  html: row.html,
  callId: row.call_id,
  createdAt: row.created_at,
});

/** The metadata tables: every method is one statement or one transaction. */
export interface ArtifactRecords {
  /** Run `run` inside one transaction; a throw rolls back. */
  transaction<A>(run: () => A): A;
  /** The artifact in `conversationId`'s scope; `undefined` outside it or absent. */
  get(id: string, conversationId: number): ArtifactRecord | undefined;
  /** The version a tool call wrote, scoped to its conversation (a replayed call finds it here). */
  versionByCallId(
    callId: string,
    conversationId: number
  ): ArtifactVersionRecord | undefined;
  /** An artifact's latest version. */
  latest(artifactId: string): ArtifactVersionRecord | undefined;
  /** One version of an artifact. */
  version(
    artifactId: string,
    version: number
  ): ArtifactVersionRecord | undefined;
  /** An artifact's versions, oldest first, without the pages. */
  versions(artifactId: string): readonly ArtifactVersionInfo[];
  /** A conversation's artifacts, oldest first. */
  list(conversationId: number): readonly ArtifactRecord[];
  /** Every artifact across conversations, most recently updated first. */
  listAll(): readonly ArtifactRecord[];
  /** Insert an artifact and its first version. */
  insert(artifact: ArtifactRecord, version: ArtifactVersionRecord): void;
  /** Insert a new version and touch the artifact's title and updated_at. */
  addVersion(
    artifactId: string,
    title: string,
    updatedAt: number,
    version: ArtifactVersionRecord
  ): void;
  /** Delete an artifact of the conversation and all its versions; false when it is not there. */
  remove(id: string, conversationId: number): boolean;
  close(): void;
}

/** The tables in a SQLite file (`:memory:` for tests), created if missing. */
export const sqliteRecords = (
  file: string
): ArtifactRecords & { close(): void } => {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS artifacts (
      id TEXT PRIMARY KEY,
      conversation_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS artifact_versions (
      artifact_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      title TEXT NOT NULL,
      html TEXT NOT NULL,
      call_id TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      UNIQUE (artifact_id, version)
    );
    CREATE INDEX IF NOT EXISTS artifacts_conversation ON artifacts (conversation_id);
    CREATE INDEX IF NOT EXISTS artifact_versions_artifact ON artifact_versions (artifact_id);
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
  const insertVersion = db.prepare(
    `INSERT INTO artifact_versions (artifact_id, version, title, html, call_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  return {
    transaction,
    get: (id, conversationId) => {
      const row = db
        .prepare("SELECT * FROM artifacts WHERE id = ? AND conversation_id = ?")
        .get(id, conversationId) as ArtifactRow | undefined;
      return row === undefined ? undefined : toRecord(row);
    },
    versionByCallId: (callId, conversationId) => {
      const row = db
        .prepare(
          `SELECT v.* FROM artifact_versions v
           JOIN artifacts a ON a.id = v.artifact_id
           WHERE v.call_id = ? AND a.conversation_id = ?`
        )
        .get(callId, conversationId) as VersionRow | undefined;
      return row === undefined ? undefined : toVersion(row);
    },
    latest: (artifactId) => {
      const row = db
        .prepare(
          `SELECT * FROM artifact_versions WHERE artifact_id = ?
           ORDER BY version DESC LIMIT 1`
        )
        .get(artifactId) as VersionRow | undefined;
      return row === undefined ? undefined : toVersion(row);
    },
    version: (artifactId, version) => {
      const row = db
        .prepare(
          "SELECT * FROM artifact_versions WHERE artifact_id = ? AND version = ?"
        )
        .get(artifactId, version) as VersionRow | undefined;
      return row === undefined ? undefined : toVersion(row);
    },
    versions: (artifactId) =>
      (
        db
          .prepare(
            `SELECT version, title, created_at FROM artifact_versions
             WHERE artifact_id = ? ORDER BY version`
          )
          .all(artifactId) as unknown as {
          version: number;
          title: string;
          created_at: number;
        }[]
      ).map((row) => ({
        version: row.version,
        title: row.title,
        createdAt: row.created_at,
      })),
    list: (conversationId) =>
      (
        db
          .prepare(
            "SELECT * FROM artifacts WHERE conversation_id = ? ORDER BY created_at"
          )
          .all(conversationId) as unknown as ArtifactRow[]
      ).map(toRecord),
    listAll: () =>
      (
        db
          .prepare("SELECT * FROM artifacts ORDER BY updated_at DESC")
          .all() as unknown as ArtifactRow[]
      ).map(toRecord),
    insert: (artifact, version) =>
      transaction(() => {
        db.prepare(
          `INSERT INTO artifacts (id, conversation_id, title, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)`
        ).run(
          artifact.id,
          artifact.conversationId,
          artifact.title,
          artifact.createdAt,
          artifact.updatedAt
        );
        insertVersion.run(
          version.artifactId,
          version.version,
          version.title,
          version.html,
          version.callId,
          version.createdAt
        );
      }),
    addVersion: (artifactId, title, updatedAt, version) =>
      transaction(() => {
        insertVersion.run(
          version.artifactId,
          version.version,
          version.title,
          version.html,
          version.callId,
          version.createdAt
        );
        db.prepare(
          "UPDATE artifacts SET title = ?, updated_at = ? WHERE id = ?"
        ).run(title, updatedAt, artifactId);
      }),
    remove: (id, conversationId) =>
      transaction(() => {
        const gone =
          db
            .prepare(
              "DELETE FROM artifacts WHERE id = ? AND conversation_id = ?"
            )
            .run(id, conversationId).changes > 0;
        if (gone) {
          db.prepare("DELETE FROM artifact_versions WHERE artifact_id = ?").run(
            id
          );
        }
        return gone;
      }),
    close: () => db.close(),
  };
};
