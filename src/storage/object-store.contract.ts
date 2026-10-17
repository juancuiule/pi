// The behavior every ObjectStore must provide. object-store.test.ts runs this suite against memory(); the
// object-store.s3.test.ts gate runs it against real SeaweedFS, where the same assertions must hold.
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ObjectStore } from "./object-store.ts";

const toBytes = async (stream: Readable): Promise<Uint8Array> => {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk as Uint8Array);
  }
  return Buffer.concat(chunks);
};

const sorted = (keys: readonly { key: string; size: number }[]) =>
  keys.toSorted((a, b) => a.key.localeCompare(b.key));

/** The contract: `make` builds the store under test; buckets are random per run so reruns cannot collide. */
export const storeContract = (
  make: () => Promise<ObjectStore> | ObjectStore
) => {
  describe("the ObjectStore contract", () => {
    const bucket = `contract-${randomBytes(8).toString("hex")}`;
    let store: ObjectStore;

    beforeAll(async () => {
      store = await make();
      await store.ensure(bucket);
    });

    afterAll(async () => {
      await store?.removePrefix(bucket, "");
    });

    it("round-trips bytes, a stream and a file given by path", async () => {
      const bytes = randomBytes(64);
      await store.put(bucket, "roundtrip/bytes", bytes);
      await store.put(
        bucket,
        "roundtrip/stream",
        Readable.from([randomBytes(64)])
      );

      // Bigger than the SDK's 5MB part size, so the {path} upload really streams multipart.
      const dir = mkdtempSync(path.join(tmpdir(), "object-store-"));
      const file = path.join(dir, "big.bin");
      const big = randomBytes(6 * 1024 * 1024);
      try {
        writeFileSync(file, big);
        await store.put(bucket, "roundtrip/path", { path: file });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }

      expect(await store.get(bucket, "roundtrip/bytes")).toStrictEqual(
        new Uint8Array(bytes)
      );
      // Deep equality walks every element, which is far too slow at this size; compare natively instead.
      const stored = await store.get(bucket, "roundtrip/path");
      expect(stored !== undefined && Buffer.from(stored).equals(big)).toBe(
        true
      );
      const stream = await store.read(bucket, "roundtrip/stream");
      expect(stream).toBeDefined();
      const streamed = await toBytes(stream as Readable);
      expect(streamed.length).toBe(64);
    });

    it("returns undefined from get and read for a missing key", async () => {
      expect(await store.get(bucket, "missing")).toBeUndefined();
      expect(await store.read(bucket, "missing")).toBeUndefined();
    });

    it("lists the keys under a prefix with their sizes", async () => {
      await store.put(bucket, "listing/a/1", Uint8Array.of(1, 2, 3));
      await store.put(bucket, "listing/a/2", Uint8Array.of(4));
      await store.put(bucket, "listing/b/1", Uint8Array.of(5, 6));

      expect(await store.list(bucket, "listing/a/")).toStrictEqual(
        sorted([
          { key: "listing/a/1", size: 3 },
          { key: "listing/a/2", size: 1 },
        ])
      );
      expect(sorted(await store.list(bucket, "listing/")).length).toBe(3);
      expect(await store.list(bucket, "listing/none/")).toStrictEqual([]);
    });

    it("removes everything under a prefix and nothing else", async () => {
      await store.put(bucket, "removing/gone/1", Uint8Array.of(1));
      await store.put(bucket, "removing/gone/2", Uint8Array.of(2));
      await store.put(bucket, "removing/kept", Uint8Array.of(3));

      await store.removePrefix(bucket, "removing/gone/");

      expect(await store.list(bucket, "removing/")).toStrictEqual([
        { key: "removing/kept", size: 1 },
      ]);
      await store.removePrefix(bucket, "removing/");
      expect(await store.list(bucket, "removing/")).toStrictEqual([]);
    });

    it("ensures a bucket idempotently", async () => {
      const other = `contract-${randomBytes(8).toString("hex")}`;
      await store.ensure(other);
      await store.ensure(other);
      await store.put(other, "key", Uint8Array.of(1));
      expect(await store.get(other, "key")).toStrictEqual(Uint8Array.of(1));
      await store.removePrefix(other, "");
    });
  });
};
