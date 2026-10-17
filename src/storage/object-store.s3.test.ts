import { randomBytes } from "node:crypto";
// The ObjectStore contract against the real SeaweedFS gateway (`pnpm seaweed:up`), run by `pnpm test:s3`.
// Credentials come from docker/seaweedfs/.env, which init-env.ts generates; the suite skips when they are
// missing or the gateway does not answer.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  GetBucketLifecycleConfigurationCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";

import { storeContract } from "./object-store.contract.ts";
import { s3 } from "./object-store.ts";

const envFile = path.join(import.meta.dirname, "../../docker/seaweedfs/.env");
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

const make = () => {
  if (credentials === undefined) {
    throw new Error("docker/seaweedfs/.env is missing (run pnpm seaweed:up)");
  }
  return s3({ endpoint, ...credentials });
};

describe.skipIf(credentials === undefined || !(await reachable()))(
  "the S3 object store",
  { timeout: 120_000 },
  () => {
    storeContract(make);

    it("applies the screenshots lifecycle rule", async () => {
      const store = make();
      const bucket = `lifecycle-${randomBytes(8).toString("hex")}`;
      await store.ensure(bucket);
      await store.setExpiration(bucket, 30);

      const client = new S3Client({
        endpoint,
        forcePathStyle: true,
        region: "us-east-1",
        credentials: credentials ?? { accessKeyId: "", secretAccessKey: "" },
      });
      const config = await client.send(
        new GetBucketLifecycleConfigurationCommand({ Bucket: bucket })
      );
      expect(config.Rules).toStrictEqual([
        expect.objectContaining({
          Status: "Enabled",
          Expiration: expect.objectContaining({ Days: 30 }),
        }),
      ]);
    });
  }
);
