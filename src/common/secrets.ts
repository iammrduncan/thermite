import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Whether two secrets, such as tokens, are the same, compared in constant time. Each side is
 * hashed first, so the compare takes as long whatever the lengths are.
 */
export function sameSecret(a: string, b: string): boolean {
  const digest = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(digest(a), digest(b));
}

/** A new token: 32 random bytes, base64url, with its SHA-256 for control's configuration. */
export function newToken(): { token: string; sha256: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, sha256: createHash("sha256").update(token).digest("hex") };
}
