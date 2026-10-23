// Accounts and their sessions: two tables of their own in the EFFECT_PI_DB file, like `artifacts`. A session row
// keeps only the SHA-256 of its token, so the file alone cannot sign anyone in.
import { DatabaseSync } from "node:sqlite";

import type { User, UserId } from "./user.ts";

interface UserRow {
  id: string;
  name: string;
  password_hash: string;
  created_at: number;
}

/** An account as stored: its User and its password hash. */
export interface Account {
  readonly user: User;
  readonly passwordHash: string;
  readonly createdAt: number;
}

const toAccount = (row: UserRow): Account => ({
  user: { id: row.id as UserId, name: row.name },
  passwordHash: row.password_hash,
  createdAt: row.created_at,
});

/** The tables: every method is one statement or one transaction. */
export interface AuthRecords {
  /**
   * Add an account; `false` when its name is taken or, with `onlyFirst`, when any account exists already —
   * checked in the same transaction, so two first-run setups cannot both succeed.
   */
  insertUser(
    account: Account,
    options?: { readonly onlyFirst?: boolean }
  ): boolean;
  byName(name: string): Account | undefined;
  /** Every account, oldest first; the oldest is the one that adopts what predates accounts. */
  users(): readonly Account[];
  /** Replace an account's password hash and end its sessions; `false` for an unknown name. */
  setPassword(name: string, passwordHash: string): boolean;
  insertSession(session: {
    readonly tokenHash: string;
    readonly userId: UserId;
    readonly createdAt: number;
    readonly expiresAt: number;
  }): void;
  /** The User of an unexpired session. */
  session(tokenHash: string, now: number): User | undefined;
  deleteSession(tokenHash: string): void;
  /** Drop expired sessions. */
  prune(now: number): void;
}

/** The tables in a SQLite file (`:memory:` for tests), created if missing. */
export const sqliteRecords = (
  file: string
): AuthRecords & { close(): void } => {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id);
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
  const byName = db.prepare("SELECT * FROM users WHERE name = ?");
  return {
    insertUser: (account, options) =>
      transaction(() => {
        if (
          options?.onlyFirst === true &&
          db.prepare("SELECT 1 FROM users LIMIT 1").get() !== undefined
        ) {
          return false;
        }
        if (byName.get(account.user.name) !== undefined) {
          return false;
        }
        db.prepare(
          "INSERT INTO users (id, name, password_hash, created_at) VALUES (?, ?, ?, ?)"
        ).run(
          account.user.id,
          account.user.name,
          account.passwordHash,
          account.createdAt
        );
        return true;
      }),
    byName: (name) => {
      const row = byName.get(name) as UserRow | undefined;
      return row === undefined ? undefined : toAccount(row);
    },
    users: () =>
      (
        db
          .prepare("SELECT * FROM users ORDER BY created_at, rowid")
          .all() as unknown as UserRow[]
      ).map(toAccount),
    setPassword: (name, passwordHash) =>
      transaction(() => {
        const row = byName.get(name) as UserRow | undefined;
        if (row === undefined) {
          return false;
        }
        db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(
          passwordHash,
          row.id
        );
        db.prepare("DELETE FROM sessions WHERE user_id = ?").run(row.id);
        return true;
      }),
    insertSession: (session) => {
      db.prepare(
        "INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)"
      ).run(
        session.tokenHash,
        session.userId,
        session.createdAt,
        session.expiresAt
      );
    },
    session: (tokenHash, now) => {
      const row = db
        .prepare(
          `SELECT u.id, u.name FROM sessions s JOIN users u ON u.id = s.user_id
           WHERE s.token_hash = ? AND s.expires_at > ?`
        )
        .get(tokenHash, now) as { id: string; name: string } | undefined;
      return row === undefined
        ? undefined
        : { id: row.id as UserId, name: row.name };
    },
    deleteSession: (tokenHash) => {
      db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash);
    },
    prune: (now) => {
      db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now);
    },
    close: () => db.close(),
  };
};
