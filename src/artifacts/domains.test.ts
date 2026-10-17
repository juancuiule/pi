import { Effect } from "effect";
import { describe, expect, it } from "vitest";

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
        const added = yield* domains.add("CDN.Example.COM/img.png");
        const invalid = yield* Effect.exit(domains.add("not a domain!"));
        yield* domains.add("cdn.example.com");
        yield* domains.add("*.other.com");
        const removed = yield* domains.remove("cdn.example.com");
        const absent = yield* domains.remove("gone.com");
        return {
          added,
          invalid,
          removed,
          absent,
          list: yield* domains.list(),
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
});
