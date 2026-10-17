// Shared gate for `*.s3.test.ts` files: credentials come from docker/seaweedfs/.env, which init-env.ts
// generates (`pnpm seaweed:up`); a suite wraps itself in `describe.skipIf(!await s3GatewayUp(), …)` so it
// skips when the credentials or the gateway are missing.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { s3 } from '../storage/object-store.ts';
import type { ObjectStore } from '../storage/object-store.ts';

const envFile = path.join(import.meta.dirname, "../../docker/seaweedfs/.env");

export const s3Endpoint = process.env.S3_ENDPOINT ?? "http://127.0.0.1:8333";

export const s3Credentials = (() => {
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
    await fetch(s3Endpoint, { signal: AbortSignal.timeout(2000) });
    return true;
  } catch {
    return false;
  }
};

/** Whether a real S3 gateway is usable; `describe.skipIf(!await s3GatewayUp(), …)` gates each suite. */
export const s3GatewayUp = async () =>
  s3Credentials !== undefined && (await reachable());

/** An ObjectStore over the running gateway; throws when the credentials are missing (the suite skips first). */
export const s3TestStore = (): ObjectStore => {
  if (s3Credentials === undefined) {
    throw new Error("docker/seaweedfs/.env is missing (run pnpm seaweed:up)");
  }
  return s3({ endpoint: s3Endpoint, ...s3Credentials });
};
