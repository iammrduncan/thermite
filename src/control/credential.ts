import { createHash, timingSafeEqual } from "node:crypto";

/**
 * A credential control checks without holding it: only the token's SHA-256 is kept. The owner
 * mints a token (`thermite token new`), keeps it, and deploys control with its hash, so whoever
 * runs control's machine never holds anything that signs in as the owner.
 */
export class Credential {
  readonly sha256: Buffer;

  private constructor(sha256: Buffer) {
    this.sha256 = sha256;
  }

  static ofToken(token: string): Credential {
    if (!token) throw new Error("an empty token");
    return new Credential(createHash("sha256").update(token).digest());
  }

  static ofHash(hex: string): Credential {
    const h = hex.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(h)) throw new Error("a token hash is 64 hexadecimal characters");
    return new Credential(Buffer.from(h, "hex"));
  }

  /** A token or a credential, as callers give them. */
  static from(value: string | Credential): Credential {
    return value instanceof Credential ? value : Credential.ofToken(value);
  }

  matches(token: string): boolean {
    if (!token) return false;
    return timingSafeEqual(createHash("sha256").update(token).digest(), this.sha256);
  }

  same(other: Credential): boolean {
    return timingSafeEqual(this.sha256, other.sha256);
  }

  get hex(): string {
    return this.sha256.toString("hex");
  }
}

// A new token, as control and the command line make one (common/secrets.ts).
export { newToken } from "../common/secrets.ts";
