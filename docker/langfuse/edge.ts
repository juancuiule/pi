// Serves the local Langfuse under the edge's /_/langfuse/ (edge.yml, docs/deploy/services.md), or back at the root
// of http://localhost:3000 with `off`. It edits three lines, then `pnpm langfuse:up` applies them (building the web
// image the first time):
// - COMPOSE_FILE in docker/langfuse/.env layers edge.yml, which builds the web image with the base path;
// - NEXTAUTH_URL there is the URL people sign in through, base path and /api/auth included;
// - LANGFUSE_BASE_URL in the root .env follows the base path, still straight to port 3000 (traces skip the edge).
// Usage: pnpm langfuse:edge https://pi.example.com   |   pnpm langfuse:edge off
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const BASE_PATH = "/_/langfuse";
const here = import.meta.dirname;
const langfuseEnv = path.join(here, ".env");
const appEnv = path.join(here, "..", "..", ".env");

/** `file` with `key` set to `value` (replacing its line, or appended), or removed when `value` is undefined. */
const setLine = (file: string, key: string, value: string | undefined) => {
  const lines = (existsSync(file) ? readFileSync(file, "utf-8") : "")
    .split("\n")
    .filter((line, index, all) => line !== "" || index < all.length - 1);
  const at = lines.findIndex((line) => line.startsWith(`${key}=`));
  if (value === undefined) {
    if (at !== -1) {
      lines.splice(at, 1);
    }
  } else if (at === -1) {
    lines.push(`${key}=${value}`);
  } else {
    lines[at] = `${key}=${value}`;
  }
  writeFileSync(file, `${lines.join("\n")}\n`);
};

const [arg] = process.argv.slice(2);
if (arg === undefined) {
  console.error(
    "usage: pnpm langfuse:edge <the PUBLIC_URL people sign in to Langfuse through> | off"
  );
  process.exit(1);
}
if (!existsSync(langfuseEnv)) {
  console.error("docker/langfuse/.env is missing: run pnpm langfuse:up once");
  process.exit(1);
}

if (arg === "off") {
  setLine(langfuseEnv, "COMPOSE_FILE", undefined);
  setLine(langfuseEnv, "NEXTAUTH_URL", undefined);
  setLine(appEnv, "LANGFUSE_BASE_URL", "http://localhost:3000");
  console.log(
    "Langfuse back at http://localhost:3000: run pnpm langfuse:up, then restart the server"
  );
} else {
  const url = new URL(arg);
  if (url.pathname !== "/" || url.search !== "") {
    console.error(
      `${arg}: give the site's origin only, like https://pi.example.com`
    );
    process.exit(1);
  }
  setLine(langfuseEnv, "COMPOSE_FILE", "docker-compose.yml:edge.yml");
  setLine(langfuseEnv, "NEXTAUTH_URL", `${url.origin}${BASE_PATH}/api/auth`);
  setLine(appEnv, "LANGFUSE_BASE_URL", `http://localhost:3000${BASE_PATH}`);
  console.log(
    `Langfuse at ${url.origin}${BASE_PATH}/: run pnpm langfuse:up (the first one builds the web image, which takes a while), add langfuse to EDGE_SERVICES, then restart the server`
  );
}
