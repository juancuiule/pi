// The hosts an artifact page may load images from, managed under Settings → Trusted domains and kept in a
// `trusted_domains` table of the EFFECT_PI_DB file like `artifacts`. The render endpoint puts them in the page's
// img-src CSP; artifact_create/artifact_update refuse a page whose images come from anywhere else (refs.ts).
import { DatabaseSync } from "node:sqlite";

import { Clock, Context, Effect, Layer } from "effect";

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

/** The stored form of the trusted list. */
interface DomainRecords {
  /** Every entry, in the order added. */
  all(): readonly string[];
  /** Record an entry; an existing one is a no-op. */
  add(domain: string, at: number): void;
  /** Drop an entry; false when it was not there. */
  remove(domain: string): boolean;
}

/** The `trusted_domains` table in a SQLite file (`:memory:` for tests), created if missing. */
const sqliteDomains = (file: string): DomainRecords & { close(): void } => {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS trusted_domains (
      domain TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL
    );
  `);
  return {
    all: () =>
      (
        db
          .prepare("SELECT domain FROM trusted_domains ORDER BY created_at")
          .all() as unknown as { domain: string }[]
      ).map((row) => row.domain),
    add: (domain, at) => {
      db.prepare(
        "INSERT OR IGNORE INTO trusted_domains (domain, created_at) VALUES (?, ?)"
      ).run(domain, at);
    },
    remove: (domain) =>
      db.prepare("DELETE FROM trusted_domains WHERE domain = ?").run(domain)
        .changes > 0,
    close: () => db.close(),
  };
};

/** An in-memory list, for tests and preset lists. */
const memoryDomains = (preset: readonly string[]): DomainRecords => {
  const all = [...preset];
  return {
    all: () => [...all],
    add: (domain) => {
      if (!all.includes(domain)) {
        all.push(domain);
      }
    },
    remove: (domain) => {
      const at = all.indexOf(domain);
      if (at === -1) {
        return false;
      }
      all.splice(at, 1);
      return true;
    },
  };
};

export class TrustedDomains extends Context.Service<
  TrustedDomains,
  {
    /** Every trusted domain, in the order added. */
    list(): Effect.Effect<readonly string[]>;
    /**
     * Trust a domain: a hostname (`cdn.example.com`), a wildcard (`*.example.com`), each optionally with a port, or
     * an http(s) URL reduced to its host. Returns the stored (normalized) entry; a repeat adds nothing.
     */
    add(input: string): Effect.Effect<string, InvalidDomain>;
    /** Stop trusting a domain; false when it was not trusted. */
    remove(domain: string): Effect.Effect<boolean>;
  }
>()("effect-pi/TrustedDomains") {
  static readonly layer = (options: { readonly records: DomainRecords }) =>
    Layer.effect(
      TrustedDomains,
      Effect.sync(() => {
        const { records } = options;
        return TrustedDomains.of({
          list: () => Effect.sync(() => records.all()),
          add: (input) => {
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
                    records.add(domain, at);
                    return domain;
                  })
                );
          },
          remove: (domain) => Effect.sync(() => records.remove(domain)),
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

  /** A preset list in memory, writable; for tests. */
  static readonly memory = (domains: readonly string[]) =>
    TrustedDomains.layer({ records: memoryDomains(domains) });
}
