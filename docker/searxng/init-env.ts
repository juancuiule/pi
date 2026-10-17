// Writes the secret for the local SearXNG (docker/searxng/.env) and its URL for the app (SEARXNG_URL in .env at the
// repository root), once. Later runs keep the existing files.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const here = import.meta.dirname;
const searxngEnv = path.join(here, ".env");
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

if (!existsSync(searxngEnv)) {
  writeFileSync(
    searxngEnv,
    `SEARXNG_SECRET=${randomBytes(24).toString("hex")}\n`
  );
  console.log(`Wrote ${path.relative(process.cwd(), searxngEnv)}`);
}

const appValues = existsSync(appEnv) ? readEnv(appEnv) : {};
if (appValues.SEARXNG_URL === undefined) {
  const existing = existsSync(appEnv) ? readFileSync(appEnv, "utf-8") : "";
  writeFileSync(
    appEnv,
    `${existing}${existing === "" || existing.endsWith("\n") ? "" : "\n"}SEARXNG_URL=http://127.0.0.1:8081\n`
  );
  console.log(`Added SEARXNG_URL to ${path.relative(process.cwd(), appEnv)}`);
}

console.log("SearXNG: http://127.0.0.1:8081");
