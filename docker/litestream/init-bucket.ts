// Ensures the litestream bucket exists, so `pnpm litestream:up` works before the server has run with
// STORAGE=s3 (server startup also ensures it). Credentials come from docker/seaweedfs/.env, which
// docker/seaweedfs/init-env.ts writes; the endpoint is the root .env's S3_ENDPOINT or the gateway default.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { BUCKETS, s3 } from "../../src/storage/object-store.ts";

const here = import.meta.dirname;
const seaweedEnv = path.join(here, "..", "seaweedfs", ".env");
const appEnv = path.join(here, "..", "..", ".env");

const readEnv = (file: string): Record<string, string> =>
  Object.fromEntries(
    readFileSync(file, "utf-8")
      .split("\n")
      .filter((line) => line.includes("=") && !line.startsWith("#"))
      .map((line) => {
        const index = line.indexOf("=");
        return [line.slice(0, index), line.slice(index + 1)];
      })
  );

if (!existsSync(seaweedEnv)) {
  console.error(
    `${path.relative(process.cwd(), seaweedEnv)} is missing: run \`pnpm seaweed:up\` first`
  );
  process.exit(1);
}

const seaweed = readEnv(seaweedEnv);
const app = existsSync(appEnv) ? readEnv(appEnv) : {};
const endpoint = app.S3_ENDPOINT ?? "http://127.0.0.1:8333";

const store = s3({
  endpoint,
  accessKeyId: seaweed.S3_ACCESS_KEY_ID ?? "",
  secretAccessKey: seaweed.S3_SECRET_ACCESS_KEY ?? "",
});
await store.ensure(BUCKETS.litestream);
console.log(`Bucket "${BUCKETS.litestream}" ready on ${endpoint}`);
