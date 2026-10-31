import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Seals the secrets the owner gives control (a model route's API key) for its store: AES-256-GCM
 * with a 32-byte key kept outside the database. A copy of the database alone reveals no key; a
 * sealed value that was changed fails to open. Values are "s1:" + base64(iv | tag | ciphertext).
 */
export class SecretBox {
  private readonly key: Buffer;

  private constructor(key: Buffer) {
    if (key.length !== 32) throw new Error("a secret box needs a 32-byte key");
    this.key = key;
  }

  /** A box with a fresh key that lives only in memory (tests, local development). */
  static ephemeral(): SecretBox {
    return new SecretBox(randomBytes(32));
  }

  /**
   * The box whose key is in this file, made with mode 0600 when it does not exist yet. Mount it
   * from a separate secret to keep it off the database's volume.
   */
  static fromFile(path: string): SecretBox {
    if (!existsSync(path)) {
      mkdirSync(dirname(path), { recursive: true });
      // "wx": never overwrite a key another process made meanwhile.
      try {
        writeFileSync(path, randomBytes(32).toString("base64"), { mode: 0o600, flag: "wx" });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
    }
    const key = Buffer.from(readFileSync(path, "utf8").trim(), "base64");
    if (key.length !== 32) throw new Error(`${path} does not hold a 32-byte base64 key`);
    return new SecretBox(key);
  }

  seal(plain: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key, iv);
    const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
    return `s1:${Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64")}`;
  }

  /**
   * A digest of `text` that only this box's key makes (HMAC-SHA256 with a key drawn from it), in
   * hex: it changes when the text does, and tells nothing of the text to anyone without the key.
   * A rig's config value on the message bus carries one as its revision.
   */
  digest(text: string): string {
    const key = Buffer.from(hkdfSync("sha256", this.key, Buffer.alloc(0), "thermite digest", 32));
    return createHmac("sha256", key).update(text, "utf8").digest("hex").slice(0, 32);
  }

  open(sealed: string): string {
    if (!sealed.startsWith("s1:")) throw new Error("not a sealed value");
    const raw = Buffer.from(sealed.slice(3), "base64");
    if (raw.length < 28) throw new Error("a sealed value too short");
    const d = createDecipheriv("aes-256-gcm", this.key, raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
  }
}

/** What the dashboard may show of a key: its last four characters, never more. */
export const keyHint = (key: string) => (key.length > 8 ? `…${key.slice(-4)}` : "…");
