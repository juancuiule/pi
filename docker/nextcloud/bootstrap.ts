// After `docker compose up`: waits until the local Nextcloud has installed itself, enables the Calendar and Contacts
// apps (their web pages; CalDAV and CardDAV work without them), and creates an app password for the admin, kept in
// docker/nextcloud/.env (NEXTCLOUD_ADMIN_APP_PASSWORD) for the integration test and printed for Settings →
// Connections. NEXTCLOUD_PROJECT names the compose project, `nextcloud` by default.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const here = import.meta.dirname;
const nextcloudEnv = path.join(here, ".env");
const project = process.env.NEXTCLOUD_PROJECT ?? "nextcloud";

const readEnv = (): Record<string, string> =>
  Object.fromEntries(
    readFileSync(nextcloudEnv, "utf-8")
      .split("\n")
      .filter((line) => line.includes("=") && !line.startsWith("#"))
      .map((line) => {
        const index = line.indexOf("=");
        return [line.slice(0, index), line.slice(index + 1)];
      })
  );

const occ = (...args: string[]): string =>
  execFileSync(
    "docker",
    [
      "compose",
      "-f",
      path.join(here, "docker-compose.yml"),
      "-p",
      project,
      "exec",
      "-T",
      "-u",
      "www-data",
      "app",
      "php",
      "occ",
      ...args,
    ],
    { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }
  );

const installed = (): boolean => {
  try {
    return (
      (JSON.parse(occ("status", "--output=json")) as { installed?: boolean })
        .installed === true
    );
  } catch {
    return false;
  }
};

if (!existsSync(nextcloudEnv)) {
  throw new Error("Run docker/nextcloud/init-env.ts first (pnpm nextcloud:up)");
}
const env = readEnv();
const admin = env.NEXTCLOUD_ADMIN_USER ?? "admin";
const url = `http://127.0.0.1:${env.NEXTCLOUD_PORT ?? "8180"}`;

// The first start copies Nextcloud into its volume and installs it: a minute or two.
const deadline = Date.now() + 5 * 60 * 1000;
process.stdout.write("Waiting for Nextcloud to install");
while (!installed()) {
  if (Date.now() > deadline) {
    throw new Error("\nNextcloud did not finish installing in 5 minutes");
  }
  process.stdout.write(".");
  // oxlint-disable-next-line no-await-in-loop -- polling, one check at a time
  await sleep(3000);
}
console.log(" done");

for (const app of ["calendar", "contacts"]) {
  try {
    occ("app:install", app);
    console.log(`Installed the ${app} app`);
  } catch {
    // Already installed, or the app store is unreachable: CalDAV/CardDAV work without the app's pages.
    try {
      occ("app:enable", app);
    } catch {
      console.log(
        `Could not install the ${app} app (offline?); its DAV API works anyway`
      );
    }
  }
}

if (env.NEXTCLOUD_ADMIN_APP_PASSWORD === undefined) {
  // `user:auth-tokens:add` prints the new app password on its last line.
  const output = occ("user:auth-tokens:add", "--name=effect-pi", admin).trim();
  const appPassword = output.split(/\s+/u).at(-1) ?? "";
  writeFileSync(
    nextcloudEnv,
    `${readFileSync(nextcloudEnv, "utf-8")}NEXTCLOUD_ADMIN_APP_PASSWORD=${appPassword}\n`
  );
}

const final = readEnv();
console.log(`Nextcloud: ${url}`);
console.log(
  `  admin login: ${admin} / ${final.NEXTCLOUD_ADMIN_PASSWORD ?? ""}`
);
console.log(
  `  app password for Settings → Connections: ${final.NEXTCLOUD_ADMIN_APP_PASSWORD ?? ""}`
);
