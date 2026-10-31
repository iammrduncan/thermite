import {
  type CipherGCM,
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  type DecipherGCM,
  type Hash,
  type Hmac,
  hkdfSync,
  randomBytes,
} from "node:crypto";

/**
 * The state snapshot's seal (snapshot.ts). A host's volume may ignore file permissions (RunPod's
 * does: a folder of mode 0700 keeps no user out), so the snapshot is sealed instead: every file
 * in it is encrypted and authenticated with AES-256-GCM, under keys derived from the snapshot key
 * that control mints for each pod at its launch (THERMITE_STATE_SNAPSHOT_KEY, 32 random bytes in
 * base64url). Only the broker, as root, ever holds the key: it takes it out of its environment
 * before it starts anything.
 *
 * - Three keys are derived with HKDF-SHA256, one for each purpose: file contents, file names and
 *   the manifest. A sealed file can't pass for a manifest, nor a manifest for a file.
 * - Each sealed file is `THMSEAL1`, its kind (`B` a file, `M` a manifest), a fresh 12-byte nonce,
 *   the ciphertext and the 16-byte tag. The magic and kind are the additional data.
 * - A file's sealed name is an HMAC-SHA256 of its content under the name key, in hexadecimal: it
 *   reveals nothing but which files are the same, and the same content is sealed once.
 */

/** The launch value that carries the snapshot key. */
export const SNAPSHOT_KEY_VAR = "THERMITE_STATE_SNAPSHOT_KEY";

export const SEAL_MAGIC = Buffer.from("THMSEAL1", "ascii");
export const SEAL_KIND = { file: 0x42, manifest: 0x4d } as const;
export type SealKind = keyof typeof SEAL_KIND;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
/** The magic, the kind and the nonce, before the ciphertext. */
export const SEAL_HEADER_BYTES = SEAL_MAGIC.length + 1 + NONCE_BYTES;
/** What sealing adds to a file's size: the header and the tag. */
export const SEAL_OVERHEAD = SEAL_HEADER_BYTES + TAG_BYTES;

/** A snapshot, or a file in it, that did not verify: it is refused whole. */
export class SnapshotRefused extends Error {}

export interface SnapshotKeys {
  /** Encrypts and authenticates each file's content. */
  file: Buffer;
  /** Names each sealed file: an HMAC of its content. */
  name: Buffer;
  /** Encrypts and authenticates the manifest. */
  manifest: Buffer;
}

/** The snapshot key from its launch value, or why there is none. */
export function parseSnapshotKey(raw: string | undefined): { key: Buffer } | { why: string } {
  const v = raw?.trim() ?? "";
  if (!v) return { why: `the launch gave no ${SNAPSHOT_KEY_VAR}` };
  if (!/^[A-Za-z0-9_-]{43}=?$/.test(v))
    return { why: `${SNAPSHOT_KEY_VAR} is not 32 bytes in base64url` };
  const key = Buffer.from(v, "base64url");
  if (key.length !== 32) return { why: `${SNAPSHOT_KEY_VAR} is not 32 bytes in base64url` };
  return { key };
}

/**
 * Reads the snapshot key and takes it out of `env` (the broker's own environment), so that no
 * process started after this has it.
 */
export function takeSnapshotKey(
  env: Record<string, string | undefined>,
): { key: Buffer } | { why: string } {
  const raw = env[SNAPSHOT_KEY_VAR];
  delete env[SNAPSHOT_KEY_VAR];
  return parseSnapshotKey(raw);
}

/** The keys for each purpose, derived from the snapshot key with HKDF-SHA256. */
export function deriveKeys(key: Buffer): SnapshotKeys {
  const salt = Buffer.from("thermite state snapshot", "ascii");
  const derive = (purpose: string) =>
    Buffer.from(hkdfSync("sha256", key, salt, `thermite state snapshot v1: ${purpose}`, 32));
  return {
    file: derive("file contents"),
    name: derive("file names"),
    manifest: derive("manifest"),
  };
}

const aad = (kind: SealKind) => Buffer.concat([SEAL_MAGIC, Buffer.of(SEAL_KIND[kind])]);

/** Seals a whole buffer (the manifest). */
export function seal(key: Buffer, kind: SealKind, plain: Buffer): Buffer {
  const nonce = randomBytes(NONCE_BYTES);
  const c = createCipheriv("aes-256-gcm", key, nonce);
  c.setAAD(aad(kind));
  const body = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([aad(kind), nonce, body, c.getAuthTag()]);
}

/** Opens a buffer `seal` made, or throws SnapshotRefused: another key, kind, or any change. */
export function unseal(key: Buffer, kind: SealKind, sealed: Buffer): Buffer {
  if (sealed.length < SEAL_OVERHEAD) throw new SnapshotRefused("it is too short to be sealed");
  if (!sealed.subarray(0, SEAL_MAGIC.length + 1).equals(aad(kind)))
    throw new SnapshotRefused(`it is not a sealed ${kind}`);
  const nonce = sealed.subarray(SEAL_MAGIC.length + 1, SEAL_HEADER_BYTES);
  const d = createDecipheriv("aes-256-gcm", key, nonce);
  d.setAAD(aad(kind));
  d.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
  try {
    return Buffer.concat([
      d.update(sealed.subarray(SEAL_HEADER_BYTES, sealed.length - TAG_BYTES)),
      d.final(),
    ]);
  } catch {
    throw new SnapshotRefused("it did not verify: another key, or it was changed");
  }
}

/** What sealing or opening a file found: its sealed name, its content's SHA-256 and size. */
export interface FileDigest {
  name: string;
  sha256: string;
  size: number;
}

/** Seals one file as it is read: the header first, then each chunk, then the tag. */
export class FileSealer {
  private readonly c: CipherGCM;
  private readonly mac: Hmac;
  private readonly hash: Hash = createHash("sha256");
  private size = 0;
  /** Written first. */
  readonly header: Buffer;

  constructor(keys: SnapshotKeys) {
    const nonce = randomBytes(NONCE_BYTES);
    this.c = createCipheriv("aes-256-gcm", keys.file, nonce);
    this.c.setAAD(aad("file"));
    this.mac = createHmac("sha256", keys.name);
    this.header = Buffer.concat([aad("file"), nonce]);
  }

  update(chunk: Buffer): Buffer {
    this.mac.update(chunk);
    this.hash.update(chunk);
    this.size += chunk.length;
    return this.c.update(chunk);
  }

  /** The last of the ciphertext and the tag, to write last, and the file's digest. */
  final(): { tail: Buffer; digest: FileDigest } {
    const tail = Buffer.concat([this.c.final(), this.c.getAuthTag()]);
    return {
      tail,
      digest: {
        name: this.mac.digest("hex"),
        sha256: this.hash.digest("hex"),
        size: this.size,
      },
    };
  }
}

/**
 * Opens one sealed file as it is read: given its header and its tag (its last 16 bytes) first,
 * then its ciphertext in chunks. What `update` gives back is not verified until `final`, which
 * throws SnapshotRefused when the file did not verify.
 */
export class FileOpener {
  private readonly d: DecipherGCM;
  private readonly mac: Hmac;
  private readonly hash: Hash = createHash("sha256");
  private size = 0;

  constructor(keys: SnapshotKeys, header: Buffer, tag: Buffer) {
    if (header.length !== SEAL_HEADER_BYTES || !header.subarray(0, 9).equals(aad("file")))
      throw new SnapshotRefused("it is not a sealed file");
    if (tag.length !== TAG_BYTES) throw new SnapshotRefused("its tag is cut short");
    this.d = createDecipheriv("aes-256-gcm", keys.file, header.subarray(9));
    this.d.setAAD(aad("file"));
    this.d.setAuthTag(tag);
    this.mac = createHmac("sha256", keys.name);
  }

  update(chunk: Buffer): Buffer {
    const plain = this.d.update(chunk);
    this.mac.update(plain);
    this.hash.update(plain);
    this.size += plain.length;
    return plain;
  }

  final(): { tail: Buffer; digest: FileDigest } {
    let tail: Buffer;
    try {
      tail = this.d.final();
    } catch {
      throw new SnapshotRefused("it did not verify: another key, or it was changed");
    }
    this.mac.update(tail);
    this.hash.update(tail);
    this.size += tail.length;
    return {
      tail,
      digest: { name: this.mac.digest("hex"), sha256: this.hash.digest("hex"), size: this.size },
    };
  }
}
