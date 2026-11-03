// The Nextcloud client against the real local instance (`pnpm nextcloud:up`), signed in with the admin's app password
// that bootstrap.ts keeps in docker/nextcloud/.env: every protocol the tools use, then the credential steps.
// `pnpm test:integration`; skipped when the instance was never bootstrapped.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { buildEvent } from "./calendar.ts";
import {
  exchangeAppPassword,
  fetchAccount,
  nextcloudClient,
  revokeAppPassword,
  startLoginFlow,
} from "./client.ts";
import { buildContact } from "./contacts.ts";

const envFile = path.join(
  import.meta.dirname,
  "..",
  "..",
  "docker",
  "nextcloud",
  ".env"
);
const env: Record<string, string> = existsSync(envFile)
  ? Object.fromEntries(
      readFileSync(envFile, "utf-8")
        .split("\n")
        .filter((line) => line.includes("="))
        .map((line) => [
          line.slice(0, line.indexOf("=")),
          line.slice(line.indexOf("=") + 1),
        ])
    )
  : {};
const login = env.NEXTCLOUD_ADMIN_USER ?? "admin";
const appPassword = env.NEXTCLOUD_ADMIN_APP_PASSWORD;
const options = {
  url:
    process.env.NEXTCLOUD_URL ??
    `http://127.0.0.1:${env.NEXTCLOUD_PORT ?? "8180"}`,
};
const skip = appPassword === undefined;

const client = async () => {
  const account = await fetchAccount(options, login, appPassword as string);
  return nextcloudClient(options, {
    account: { ...account, login },
    secret: appPassword as string,
  });
};

describe.skipIf(skip)("Nextcloud against the local instance", () => {
  const run = `effect-pi-${Date.now()}`;

  it("writes, lists, reads, searches and moves files", async () => {
    const nc = await client();
    await nc.files.mkdir(`/${run}`);
    await expect(
      nc.files.write(`/${run}/notes ü.md`, "# hello", false)
    ).resolves.toBe("created");
    await expect(
      nc.files.write(`/${run}/notes ü.md`, "again", false)
    ).rejects.toThrow("already exists");
    const { entries } = await nc.files.list(`/${run}`);
    expect(entries.map((entry) => entry.path)).toStrictEqual([
      `/${run}/notes ü.md`,
    ]);
    const read = await nc.files.read(`/${run}/notes ü.md`);
    expect(Buffer.from(read.bytes).toString("utf-8")).toBe("# hello");
    const found = await nc.files.search("notes ü", `/${run}`, 10);
    expect(found.map((entry) => entry.path)).toContain(`/${run}/notes ü.md`);
    await nc.files.move(`/${run}/notes ü.md`, `/${run}/moved.md`, {
      copy: false,
      overwrite: false,
    });
  });

  it("shares a file by link and stops the share", async () => {
    const nc = await client();
    const share = await nc.createShare({
      path: `/${run}/moved.md`,
      type: "link",
      permissions: 1,
    });
    expect(share.url).toContain("/s/");
    const shares = await nc.shares(`/${run}/moved.md`);
    expect(shares.map((s) => s.id)).toContain(share.id);
    await nc.deleteShare(share.id);
    await nc.files.remove(`/${run}`);
  });

  it("creates, lists and deletes an event", async () => {
    const nc = await client();
    const calendars = await nc.calendars();
    const calendar = (
      calendars.find((c) => c.id === "personal") ?? calendars[0]
    )?.id;
    expect(calendar).toBeDefined();
    const event = buildEvent({
      summary: run,
      start: "2026-11-05T10:00:00-03:00",
      end: "2026-11-05T11:00:00-03:00",
    });
    if ("error" in event) {
      throw new Error(event.error);
    }
    await nc.createEvent(calendar ?? "", event.uid, event.ics);
    const events = await nc.events(
      [calendar ?? ""],
      new Date("2026-11-01T00:00:00Z"),
      new Date("2026-11-30T00:00:00Z")
    );
    expect(events.find((e) => e.uid === event.uid)?.start).toBe(
      "2026-11-05T13:00:00Z"
    );
    await expect(
      nc.deleteEvent(calendar ?? "", event.uid)
    ).resolves.toBeTruthy();
  });

  it("adds and finds a contact", async () => {
    const nc = await client();
    const books = await nc.addressBooks();
    const book = (books.find((b) => b.id === "contacts") ?? books[0])?.id;
    const contact = buildContact({
      name: `Ada ${run}`,
      emails: ["ada@example.com"],
    });
    await nc.createContact(book ?? "", contact.uid, contact.vcf);
    const contacts = await nc.contacts([book ?? ""], run, 10);
    expect(contacts.map((c) => c.uid)).toContain(contact.uid);
  });

  it("exchanges the admin's password for an app password and revokes it", async () => {
    const exchanged = await exchangeAppPassword(
      options,
      login,
      env.NEXTCLOUD_ADMIN_PASSWORD as string
    );
    expect(exchanged).toBeTypeOf("string");
    // An app password is not exchanged again.
    await expect(
      exchangeAppPassword(options, login, exchanged as string)
    ).resolves.toBeUndefined();
    const account = await fetchAccount(options, login, exchanged as string);
    await revokeAppPassword(options, {
      account: { ...account, login },
      secret: exchanged as string,
    });
    await expect(
      fetchAccount(options, login, exchanged as string)
    ).rejects.toThrow("refused");
  });

  it("starts a login flow", async () => {
    const flow = await startLoginFlow(options);
    expect(flow.loginUrl).toContain("/login/v2/flow/");
  });
});
