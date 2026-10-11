import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ConversationId } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";

import { saveScreenshotsTo } from "./screenshots.ts";

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
