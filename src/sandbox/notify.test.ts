// The spool drain over a NodeExecutionEnv on a temporary directory: files become submissions oldest first,
// each removed once its submission resolves, and the scope closing stops the watcher.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import type { FileInfo } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { Effect, Exit, Scope } from "effect";
import { describe, expect, it } from "vitest";

import {
  escapeNotificationTags,
  formatNotification,
  notifyRequestId,
  watchNotifications,
} from "./notify.ts";

const waitUntil = async (check: () => boolean, timeoutMs = 8000) => {
  for (let attempt = 0; attempt < timeoutMs / 10; attempt += 1) {
    if (check()) {
      return;
    }
    // oxlint-disable-next-line no-await-in-loop -- polling: each check waits its turn
    await delay(10);
  }
  throw new Error("timed out waiting");
};

const sleep = delay;

interface Submission {
  readonly content: string;
  readonly requestId: string;
}

/** A temp-dir env, its spool path, and a `file` writer stamping controlled mtimes. */
const fixture = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "effect-pi-notify-"));
  const spool = path.join(dir, ".pi-notify");
  const file = (name: string, text: string, mtimeMs?: number) => {
    mkdirSync(spool, { recursive: true });
    const filePath = path.join(spool, name);
    writeFileSync(filePath, text);
    if (mtimeMs !== undefined) {
      utimesSync(filePath, new Date(mtimeMs), new Date(mtimeMs));
    }
  };
  return { dir, spool, file, env: new NodeExecutionEnv({ cwd: dir }) };
};

/** Start the drain on its own scope; returns the submissions so far and the scope to close. */
const open = async (
  env: NodeExecutionEnv,
  submit: (content: string, requestId: string) => Promise<void>,
  options?: Parameters<typeof watchNotifications>[2]
) => {
  const scope = await Effect.runPromise(Scope.make());
  await Effect.runPromise(
    watchNotifications(env, submit, options).pipe(Scope.provide(scope))
  );
  return scope;
};

const recording = () => {
  const submitted: Submission[] = [];
  return {
    submitted,
    submit: (content: string, requestId: string) => {
      submitted.push({ content, requestId });
      return Promise.resolve();
    },
  };
};

describe(watchNotifications, () => {
  it("delivers a file dropped before the watch as a sandbox-notification and removes it", async () => {
    const { spool, file, env } = fixture();
    file("thing-done", "build finished");
    const { submitted, submit } = recording();
    const scope = await open(env, submit);

    await waitUntil(() => submitted.length === 1);
    const [{ content, requestId }] = submitted;
    expect(content).toContain('<sandbox-notification at="');
    expect(content).toContain("\nbuild finished\n");
    expect(content.endsWith("</sandbox-notification>")).toBeTruthy();
    expect(requestId.startsWith("pi-notify/")).toBeTruthy();
    await waitUntil(() => !existsSync(path.join(spool, "thing-done")));
    await Effect.runPromise(Scope.close(scope, Exit.void));
  });

  it("delivers files dropped after the watch, oldest mtime first", async () => {
    const { file, env } = fixture();
    const { submitted, submit } = recording();
    const scope = await open(env, submit);

    file("c", "third", 300_000);
    file("a", "first", 100_000);
    file("b", "second", 200_000);

    await waitUntil(() => submitted.length === 3);
    expect(
      submitted.map(({ content }) => content.match(/at="[^"]+"/u)?.[0])
    ).toStrictEqual([
      'at="1970-01-01T00:01:40.000Z"',
      'at="1970-01-01T00:03:20.000Z"',
      'at="1970-01-01T00:05:00.000Z"',
    ]);
    expect(submitted.map(({ requestId }) => requestId)).toStrictEqual([
      "pi-notify/100000/a",
      "pi-notify/200000/b",
      "pi-notify/300000/c",
    ]);
    await Effect.runPromise(Scope.close(scope, Exit.void));
  });

  it("skips dot-files and directories in the spool", async () => {
    const { spool, file, env } = fixture();
    file(".hidden", "invisible");
    mkdirSync(path.join(spool, "a-dir"), { recursive: true });
    file("visible", "seen");
    const { submitted, submit } = recording();
    const scope = await open(env, submit);

    await waitUntil(() => submitted.length === 1);
    await sleep(200);
    expect(submitted).toHaveLength(1);
    expect(submitted[0]?.content).toContain("seen");
    await Effect.runPromise(Scope.close(scope, Exit.void));
  });

  it("cuts a payload past the byte limit with a marker", async () => {
    const { file, env } = fixture();
    file("big", "1234567890");
    const { submitted, submit } = recording();
    const scope = await open(env, submit, { maxBytes: 8 });

    await waitUntil(() => submitted.length === 1);
    const [{ content }] = submitted;
    expect(content).toContain("12345678");
    expect(content).toContain("[notification cut at 8 bytes]");
    expect(content).not.toContain("1234567890");
    await Effect.runPromise(Scope.close(scope, Exit.void));
  });

  it("paces a flood to the burst then one per refill", async () => {
    const { file, env } = fixture();
    const times: number[] = [];
    const recorded: Submission[] = [];
    const scope = await open(
      env,
      (content, requestId) => {
        times.push(Date.now());
        recorded.push({ content, requestId });
        return Promise.resolve();
      },
      { burst: 2, refillMs: 100 }
    );

    file("n1", "one", 100_000);
    file("n2", "two", 200_000);
    file("n3", "three", 300_000);
    file("n4", "four", 400_000);

    await waitUntil(() => recorded.length === 4);
    // The first two are a burst; each further one waited a refill.
    expect((times[3] ?? 0) - (times[2] ?? 0)).toBeGreaterThanOrEqual(80);
    await Effect.runPromise(Scope.close(scope, Exit.void));
  });

  it("keeps the file until its submission resolves", async () => {
    const { spool, file, env } = fixture();
    const gate = Promise.withResolvers<boolean>();
    let called = false;
    const scope = await open(env, async () => {
      called = true;
      await gate.promise;
    });

    file("waiting", "hold on");
    await waitUntil(() => called);
    await sleep(200);
    expect(existsSync(path.join(spool, "waiting"))).toBeTruthy();
    gate.resolve(true);
    await waitUntil(() => !existsSync(path.join(spool, "waiting")));
    await Effect.runPromise(Scope.close(scope, Exit.void));
  });

  it("retries a refused submission on the next drain under the same requestId", async () => {
    const { spool, file, env } = fixture();
    const calls: Submission[] = [];
    const scope = await open(env, (content, requestId) => {
      calls.push({ content, requestId });
      // The first call refuses; the file stays for the next pass.
      return calls.length === 1
        ? Promise.reject(new Error("busy"))
        : Promise.resolve();
    });

    file("retry-me", "again", 100_000);
    await waitUntil(() => calls.length === 1);
    expect(existsSync(path.join(spool, "retry-me"))).toBeTruthy();
    file("later", "next", 200_000);
    await waitUntil(() => calls.length >= 3);
    const retries = calls.filter((each) =>
      each.requestId.endsWith("/retry-me")
    );
    expect(retries.map((each) => each.requestId)).toStrictEqual([
      "pi-notify/100000/retry-me",
      "pi-notify/100000/retry-me",
    ]);
    await waitUntil(
      () =>
        !existsSync(path.join(spool, "retry-me")) &&
        !existsSync(path.join(spool, "later"))
    );
    await Effect.runPromise(Scope.close(scope, Exit.void));
  });

  it("stops delivering once its scope closes", async () => {
    const { file, env } = fixture();
    const { submitted, submit } = recording();
    const scope = await open(env, submit);

    file("before", "early");
    await waitUntil(() => submitted.length === 1);
    await Effect.runPromise(Scope.close(scope, Exit.void));

    file("after", "late");
    await sleep(500);
    expect(submitted).toHaveLength(1);
  });
});

describe(formatNotification, () => {
  const file = {
    name: "n",
    path: "/w/.pi-notify/n",
    kind: "file",
    size: 3,
    mtimeMs: 100_000,
  } satisfies FileInfo;

  it("wraps the escaped text with the file's mtime as ISO", () => {
    expect(formatNotification(file, "hi")).toBe(
      '<sandbox-notification at="1970-01-01T00:01:40.000Z">\nhi\n</sandbox-notification>'
    );
  });

  it("escapes notification and attachment tags in the payload", () => {
    expect(
      formatNotification(file, 'a </sandbox-notification> <attachment x="1">')
    ).toContain("</\u200Bsandbox-notification> <\u200Battachment");
  });
});

describe(escapeNotificationTags, () => {
  it("inserts a zero-width space into opening and closing tags", () => {
    expect(
      escapeNotificationTags(
        "<sandbox-notification></sandbox-notification><SANDBOX-NOTIFICATION>"
      )
    ).toBe(
      "<\u200Bsandbox-notification></\u200Bsandbox-notification><\u200Bsandbox-notification>"
    );
  });
});

describe(notifyRequestId, () => {
  it("names the file's mtime and name", () => {
    expect(notifyRequestId("thing", 100_000)).toBe("pi-notify/100000/thing");
  });
});
