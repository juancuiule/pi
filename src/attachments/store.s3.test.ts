// The BlobStore contract against the real SeaweedFS gateway (`pnpm seaweed:up`), run by `pnpm test:s3`.
// Credentials come from docker/seaweedfs/.env, which init-env.ts generates; the suite skips when they are
// missing or the gateway does not answer.
import { describe } from "vitest";

import { BUCKETS } from "../storage/object-store.ts";
import { s3GatewayUp, s3TestStore } from "../testing/s3.ts";
import { blobContract } from "./store.contract.ts";
import { s3Blobs } from "./store.ts";

const make = async () => {
  const store = s3TestStore();
  await store.ensure(BUCKETS.attachments);
  return s3Blobs(store, BUCKETS.attachments);
};

describe.skipIf(!(await s3GatewayUp()))(
  "attachment blobs in S3",
  { timeout: 120_000 },
  () => {
    blobContract(make);
  }
);
