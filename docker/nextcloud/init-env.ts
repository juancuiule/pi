// Writes the secrets for the local Nextcloud (docker/nextcloud/.env), and points the app at it with a key to seal
// connector credentials (NEXTCLOUD_URL and CONNECTOR_SECRET_KEY in .env at the repository root), once. Later runs keep
// the existing values. NEXTCLOUD_PORT in the environment picks the port on the first run (8180 by default).
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const here = import.meta.dirname;
const nextcloudEnv = path.join(here, ".env");
const appEnv = path.join(here, "..", "..", ".env");

const secret = (bytes = 24) => randomBytes(bytes).toString("hex");

const readEnv = (file: string): Record<string, string> =>
  existsSync(file)
    ? Object.fromEntries(
        readFileSync(file, "utf-8")
          .split("\n")
          .filter((line) => line.includes("=") && !line.startsWith("#"))
          .map((line) => {
            const index = line.indexOf("=");
            return [line.slice(0, index), line.slice(index + 1)];
          })
      )
    : {};

const append = (file: string, values: Record<string, string>) => {
  const existing = existsSync(file) ? readFileSync(file, "utf-8") : "";
  const lines = Object.entries(values)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  writeFileSync(
    file,
    `${existing}${existing === "" || existing.endsWith("\n") ? "" : "\n"}${lines}\n`
  );
};

if (!existsSync(nextcloudEnv)) {
  append(nextcloudEnv, {
    NEXTCLOUD_PORT: process.env.NEXTCLOUD_PORT ?? "8180",
    NEXTCLOUD_ADMIN_USER: "admin",
    NEXTCLOUD_ADMIN_PASSWORD: secret(12),
    POSTGRES_PASSWORD: secret(),
  });
  console.log(`Wrote ${path.relative(process.cwd(), nextcloudEnv)}`);
}

const nextcloud = readEnv(nextcloudEnv);
const url = `http://127.0.0.1:${nextcloud.NEXTCLOUD_PORT ?? "8180"}`;
const app = readEnv(appEnv);
const missing: Record<string, string> = {};
if (app.NEXTCLOUD_URL === undefined || app.NEXTCLOUD_URL === "") {
  missing.NEXTCLOUD_URL = url;
}
if (app.CONNECTOR_SECRET_KEY === undefined || app.CONNECTOR_SECRET_KEY === "") {
  missing.CONNECTOR_SECRET_KEY = randomBytes(32).toString("base64");
}
if (Object.keys(missing).length > 0) {
  append(appEnv, missing);
  console.log(
    `Added ${Object.keys(missing).join(" and ")} to ${path.relative(process.cwd(), appEnv)}`
  );
}
