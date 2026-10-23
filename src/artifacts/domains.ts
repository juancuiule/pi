// The hosts an artifact page may load images from, one list per User, managed under Settings → Trusted domains and
// kept in a `trusted_domains` table of the EFFECT_PI_DB file like `artifacts`. The render endpoint puts them in the page's
// img-src CSP; artifact_create/artifact_update refuse a page whose images come from anywhere else (refs.ts).
import { DatabaseSync } from "node:sqlite";

import { Clock, Context, Effect, Layer } from "effect";

import type { UserId } from "../auth/user.ts";
import { InvalidDomain } from "../errors.ts";

const HOST =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/u;

const PORT = /^\d{1,5}$/u;

/**
 * What an entry stores — `host`, `*.host`, each optionally with a `:port` — or `undefined` when `input` is not one.
 * A pasted URL reduces to its host and port (http/https only); paths cannot be trusted, only hosts.
 */
export const normalizeDomain = (input: string): string | undefined => {
  let value = input.trim().toLowerCase();
  if (value === "") {
    return undefined;
  }
  // A pasted URL reduces to its host and port; a bare `host/path` is that URL minus its scheme.
  if (!value.includes("://") && /[/?#]/u.test(value)) {
    value = `https://${value}`;
  }
  if (value.includes("://")) {
    try {
      const url = new URL(value);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        return undefined;
      }
      // The host itself may carry a `*.` (a pasted https://*.example.com/ URL).
      value = url.host;
    } catch {
      return undefined;
    }
  }
  let wildcard = "";
  if (value.startsWith("*.")) {
    wildcard = "*.";
    value = value.slice(2);
  }
  const parts = value.split(":");
  if (parts.length > 2) {
    return undefined;
  }
  const [host, port] = parts;
  if (
    host === undefined ||
    !HOST.test(host) ||
    // `*.com` would trust most of the web; a wildcard's host needs a dot of its own.
    (wildcard !== "" && !host.includes("."))
  ) {
    return undefined;
  }
  if (
    port !== undefined &&
    (!PORT.test(port) || Number(port) === 0 || Number(port) > 65_535)
  ) {
    return undefined;
  }
  return `${wildcard}${host}${port === undefined ? "" : `:${port}`}`;
};

/**
 * Whether `host` (a URL's `host`, so `host` or `host:port`) is trusted: exactly an entry, or under a `*.` entry —
 * `*.example.com` trusts any subdomain, but not `example.com` itself, like a CSP host-source.
 */
export const isTrusted = (host: string, domains: readonly string[]): boolean =>
  domains.some(
    (domain) =>
      domain === host ||
      (domain.startsWith("*.") &&
        host.endsWith(domain.slice(1)) &&
        host !== domain.slice(2))
  );

/** The stored form of each User's trusted list. */
interface DomainRecords {
  /** Every entry of `owner`'s list, in the order added. */
  all(owner: UserId): readonly string[];
  /** Record an entry; an existing one is a no-op. */
  add(owner: UserId, domain: string, at: number): void;
  /** Drop an entry; false when it was not there. */
  remove(owner: UserId, domain: string): boolean;
  /** Give the entries that predate accounts to `owner`, merged into its list. */
  adopt(owner: UserId): void;
}

/**
 * The `trusted_domains` table in a SQLite file (`:memory:` for tests), created if missing. A table from before
 * accounts (one list, no `owner`) is rebuilt with its rows unowned, for the first account to adopt.
 */
const sqliteDomains = (file: string): DomainRecords & { close(): void } => {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA busy_timeout = 5000;");
  const columns = db
    .prepare("SELECT name FROM pragma_table_info('trusted_domains')")
    .all() as unknown as { name: string }[];
  const legacy =
    columns.length > 0 && !columns.some((column) => column.name === "owner");
  db.exec("BEGIN IMMEDIATE");
  try {
    if (legacy) {
      db.exec("ALTER TABLE trusted_domains RENAME TO trusted_domains_legacy");
    }
    // `owner` is NULL only on rows that predate accounts; `adopt` gives them away.
    db.exec(`
      CREATE TABLE IF NOT EXISTS trusted_domains (
        owner TEXT,
        domain TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE (owner, domain)
      );
    `);
    if (legacy) {
      db.exec(`
        INSERT INTO trusted_domains (owner, domain, created_at)
          SELECT NULL, domain, created_at FROM trusted_domains_legacy;
        DROP TABLE trusted_domains_legacy;
      `);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return {
    all: (owner) =>
      (
        db
          .prepare(
            "SELECT domain FROM trusted_domains WHERE owner = ? ORDER BY created_at, rowid"
          )
          .all(owner) as unknown as { domain: string }[]
      ).map((row) => row.domain),
    add: (owner, domain, at) => {
      db.prepare(
        "INSERT OR IGNORE INTO trusted_domains (owner, domain, created_at) VALUES (?, ?, ?)"
      ).run(owner, domain, at);
    },
    remove: (owner, domain) =>
      db
        .prepare("DELETE FROM trusted_domains WHERE owner = ? AND domain = ?")
        .run(owner, domain).changes > 0,
    adopt: (owner) => {
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare(
          `INSERT OR IGNORE INTO trusted_domains (owner, domain, created_at)
             SELECT ?, domain, created_at FROM trusted_domains WHERE owner IS NULL`
        ).run(owner);
        db.exec("DELETE FROM trusted_domains WHERE owner IS NULL");
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    close: () => db.close(),
  };
};

/** In memory, for tests: every User's list starts as `preset`. */
const memoryDomains = (preset: readonly string[]): DomainRecords => {
  const lists = new Map<UserId, string[]>();
  const listOf = (owner: UserId) => {
    let list = lists.get(owner);
    if (list === undefined) {
      list = [...preset];
      lists.set(owner, list);
    }
    return list;
  };
  return {
    all: (owner) => [...listOf(owner)],
    add: (owner, domain) => {
      const list = listOf(owner);
      if (!list.includes(domain)) {
        list.push(domain);
      }
    },
    remove: (owner, domain) => {
      const list = listOf(owner);
      const at = list.indexOf(domain);
      if (at === -1) {
        return false;
      }
      list.splice(at, 1);
      return true;
    },
    // Nothing in memory predates accounts; the owner's list starts from the preset as usual.
    adopt: (owner) => {
      listOf(owner);
    },
  };
};

export class TrustedDomains extends Context.Service<
  TrustedDomains,
  {
    /** Every domain `owner` trusts, in the order added. */
    list(owner: UserId): Effect.Effect<readonly string[]>;
    /**
     * Trust a domain for `owner`'s artifacts: a hostname (`cdn.example.com`), a wildcard (`*.example.com`), each
     * optionally with a port, or an http(s) URL reduced to its host. Returns the stored (normalized) entry; a repeat
     * adds nothing.
     */
    add(owner: UserId, input: string): Effect.Effect<string, InvalidDomain>;
    /** Stop trusting a domain; false when it was not trusted. */
    remove(owner: UserId, domain: string): Effect.Effect<boolean>;
    /** Give the entries that predate accounts to `owner`; idempotent. */
    adopt(owner: UserId): Effect.Effect<void>;
  }
>()("effect-pi/TrustedDomains") {
  static readonly layer = (options: { readonly records: DomainRecords }) =>
    Layer.effect(
      TrustedDomains,
      Effect.sync(() => {
        const { records } = options;
        return TrustedDomains.of({
          list: (owner) => Effect.sync(() => records.all(owner)),
          add: (owner, input) => {
            const domain = normalizeDomain(input);
            return domain === undefined
              ? Effect.fail(
                  new InvalidDomain({
                    domain: input,
                    reason:
                      "Not a domain. Enter a hostname like cdn.example.com, a wildcard like *.example.com, optionally with a :port.",
                  })
                )
              : Clock.currentTimeMillis.pipe(
                  Effect.map((at) => {
                    records.add(owner, domain, at);
                    return domain;
                  })
                );
          },
          remove: (owner, domain) =>
            Effect.sync(() => records.remove(owner, domain)),
          adopt: (owner) => Effect.sync(() => records.adopt(owner)),
        });
      })
    );

  /** The table in a SQLite file, created if missing. */
  static readonly local = (options: { readonly database: string }) =>
    Layer.unwrap(
      Effect.acquireRelease(
        Effect.sync(() => sqliteDomains(options.database)),
        (records) => Effect.sync(() => records.close())
      ).pipe(Effect.map((records) => TrustedDomains.layer({ records })))
    );

  /** An empty list in memory, writable; for tests. */
  static readonly temporary = () =>
    TrustedDomains.local({ database: ":memory:" });

  /** A preset list in memory for every User, writable; for tests. */
  static readonly memory = (domains: readonly string[]) =>
    TrustedDomains.layer({ records: memoryDomains(domains) });
}
