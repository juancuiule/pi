// saveScreenshotsToBlobs against the real SeaweedFS gateway (`pnpm seaweed:up`), run by `pnpm test:s3`.
// Credentials come from docker/seaweedfs/.env, which init-env.ts generates; the suite skips when they are
// missing or the gateway does not answer.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import type { ConversationId } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";

import { saveScreenshotsToBlobs } from "./screenshots.ts";
import { BUCKETS, s3 } from "./storage/object-store.ts";

const envFile = path.join(import.meta.dirname, "../docker/seaweedfs/.env");
const endpoint = process.env.S3_ENDPOINT ?? "http://127.0.0.1:8333";

const credentials = (() => {
  if (!existsSync(envFile)) {
    return;
  }
  const values = Object.fromEntries(
    readFileSync(envFile, "utf-8")
      .split("\n")
      .filter((line) => line.includes("=") && !line.startsWith("#"))
      .map((line) => {
        const index = line.indexOf("=");
        return [line.slice(0, index), line.slice(index + 1)];
      })
  );
  const accessKeyId = values.S3_ACCESS_KEY_ID;
  const secretAccessKey = values.S3_SECRET_ACCESS_KEY;
  return accessKeyId === undefined || secretAccessKey === undefined
    ? undefined
    : { accessKeyId, secretAccessKey };
})();

const reachable = async () => {
  try {
    await fetch(endpoint, { signal: AbortSignal.timeout(2000) });
    return true;
  } catch {
    return false;
  }
};

const store = () => {
  if (credentials === undefined) {
    throw new Error("docker/seaweedfs/.env is missing (run pnpm seaweed:up)");
  }
  return s3({ endpoint, ...credentials });
};

describe.skipIf(credentials === undefined || !(await reachable()))(
  "screenshots in S3",
  { timeout: 120_000 },
  () => {
    it("puts the png under <conversation>/<sandbox>/ in the bucket", async () => {
      const objects = store();
      await objects.ensure(BUCKETS.screenshots);
      const conversationId = Math.floor(
        Math.random() * 1_000_000_000
      ) as ConversationId;
      const sandboxId = `s3-${randomBytes(4).toString("hex")}`;
      const save = saveScreenshotsToBlobs(objects, BUCKETS.screenshots);

      const reference = await save(Uint8Array.of(1, 2, 3), {
        sandboxId,
        conversationId,
        callId: "call-1",
      });

      const key = reference.slice(`${BUCKETS.screenshots}/`.length);
      expect(key.startsWith(`${conversationId}/${sandboxId}/`)).toBeTruthy();
      expect(key.endsWith("-call-1.png")).toBeTruthy();
      await expect(
        objects.get(BUCKETS.screenshots, key)
      ).resolves.toStrictEqual(Uint8Array.of(1, 2, 3));
      await objects.removePrefix(BUCKETS.screenshots, `${conversationId}/`);
    });
  }
);
