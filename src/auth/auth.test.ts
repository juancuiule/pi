import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { Auth } from "./auth.ts";
import { hashPassword, verifyPassword } from "./password.ts";

const withAuth = <A, E>(
  program: (auth: Auth["Service"]) => Effect.Effect<A, E>
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        return yield* program(yield* Auth);
      })
    ).pipe(Effect.provide(Auth.temporary()))
  );

describe("passwords", () => {
  it("verifies the password it hashed and nothing else", async () => {
    const hash = await hashPassword("correct horse");
    expect(hash).not.toContain("correct horse");
    await expect(verifyPassword("correct horse", hash)).resolves.toBeTruthy();
    await expect(verifyPassword("correct hors", hash)).resolves.toBeFalsy();
    await expect(
      verifyPassword("correct horse", "scrypt$bad")
    ).resolves.toBeFalsy();
    await expect(hashPassword("correct horse")).resolves.not.toBe(hash);
  });
});

describe(Auth, () => {
  it("adds an account to a database whose folder does not exist yet", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "effect-pi-auth-"));
    const database = path.join(dir, "data", "effect-pi.sqlite");
    const names = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const auth = yield* Auth;
          yield* auth.addUser("juan", "password-j");
          return (yield* auth.users).map((user) => user.name);
        })
      ).pipe(Effect.provide(Auth.local({ database })))
    );
    rmSync(dir, { recursive: true, force: true });
    expect(names).toStrictEqual(["juan"]);
  });

  it("opens setup only until the first account, which it signs in", async () => {
    const result = await withAuth((auth) =>
      Effect.gen(function* () {
        const before = yield* auth.state();
        const first = yield* auth.setup("alice", "password-a");
        const after = yield* auth.state(first.token);
        const second = yield* Effect.flip(auth.setup("mallory", "password-m"));
        return { before, first: first.user.name, after, second };
      })
    );
    expect(result.before).toStrictEqual({ setup: true });
    expect(result.first).toBe("alice");
    expect(result.after).toMatchObject({
      setup: false,
      user: { name: "alice" },
    });
    expect(result.second._tag).toBe("SetupClosed");
  });

  it("signs in with the right password only, and signs out", async () => {
    const result = await withAuth((auth) =>
      Effect.gen(function* () {
        yield* auth.setup("alice", "password-a");
        const wrong = yield* Effect.flip(auth.login("alice", "password-b"));
        const unknown = yield* Effect.flip(auth.login("nobody", "password-a"));
        // Names are lowercase; a sign-in typed with capitals finds the same account.
        const { token } = yield* auth.login("Alice", "password-a");
        const signedIn = yield* auth.authenticate(token);
        yield* auth.logout(token);
        const afterLogout = yield* Effect.flip(auth.authenticate(token));
        const forged = yield* Effect.flip(auth.authenticate("forged"));
        const empty = yield* Effect.flip(auth.authenticate(""));
        return { wrong, unknown, signedIn, afterLogout, forged, empty };
      })
    );
    expect({
      wrong: result.wrong._tag,
      unknown: result.unknown._tag,
      signedIn: result.signedIn.name,
      afterLogout: result.afterLogout._tag,
      forged: result.forged._tag,
      empty: result.empty._tag,
    }).toStrictEqual({
      wrong: "InvalidCredentials",
      unknown: "InvalidCredentials",
      signedIn: "alice",
      afterLogout: "Unauthorized",
      forged: "Unauthorized",
      empty: "Unauthorized",
    });
  });

  it("blocks a name after repeated failures, even for the right password", async () => {
    const result = await withAuth((auth) =>
      Effect.gen(function* () {
        yield* auth.setup("alice", "password-a");
        yield* auth.addUser("bob", "password-b");
        const failures = [];
        for (let attempt = 0; attempt < 6; attempt += 1) {
          failures.push(
            (yield* Effect.flip(auth.login("alice", "wrong-password")))._tag
          );
        }
        const blocked = yield* Effect.flip(auth.login("alice", "password-a"));
        // Another name is not affected.
        const bob = yield* auth.login("bob", "password-b");
        return { failures, blocked, bob: bob.user.name };
      })
    );
    // Five free failures, then the name is blocked.
    expect(result.failures).toStrictEqual([
      ...Array.from({ length: 5 }, () => "InvalidCredentials"),
      "TooManyAttempts",
    ]);
    expect(result.blocked).toMatchObject({ _tag: "TooManyAttempts" });
    expect(
      result.blocked._tag === "TooManyAttempts" && result.blocked.retryAfterMs
    ).toBeGreaterThan(0);
    expect(result.bob).toBe("bob");
  });

  it("counts parallel guesses, so a burst cannot outrun the block", async () => {
    const tags = await withAuth((auth) =>
      Effect.gen(function* () {
        yield* auth.setup("alice", "password-a");
        const burst = yield* Effect.forEach(
          Array.from({ length: 12 }, (_, at) => `wrong-${at}-password`),
          (guess) => Effect.flip(auth.login("alice", guess)),
          { concurrency: "unbounded" }
        );
        return burst.map((error) => error._tag);
      })
    );
    expect(tags.filter((tag) => tag === "InvalidCredentials")).toHaveLength(5);
  });

  it("refuses bad names, short passwords and taken names", async () => {
    const result = await withAuth((auth) =>
      Effect.gen(function* () {
        const badName = yield* Effect.flip(auth.setup("Not Ok", "password-a"));
        const short = yield* Effect.flip(auth.setup("alice", "short"));
        yield* auth.setup("alice", "password-a");
        const taken = yield* Effect.flip(auth.addUser("alice", "password-b"));
        return { badName, short, taken };
      })
    );
    expect(result.badName._tag).toBe("InvalidAccount");
    expect(result.short._tag).toBe("InvalidAccount");
    expect(result.taken).toMatchObject({
      _tag: "InvalidAccount",
      reason: "An account named alice exists already.",
    });
  });

  it("ends every session of an account whose password changes", async () => {
    const result = await withAuth((auth) =>
      Effect.gen(function* () {
        const { token } = yield* auth.setup("alice", "password-a");
        yield* auth.setPassword("alice", "password-new");
        const old = yield* Effect.flip(auth.authenticate(token));
        const oldPassword = yield* Effect.flip(
          auth.login("alice", "password-a")
        );
        const fresh = yield* auth.login("alice", "password-new");
        return { old, oldPassword, fresh: fresh.user.name };
      })
    );
    expect(result.old._tag).toBe("Unauthorized");
    expect(result.oldPassword._tag).toBe("InvalidCredentials");
    expect(result.fresh).toBe("alice");
  });
});
