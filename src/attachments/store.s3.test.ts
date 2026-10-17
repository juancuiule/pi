// The BlobStore contract against the real SeaweedFS gateway (`pnpm seaweed:up`), run by `pnpm test:s3`.
// Credentials come from docker/seaweedfs/.env, which init-env.ts generates; the suite skips when they are
// missing or the gateway does not answer.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe } from "vitest";

import { BUCKETS, s3 } from "../storage/object-store.ts";
import { blobContract } from "./store.contract.ts";
import { s3Blobs } from "./store.ts";

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

const make = async () => {
  if (credentials === undefined) {
    throw new Error("docker/seaweedfs/.env is missing (run pnpm seaweed:up)");
  }
  const store = s3({ endpoint, ...credentials });
  await store.ensure(BUCKETS.attachments);
  return s3Blobs(store, BUCKETS.attachments);
};

describe.skipIf(credentials === undefined || !(await reachable()))(
  "attachment blobs in S3",
  { timeout: 120_000 },
  () => {
    blobContract(make);
  }
);
