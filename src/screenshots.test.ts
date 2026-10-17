import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ConversationId } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it, vi } from "vitest";

import { saveScreenshotsTo, saveScreenshotsToBlobs } from "./screenshots.ts";
import { BUCKETS, memory } from "./storage/object-store.ts";

const source = (sandboxId: string, callId: string) => ({
  sandboxId,
  conversationId: 1 as ConversationId,
  callId,
});

describe(saveScreenshotsTo, () => {
  let root = "";
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("numbers each sandbox's screenshots in the order they were taken", async () => {
    root = mkdtempSync(path.join(tmpdir(), "effect-pi-screenshots-"));
    const save = saveScreenshotsTo(root);

    const first = await save(Uint8Array.of(1), source("desktop-a", "call-1"));
    const second = await save(Uint8Array.of(2), source("desktop-a", "call-2"));
    const other = await save(Uint8Array.of(3), source("desktop-b", "call-1"));

    expect([first, second, other]).toStrictEqual([
      path.join(root, "desktop-a", "001.png"),
      path.join(root, "desktop-a", "002.png"),
      path.join(root, "desktop-b", "001.png"),
    ]);
    expect([...readFileSync(second)]).toStrictEqual([2]);
  });

  it("never overwrites a screenshot taken at the same time", async () => {
    root = mkdtempSync(path.join(tmpdir(), "effect-pi-screenshots-"));
    const save = saveScreenshotsTo(root);

    await Promise.all(
      [1, 2, 3, 4, 5].map((n) =>
        save(Uint8Array.of(n), source("desktop", `call-${n}`))
      )
    );

    const dir = path.join(root, "desktop");
    const contents = readdirSync(dir).map(
      (file) => readFileSync(path.join(dir, file))[0]
    );
    expect(contents.toSorted()).toStrictEqual([1, 2, 3, 4, 5]);
  });
});

describe(saveScreenshotsToBlobs, () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("names the object <conversation>/<sandbox>/<epoch ms>-<call>.png and returns screenshots/<key>", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    const store = memory();
    const save = saveScreenshotsToBlobs(store, BUCKETS.screenshots);

    const reference = await save(
      Uint8Array.of(1, 2, 3),
      source("desktop-a", "call-1")
    );

    expect(reference).toBe("screenshots/1/desktop-a/1700000000000-call-1.png");
    await expect(
      store.get(BUCKETS.screenshots, "1/desktop-a/1700000000000-call-1.png")
    ).resolves.toStrictEqual(Uint8Array.of(1, 2, 3));
  });

  it("a replayed call overwrites its own object instead of adding a second one", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    const store = memory();
    const save = saveScreenshotsToBlobs(store, BUCKETS.screenshots);

    const first = await save(Uint8Array.of(1), source("desktop", "call-1"));
    const second = await save(Uint8Array.of(9), source("desktop", "call-1"));

    expect(second).toBe(first);
    await expect(
      store.list(BUCKETS.screenshots, "1/desktop/")
    ).resolves.toStrictEqual([
      { key: "1/desktop/1700000000000-call-1.png", size: 1 },
    ]);
    await expect(
      store.get(BUCKETS.screenshots, "1/desktop/1700000000000-call-1.png")
    ).resolves.toStrictEqual(Uint8Array.of(9));
  });

  it("keeps screenshots of different calls at the same instant apart", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    const store = memory();
    const save = saveScreenshotsToBlobs(store, BUCKETS.screenshots);

    await save(Uint8Array.of(1), source("desktop", "call-1"));
    await save(Uint8Array.of(2), source("desktop", "call-2"));

    await expect(
      store.list(BUCKETS.screenshots, "1/desktop/")
    ).resolves.toStrictEqual([
      { key: "1/desktop/1700000000000-call-1.png", size: 1 },
      { key: "1/desktop/1700000000000-call-2.png", size: 1 },
    ]);
  });
});
