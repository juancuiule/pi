// The credential vault: secrets sealed per owner and connector, unreadable under another key, and the key's format.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { alice, bob } from "../testing/users.ts";
import {
  generateSecretKey,
  open,
  parseSecretKey,
  seal,
  sqliteVault,
} from "./vault.ts";

const account = { id: "alice", login: "alice", displayName: "Alice" };

describe("the credential vault", () => {
  it("opens a sealed secret only for its owner and connector", () => {
    const key = parseSecretKey(generateSecretKey());
    const sealed = seal(key, alice.id, "nextcloud", "app-password");
    expect(sealed).not.toContain("app-password");
    expect(open(key, alice.id, "nextcloud", sealed)).toBe("app-password");
    expect(open(key, bob.id, "nextcloud", sealed)).toBeUndefined();
    expect(open(key, alice.id, "openproject", sealed)).toBeUndefined();
    const other = parseSecretKey(generateSecretKey());
    expect(open(other, alice.id, "nextcloud", sealed)).toBeUndefined();
  });

  it("stores credentials per owner, and reports them unreadable under a new key", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "vault-"));
    const file = path.join(dir, "db.sqlite");
    const vault = sqliteVault(file, parseSecretKey(generateSecretKey()));
    vault.put(alice.id, "nextcloud", { account, secret: "s3cret" }, 1);
    expect(vault.get(alice.id, "nextcloud")).toStrictEqual({
      account,
      secret: "s3cret",
      connectedAt: 1,
    });
    expect(vault.get(bob.id, "nextcloud")).toBeUndefined();
    vault.close();
    const rekeyed = sqliteVault(file, parseSecretKey(generateSecretKey()));
    expect(rekeyed.get(alice.id, "nextcloud")).toStrictEqual({
      account,
      connectedAt: 1,
      unreadable: true,
    });
    expect(rekeyed.remove(alice.id, "nextcloud")).toBeTruthy();
    expect(rekeyed.all(alice.id).size).toBe(0);
    rekeyed.close();
    rmSync(dir, { recursive: true });
  });

  it("refuses a key that is not 32 bytes of base64", () => {
    expect(() => parseSecretKey("short")).toThrow("CONNECTOR_SECRET_KEY");
    expect(() => parseSecretKey(Buffer.alloc(16).toString("base64"))).toThrow(
      "CONNECTOR_SECRET_KEY"
    );
  });
});
