import crypto from "node:crypto";

/**
 * Owner passphrase hashing for the remote connector's sign-in page.
 * Format: scrypt$<N>$<r>$<p>$<salt b64url>$<hash b64url>
 * Only the hash is configured on the server (YT_MCP_OWNER_PASSWORD_HASH).
 */

const N = 2 ** 15;
const R = 8;
const P = 1;
const KEYLEN = 32;
const MAXMEM = 64 * 1024 * 1024;

export function hashPassword(password: string): string {
  if (password.length < 12) throw new Error("Use a passphrase of at least 12 characters.");
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM });
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

export function isValidPasswordHash(encoded: string): boolean {
  const parts = encoded.split("$");
  return parts.length === 6 && parts[0] === "scrypt" && parts.slice(1, 4).every((x) => /^\d+$/.test(x));
}

export function verifyPassword(password: string, encoded: string): boolean {
  if (!isValidPasswordHash(encoded)) return false;
  const [, n, r, p, saltB64, hashB64] = encoded.split("$") as [string, string, string, string, string, string];
  const expected = Buffer.from(hashB64, "base64url");
  let actual: Buffer;
  try {
    actual = crypto.scryptSync(password, Buffer.from(saltB64, "base64url"), expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: MAXMEM,
    });
  } catch {
    return false;
  }
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}
