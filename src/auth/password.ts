// Password hashes: scrypt from node:crypto with a random salt per hash, stored as one self-describing string
// (`scrypt$N$r$p$salt$key`, base64url) so the cost can rise later without breaking stored hashes.
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const N = 2 ** 15;
const R = 8;
const P = 1;
const KEY_BYTES = 32;
// scrypt needs 128·N·r bytes; Node's default cap (32 MiB) is exactly that at N=2^15, so leave headroom.
const MAX_MEM = 64 * 1024 * 1024;

const derive = (
  password: string,
  salt: Buffer,
  cost: { readonly n: number; readonly r: number; readonly p: number }
) =>
  // oxlint-disable-next-line promise/avoid-new -- node:crypto's scrypt has no promise form, and promisify loses its options overload
  new Promise<Buffer>((resolve, reject) => {
    scrypt(
      password.normalize("NFC"),
      salt,
      KEY_BYTES,
      { N: cost.n, r: cost.r, p: cost.p, maxmem: MAX_MEM },
      // oxlint-disable-next-line promise/prefer-await-to-callbacks -- see above
      (error, key) => (error === null ? resolve(key) : reject(error))
    );
  });

export const hashPassword = async (password: string): Promise<string> => {
  const salt = randomBytes(16);
  const key = await derive(password, salt, { n: N, r: R, p: P });
  return [
    "scrypt",
    N,
    R,
    P,
    salt.toString("base64url"),
    key.toString("base64url"),
  ].join("$");
};

/** Whether `password` matches `stored`; a malformed hash never matches. */
export const verifyPassword = async (
  password: string,
  stored: string
): Promise<boolean> => {
  const [scheme, n, r, p, salt, key] = stored.split("$");
  if (
    scheme !== "scrypt" ||
    n === undefined ||
    r === undefined ||
    p === undefined ||
    salt === undefined ||
    key === undefined
  ) {
    return false;
  }
  const expected = Buffer.from(key, "base64url");
  const actual = await derive(password, Buffer.from(salt, "base64url"), {
    n: Number(n),
    r: Number(r),
    p: Number(p),
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
};

let decoy: Promise<string> | undefined;

/** A hash of a password nobody knows, so a sign-in with an unknown name costs as much as a wrong password. */
export const decoyHash = (): Promise<string> => {
  decoy ??= hashPassword(randomBytes(16).toString("hex"));
  return decoy;
};
