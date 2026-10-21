import { randomBytes } from "node:crypto";

// The ObjectStore contract against the real SeaweedFS gateway (`pnpm seaweed:up`), run by `pnpm test:s3`.
// Credentials come from docker/seaweedfs/.env, which init-env.ts generates; the suite skips when they are
// missing or the gateway does not answer.
import {
  GetBucketLifecycleConfigurationCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";

import {
  s3Credentials,
  s3Endpoint,
  s3GatewayUp,
  s3TestStore,
} from "../testing/s3.ts";
import { storeContract } from "./object-store.contract.ts";

describe.skipIf(!(await s3GatewayUp()))(
  "the S3 object store",
  { timeout: 120_000 },
  () => {
    storeContract(s3TestStore);

    it("applies the screenshots lifecycle rule", async () => {
      const store = s3TestStore();
      const bucket = `lifecycle-${randomBytes(8).toString("hex")}`;
      await store.ensure(bucket);
      await store.setExpiration(bucket, 30);

      const client = new S3Client({
        endpoint: s3Endpoint,
        forcePathStyle: true,
        region: "us-east-1",
        credentials: s3Credentials ?? {
          accessKeyId: "",
          secretAccessKey: "",
        },
      });
      try {
        const config = await client.send(
          new GetBucketLifecycleConfigurationCommand({ Bucket: bucket })
        );
        expect(config.Rules).toStrictEqual([
          expect.objectContaining({
            Status: "Enabled",
            Expiration: expect.objectContaining({ Days: 30 }),
          }),
        ]);
      } finally {
        await store.drop(bucket);
      }
    });
  }
);
