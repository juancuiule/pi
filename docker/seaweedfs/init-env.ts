// Writes the S3 credentials for the local SeaweedFS: docker/seaweedfs/.env holds them, s3.json is the identity
// file the gateway's -s3.config flag reads, and the root .env gets the same keys so the app signs requests
// (plus S3_ENDPOINT). Everything is written once; later runs keep the existing files, so the keys stay valid
// across restarts. Without credentials the gateway allows every request, so they are always set.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const here = import.meta.dirname;
const seaweedEnv = path.join(here, ".env");
const s3Config = path.join(here, "s3.json");
const appEnv = path.join(here, "..", "..", ".env");

// S3 access keys are conventionally [A-Z0-9]{20}; the secret only needs to be unguessable.
const accessKey = () => randomBytes(10).toString("hex").toUpperCase();
const secretKey = () => randomBytes(30).toString("base64");
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

if (!existsSync(seaweedEnv)) {
  writeFileSync(
    seaweedEnv,
    lines({
      S3_ACCESS_KEY_ID: accessKey(),
      S3_SECRET_ACCESS_KEY: secretKey(),
    })
  );
  console.log(`Wrote ${path.relative(process.cwd(), seaweedEnv)}`);
}

const seaweed = readEnv(seaweedEnv);

if (!existsSync(s3Config)) {
  writeFileSync(
    s3Config,
    `${JSON.stringify(
      {
        identities: [
          {
            name: "admin",
            credentials: [
              {
                accessKey: seaweed.S3_ACCESS_KEY_ID,
                secretKey: seaweed.S3_SECRET_ACCESS_KEY,
              },
            ],
            actions: ["Admin", "Read", "Write"],
          },
        ],
      },
      null,
      2
    )}\n`
  );
  console.log(`Wrote ${path.relative(process.cwd(), s3Config)}`);
}

const appValues = existsSync(appEnv) ? readEnv(appEnv) : {};
if (appValues.S3_ACCESS_KEY_ID === undefined) {
  const existing = existsSync(appEnv) ? readFileSync(appEnv, "utf-8") : "";
  writeFileSync(
    appEnv,
    `${existing}${existing === "" || existing.endsWith("\n") ? "" : "\n"}${lines(
      {
        S3_ENDPOINT: "http://127.0.0.1:8333",
        S3_ACCESS_KEY_ID: seaweed.S3_ACCESS_KEY_ID ?? "",
        S3_SECRET_ACCESS_KEY: seaweed.S3_SECRET_ACCESS_KEY ?? "",
      }
    )}`
  );
  console.log(`Added the S3 keys to ${path.relative(process.cwd(), appEnv)}`);
}

console.log("SeaweedFS S3: http://127.0.0.1:8333");
