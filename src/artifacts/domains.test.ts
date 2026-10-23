import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { alice, bob } from "../testing/users.ts";
import { isTrusted, normalizeDomain, TrustedDomains } from "./domains.ts";

const withDomains = <A, E>(
  program: (domains: (typeof TrustedDomains)["Service"]) => Effect.Effect<A, E>
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const domains = yield* TrustedDomains;
        return yield* program(domains);
      })
    ).pipe(Effect.provide(TrustedDomains.temporary()))
  );

describe(normalizeDomain, () => {
  it("keeps hostnames, wildcards and ports, lowercased", () => {
    expect(
      [
        "CDN.Example.COM",
        "*.example.com",
        "example.com:8080",
        "*.example.com:8080",
        "localhost",
        "127.0.0.1:8000",
        "  cdn.example.com  ",
      ].map(normalizeDomain)
    ).toStrictEqual([
      "cdn.example.com",
      "*.example.com",
      "example.com:8080",
      "*.example.com:8080",
      "localhost",
      "127.0.0.1:8000",
      "cdn.example.com",
    ]);
  });

  it("reduces an http(s) URL — or a bare host/path — to its host and port", () => {
    expect(
      [
        "https://cdn.example.com/a/b.png?q=1",
        "http://user:pw@localhost:3000/",
        "example.com/path",
        "https://*.example.com/a.png",
        "*.https://x.com",
      ].map(normalizeDomain)
    ).toStrictEqual([
      "cdn.example.com",
      "localhost:3000",
      "example.com",
      "*.example.com",
      undefined,
    ]);
  });

  it("rejects anything that is not a host", () => {
    const inputs = [
      "",
      "   ",
      "not a domain!",
      "*",
      "*.",
      "*.com",
      "example.com:",
      "example.com:0",
      "example.com:70000",
      "example.com:abc",
      "a:b:c.com",
      // oxlint-disable-next-line no-script-url -- a scheme to refuse, not a URL to run
      "javascript://x.com",
      "ftp://x.com",
      "-bad.com",
      "bad-.com",
      "exa mple.com",
    ];
    expect(inputs.map(normalizeDomain)).toSatisfy(
      (results: (string | undefined)[]) =>
        results.every((result) => result === undefined)
    );
  });
});

describe(isTrusted, () => {
  const domains = ["cdn.example.com", "*.other.com", "local:8080"];

  it("matches an entry exactly or under a wildcard", () => {
    expect(
      [
        "cdn.example.com",
        "example.com",
        "a.other.com",
        "a.b.other.com",
        "other.com",
        "evilexample.com",
        "local:8080",
        "local",
      ].map((host) => isTrusted(host, domains))
    ).toStrictEqual([true, false, true, true, false, false, true, false]);
  });
});

describe(TrustedDomains, () => {
  it("adds, lists and removes domains, normalized and deduped", async () => {
    const result = await withDomains((domains) =>
      Effect.gen(function* () {
        const added = yield* domains.add(alice.id, "CDN.Example.COM/img.png");
        const invalid = yield* Effect.exit(
          domains.add(alice.id, "not a domain!")
        );
        yield* domains.add(alice.id, "cdn.example.com");
        yield* domains.add(alice.id, "*.other.com");
        const removed = yield* domains.remove(alice.id, "cdn.example.com");
        const absent = yield* domains.remove(alice.id, "gone.com");
        return {
          added,
          invalid,
          removed,
          absent,
          list: yield* domains.list(alice.id),
        };
      })
    );
    expect(result.added).toBe("cdn.example.com");
    expect(JSON.stringify(result.invalid)).toContain("Not a domain");
    expect(result).toMatchObject({
      removed: true,
      absent: false,
      list: ["*.other.com"],
    });
  });

  it("keeps one list per user", async () => {
    const result = await withDomains((domains) =>
      Effect.gen(function* () {
        yield* domains.add(alice.id, "cdn.alice.com");
        yield* domains.add(bob.id, "cdn.bob.com");
        const bobRemovedAlices = yield* domains.remove(bob.id, "cdn.alice.com");
        return {
          alice: yield* domains.list(alice.id),
          bob: yield* domains.list(bob.id),
          bobRemovedAlices,
        };
      })
    );
    expect(result).toStrictEqual({
      alice: ["cdn.alice.com"],
      bob: ["cdn.bob.com"],
      bobRemovedAlices: false,
    });
  });

  it("migrates a list from before accounts, which the adopting user then owns", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "domains-"));
    const file = path.join(dir, "db.sqlite");
    const legacy = new DatabaseSync(file);
    legacy.exec(`
      CREATE TABLE trusted_domains (domain TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
      INSERT INTO trusted_domains VALUES ('cdn.old.com', 1), ('*.shared.com', 2);
    `);
    legacy.close();
    try {
      const result = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const domains = yield* TrustedDomains;
            const beforeAdoption = yield* domains.list(alice.id);
            yield* domains.add(alice.id, "*.shared.com");
            yield* domains.adopt(alice.id);
            yield* domains.adopt(bob.id);
            return {
              beforeAdoption,
              alice: yield* domains.list(alice.id),
              bob: yield* domains.list(bob.id),
            };
          })
        ).pipe(Effect.provide(TrustedDomains.local({ database: file })))
      );
      expect(result).toStrictEqual({
        beforeAdoption: [],
        alice: ["cdn.old.com", "*.shared.com"],
        bob: [],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
