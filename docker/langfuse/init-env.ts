// Writes the secrets for the local Langfuse (docker/langfuse/.env) and the keys the app sends traces with (.env at the
// repository root), once. Later runs keep the existing files, so the keys stay valid across restarts.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const here = import.meta.dirname;
const langfuseEnv = path.join(here, ".env");
const appEnv = path.join(here, "..", "..", ".env");

const secret = (bytes = 24) => randomBytes(bytes).toString("hex");
const lines = (values: Record<string, string>) =>
  `${Object.entries(values)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n")}\n`;

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

if (!existsSync(langfuseEnv)) {
  const postgres = secret();
  const minio = secret();
  writeFileSync(
    langfuseEnv,
    lines({
      POSTGRES_PASSWORD: postgres,
      DATABASE_URL: `postgresql://postgres:${postgres}@postgres:5432/postgres`,
      SALT: secret(),
      ENCRYPTION_KEY: secret(32),
      NEXTAUTH_SECRET: secret(),
      CLICKHOUSE_PASSWORD: secret(),
      REDIS_AUTH: secret(),
      MINIO_ROOT_PASSWORD: minio,
      LANGFUSE_S3_EVENT_UPLOAD_SECRET_ACCESS_KEY: minio,
      LANGFUSE_S3_MEDIA_UPLOAD_SECRET_ACCESS_KEY: minio,
      LANGFUSE_S3_BATCH_EXPORT_SECRET_ACCESS_KEY: minio,
      // Headless initialization: the organization, project, API keys and first user exist on first start.
      LANGFUSE_INIT_ORG_ID: "effect-pi",
      LANGFUSE_INIT_ORG_NAME: "effect-pi",
      LANGFUSE_INIT_PROJECT_ID: "effect-pi",
      LANGFUSE_INIT_PROJECT_NAME: "effect-pi",
      LANGFUSE_INIT_PROJECT_PUBLIC_KEY: `pk-lf-${secret(16)}`,
      LANGFUSE_INIT_PROJECT_SECRET_KEY: `sk-lf-${secret(16)}`,
      LANGFUSE_INIT_USER_EMAIL: "admin@effect-pi.local",
      LANGFUSE_INIT_USER_NAME: "admin",
      LANGFUSE_INIT_USER_PASSWORD: secret(12),
    }).replace(
      "LANGFUSE_INIT_ORG_ID",
      "# Headless initialization: created on first start\nLANGFUSE_INIT_ORG_ID"
    )
  );
  console.log(`Wrote ${path.relative(process.cwd(), langfuseEnv)}`);
}

const langfuse = readEnv(langfuseEnv);
const appValues = existsSync(appEnv) ? readEnv(appEnv) : {};
if (appValues.LANGFUSE_PUBLIC_KEY === undefined) {
  const existing = existsSync(appEnv) ? readFileSync(appEnv, "utf-8") : "";
  writeFileSync(
    appEnv,
    `${existing}${existing === "" || existing.endsWith("\n") ? "" : "\n"}${lines(
      {
        LANGFUSE_BASE_URL: "http://localhost:3000",
        LANGFUSE_PUBLIC_KEY: langfuse.LANGFUSE_INIT_PROJECT_PUBLIC_KEY ?? "",
        LANGFUSE_SECRET_KEY: langfuse.LANGFUSE_INIT_PROJECT_SECRET_KEY ?? "",
      }
    )}`
  );
  console.log(
    `Added the Langfuse keys to ${path.relative(process.cwd(), appEnv)}`
  );
}

console.log(
  `Langfuse: http://localhost:3000, log in as ${langfuse.LANGFUSE_INIT_USER_EMAIL} with password ${langfuse.LANGFUSE_INIT_USER_PASSWORD}`
);
