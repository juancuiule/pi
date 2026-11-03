// Personal connectors' credentials: one row per User and connector in a `connector_credentials` table of the
// EFFECT_PI_DB file, beside `trusted_domains`. The secret (an app password, an API key, a refresh token) is sealed
// with AES-256-GCM under CONNECTOR_SECRET_KEY, its owner and connector bound in as associated data, so a copy of the
// database (a Litestream replica, a backup) does not carry usable credentials, and a row moved to another User or
// connector no longer opens. Only the account a secret signs in as stays readable, for the console's Settings.
// Nothing here logs: a secret leaves this module only to the connector that sends it to its service.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { UserId } from "../auth/user.ts";

/** Who a credential signs in as; shown to its User, never secret. */
// oxlint-disable-next-line typescript/consistent-type-definitions -- stored as JSON
export type ConnectorAccount = {
  /** The service's id for the account, where it differs from the login (Nextcloud's DAV paths use it). */
  readonly id: string;
  readonly login: string;
  readonly displayName: string;
};

/** A credential as a connector uses it. */
export interface ConnectorCredential {
  readonly account: ConnectorAccount;
  readonly secret: string;
}

/** A User's stored credential: readable, or sealed under another key (the key changed: reconnect). */
export type StoredCredential =
  | (ConnectorCredential & { readonly connectedAt: number })
  | {
      readonly account: ConnectorAccount;
      readonly connectedAt: number;
      readonly unreadable: true;
    };

const KEY_BYTES = 32;
const IV_BYTES = 12;
const VERSION = "v1";

/**
 * The key from CONNECTOR_SECRET_KEY: 32 bytes, base64 (`openssl rand -base64 32`). Throws on anything else, so a
 * mistyped key stops startup instead of sealing secrets under a weak one.
 */
export const parseSecretKey = (value: string): Buffer => {
  const key = Buffer.from(value.trim(), "base64");
  if (key.length !== KEY_BYTES || key.toString("base64") !== value.trim()) {
    throw new Error(
      "CONNECTOR_SECRET_KEY must be 32 bytes in base64 (generate one with `openssl rand -base64 32`)"
    );
  }
  return key;
};

/** A fresh key in CONNECTOR_SECRET_KEY's format. */
export const generateSecretKey = (): string =>
  randomBytes(KEY_BYTES).toString("base64");

const aad = (owner: UserId, connector: string) =>
  Buffer.from(`${owner}\u0000${connector}`, "utf-8");

/** `v1:<iv>:<tag>:<ciphertext>`, base64 parts. */
export const seal = (
  key: Buffer,
  owner: UserId,
  connector: string,
  secret: string
): string => {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad(owner, connector));
  const body = Buffer.concat([cipher.update(secret, "utf-8"), cipher.final()]);
  return [
    VERSION,
    iv.toString("base64"),
    cipher.getAuthTag().toString("base64"),
    body.toString("base64"),
  ].join(":");
};

/** The secret `seal` sealed, or `undefined` when it was sealed under another key, owner or connector. */
export const open = (
  key: Buffer,
  owner: UserId,
  connector: string,
  sealed: string
): string | undefined => {
  const [version, iv, tag, body] = sealed.split(":");
  if (
    version !== VERSION ||
    iv === undefined ||
    tag === undefined ||
    body === undefined
  ) {
    return undefined;
  }
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(iv, "base64")
    );
    decipher.setAAD(aad(owner, connector));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(body, "base64")),
      decipher.final(),
    ]).toString("utf-8");
  } catch {
    return undefined;
  }
};

interface Row {
  account: string;
  secret: string;
  connected_at: number;
}

/** The table: every method is one statement. */
export interface CredentialVault {
  get(owner: UserId, connector: string): StoredCredential | undefined;
  /** Every connector `owner` has a credential for, by connector id. */
  all(owner: UserId): ReadonlyMap<string, StoredCredential>;
  /** Store or replace `owner`'s credential for `connector`. */
  put(
    owner: UserId,
    connector: string,
    credential: ConnectorCredential,
    at: number
  ): void;
  /** Drop it; false when there was none. */
  remove(owner: UserId, connector: string): boolean;
  close(): void;
}

/** The `connector_credentials` table in a SQLite file (`:memory:` for tests), created if missing. */
export const sqliteVault = (file: string, key: Buffer): CredentialVault => {
  if (file !== ":memory:") {
    mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  }
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS connector_credentials (
      owner TEXT NOT NULL,
      connector TEXT NOT NULL,
      account TEXT NOT NULL,
      secret TEXT NOT NULL,
      connected_at INTEGER NOT NULL,
      PRIMARY KEY (owner, connector)
    );
  `);
  const toStored = (
    owner: UserId,
    connector: string,
    row: Row
  ): StoredCredential => {
    const account = JSON.parse(row.account) as ConnectorAccount;
    const secret = open(key, owner, connector, row.secret);
    return secret === undefined
      ? { account, connectedAt: row.connected_at, unreadable: true }
      : { account, secret, connectedAt: row.connected_at };
  };
  return {
    get: (owner, connector) => {
      const row = db
        .prepare(
          "SELECT account, secret, connected_at FROM connector_credentials WHERE owner = ? AND connector = ?"
        )
        .get(owner, connector) as Row | undefined;
      return row === undefined ? undefined : toStored(owner, connector, row);
    },
    all: (owner) =>
      new Map(
        (
          db
            .prepare(
              "SELECT connector, account, secret, connected_at FROM connector_credentials WHERE owner = ?"
            )
            .all(owner) as unknown as (Row & { connector: string })[]
        ).map((row) => [row.connector, toStored(owner, row.connector, row)])
      ),
    put: (owner, connector, credential, at) => {
      db.prepare(
        `INSERT INTO connector_credentials (owner, connector, account, secret, connected_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (owner, connector) DO UPDATE SET account = excluded.account, secret = excluded.secret,
             connected_at = excluded.connected_at`
      ).run(
        owner,
        connector,
        JSON.stringify(credential.account),
        seal(key, owner, connector, credential.secret),
        at
      );
    },
    remove: (owner, connector) =>
      db
        .prepare(
          "DELETE FROM connector_credentials WHERE owner = ? AND connector = ?"
        )
        .run(owner, connector).changes > 0,
    close: () => db.close(),
  };
};
