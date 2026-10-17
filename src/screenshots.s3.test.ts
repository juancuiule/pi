// saveScreenshotsToBlobs against the real SeaweedFS gateway (`pnpm seaweed:up`), run by `pnpm test:s3`.
// Credentials come from docker/seaweedfs/.env, which init-env.ts generates; the suite skips when they are
// missing or the gateway does not answer.
import { randomBytes } from "node:crypto";

import type { ConversationId } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";

import { saveScreenshotsToBlobs } from "./screenshots.ts";
import { BUCKETS } from "./storage/object-store.ts";
import { s3GatewayUp, s3TestStore } from "./testing/s3.ts";

describe.skipIf(!(await s3GatewayUp()))(
  "screenshots in S3",
  { timeout: 120_000 },
  () => {
    it("puts the png under <conversation>/<sandbox>/ in the bucket", async () => {
      const objects = s3TestStore();
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
