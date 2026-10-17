// The behavior every BlobStore must provide. store.test.ts runs this suite against directoryBlobs and s3Blobs over
// memory(); the store.s3.test.ts gate runs it against real SeaweedFS, where the same assertions must hold.
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { BlobStore } from "./store.ts";

const attachmentId = () => `att_${randomBytes(16).toString("hex")}`;

/**
 * The contract: `make` builds the store under test; attachment ids are random per run so reruns and sibling
 * implementations cannot collide.
 */
export const blobContract = (make: () => Promise<BlobStore> | BlobStore) => {
  describe("the BlobStore contract", () => {
    let blobs: BlobStore;
    const written: string[] = [];

    beforeAll(async () => {
      blobs = await make();
    });

    afterAll(async () => {
      await Promise.allSettled(written.map((id) => blobs?.removeAll(id)));
    });

    it("round-trips bytes and a file given by path", async () => {
      const id = attachmentId();
      written.push(id);
      const bytes = randomBytes(64);
      await blobs.put(`${id}/bytes`, bytes);

      const dir = mkdtempSync(path.join(tmpdir(), "blob-contract-"));
      const file = path.join(dir, "upload.bin");
      const contents = randomBytes(128);
      try {
        writeFileSync(file, contents);
        await blobs.put(`${id}/upload.bin`, { path: file });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }

      expect(await blobs.get(`${id}/bytes`)).toStrictEqual(
        new Uint8Array(bytes)
      );
      const stored = await blobs.get(`${id}/upload.bin`);
      expect(stored !== undefined && Buffer.from(stored).equals(contents)).toBe(
        true
      );
    });

    it("returns undefined for a missing key", async () => {
      expect(await blobs.get(`${attachmentId()}/missing`)).toBeUndefined();
    });

    it("removes one attachment's keys and nothing else", async () => {
      const gone = attachmentId();
      const kept = attachmentId();
      written.push(kept);
      await blobs.put(`${gone}/a`, Uint8Array.of(1));
      await blobs.put(`${gone}/nested/b`, Uint8Array.of(2));
      await blobs.put(`${kept}/a`, Uint8Array.of(3));

      await blobs.removeAll(gone);

      expect(await blobs.get(`${gone}/a`)).toBeUndefined();
      expect(await blobs.get(`${gone}/nested/b`)).toBeUndefined();
      expect(await blobs.get(`${kept}/a`)).toStrictEqual(Uint8Array.of(3));
    });

    it.each([".", "..", "", "a\\b"])(
      "rejects put and get of a key with the segment %j",
      async (segment) => {
        const key = `${attachmentId()}/${segment}`;
        await expect(blobs.put(key, Uint8Array.of(1))).rejects.toThrow(
          "Invalid blob key"
        );
        await expect(blobs.get(key)).rejects.toThrow("Invalid blob key");
      }
    );

    it.each([
      "att_abc",
      `att_${"a".repeat(31)}`,
      `att_${"A".repeat(32)}`,
      `att_${"a".repeat(32)}/../other`,
    ])("rejects removeAll of %j", async (id) => {
      await expect(blobs.removeAll(id)).rejects.toThrow(
        "Invalid attachment id"
      );
    });
  });
};
