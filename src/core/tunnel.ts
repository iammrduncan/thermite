import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "./canonical.ts";
import { signJson, verifyJson } from "./commands.ts";
import { joinPath } from "./paths.ts";

/**
 * The tunnel between control and a rig in pull mode: a rig control connects to, through a public
 * proxy (a RunPod pod: docs/plan/goals/_completed/019-rig-only-entry.goal). The proxy ends TLS, so it could
 * read, change or replay what passes; these keep it to moving bytes.
 *
 * - Control signs every request with its command-signing key, in the format of signed commands
 *   (Ed25519 over canonical JSON): its method, path, rig, pod, time, nonce and the body's hash.
 * - The rig signs every answer, in the same format, over the request's nonce, its status and its
 *   body's hash, with a key it made at its first start.
 * - Bodies both ways are sealed to the other side's X25519 key (an ephemeral key, HKDF-SHA256,
 *   AES-256-GCM), so the proxy never sees a model key, a report or a command in plain text.
 * - Enrollment binds both sides to the launch's one-time code (HMAC-SHA256); the code never
 *   crosses the proxy.
 */

export const TUNNEL_VERSION = "thermite-tunnel-v1";
/** A request whose time is further than this from the rig's clock is refused. */
export const TUNNEL_SKEW_MS = 60_000;
/** Nonces are remembered at least this long, so a replay inside the window is refused. */
export const TUNNEL_NONCE_MS = 5 * 60_000;
/** The most a request from control may carry. A larger answer crosses in parts. */
export const TUNNEL_MAX_REQUEST = 1024 * 1024;
/** The port a rig in pull mode serves for control, when its launch names none. */
export const TUNNEL_PORT = 8790;

const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

export interface TunnelKeys {
  /** Ed25519, PEM: signs (the rig's answers). */
  signPrivatePem: string;
  signPublicPem: string;
  /** X25519, PEM: opens what is sealed to this side. */
  boxPrivatePem: string;
  boxPublicPem: string;
}

export function generateTunnelKeys(): TunnelKeys {
  const sign = generateKeyPairSync("ed25519");
  const box = generateBoxKeys();
  return {
    signPrivatePem: sign.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    signPublicPem: sign.publicKey.export({ type: "spki", format: "pem" }).toString(),
    ...box,
  };
}

/** An X25519 pair: control keeps one for each rig, to open what the rig seals to it. */
export function generateBoxKeys(): { boxPrivatePem: string; boxPublicPem: string } {
  const box = generateKeyPairSync("x25519");
  return {
    boxPrivatePem: box.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    boxPublicPem: box.publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

/** The SHA-256 of a public key (its DER form), hex: how a launch names control's key. */
export function keySha256(publicPem: string): string {
  return sha256(createPublicKey(publicPem).export({ type: "spki", format: "der" }));
}

/** A public key on one line (base64 of its DER form), for an environment variable. */
export const publicKeyLine = (pem: string) =>
  createPublicKey(pem).export({ type: "spki", format: "der" }).toString("base64");

/** A public key from its one-line form, as PEM. Throws when it is not a key. */
export const publicKeyFromLine = (line: string) =>
  createPublicKey({ key: Buffer.from(line, "base64"), format: "der", type: "spki" })
    .export({ type: "spki", format: "pem" })
    .toString();

/** What control signs for each request. */
export interface RequestHead {
  method: string;
  path: string;
  rig: string;
  pod: string;
  /** Milliseconds since the epoch. */
  at: number;
  /** 32 random bytes, hex. */
  nonce: string;
}

// Their `v` and `kind` keep them apart from every other thing these keys sign: a command's
// envelope has `v: 1` and a command kind, so neither can pass for one.
const requestFields = (h: RequestHead, body: Buffer) => ({
  v: TUNNEL_VERSION,
  kind: "tunnel_request",
  method: h.method,
  path: h.path,
  rig: h.rig,
  pod: h.pod,
  at: h.at,
  nonce: h.nonce,
  body_sha256: sha256(body),
});
const answerFields = (nonce: string, status: number, body: Buffer) => ({
  v: TUNNEL_VERSION,
  kind: "tunnel_answer",
  nonce,
  status,
  body_sha256: sha256(body),
});

export const newNonce = () => randomBytes(32).toString("hex");

/** Signs a request with control's command-signing key (base64). */
export function signRequest(h: RequestHead, body: Buffer, controlPrivatePem: string): string {
  return signJson(requestFields(h, body), controlPrivatePem);
}

export function verifyRequest(
  h: RequestHead,
  body: Buffer,
  signature: string,
  controlPublicPem: string,
): boolean {
  return verifyJson(requestFields(h, body), signature, controlPublicPem);
}

export function signAnswer(nonce: string, status: number, body: Buffer, pem: string): string {
  return signJson(answerFields(nonce, status, body), pem);
}

export function verifyAnswer(
  nonce: string,
  status: number,
  body: Buffer,
  signature: string,
  signPublicPem: string,
): boolean {
  return verifyJson(answerFields(nonce, status, body), signature, signPublicPem);
}

/** The raw 32 bytes of an X25519 public key (the last 32 of its SPKI DER). */
const rawX25519 = (pem: string) =>
  createPublicKey(pem).export({ type: "spki", format: "der" }).subarray(-32);

/** What the tunnel's sealed bodies are bound to: a body sealed for another use never opens here. */
const TUNNEL_SEAL_LABEL = `${TUNNEL_VERSION} seal`;

/**
 * Seals bytes to a recipient's X25519 public key: a fresh key for each message, so only the
 * recipient's private key opens it. Out: ephemeral public (32) | iv (12) | tag (16) | ciphertext.
 * `label` binds it to its use: `open` needs the same label, so a body sealed for one use can't
 * pass for another's (the tunnel's own by default; the message bus's config has its own).
 */
export function seal(
  plain: Buffer,
  recipientBoxPublicPem: string,
  label: string = TUNNEL_SEAL_LABEL,
): Buffer {
  const eph = generateKeyPairSync("x25519");
  const shared = diffieHellman({
    privateKey: eph.privateKey,
    publicKey: createPublicKey(recipientBoxPublicPem),
  });
  const ephRaw = eph.publicKey.export({ type: "spki", format: "der" }).subarray(-32);
  const key = Buffer.from(
    hkdfSync(
      "sha256",
      shared,
      Buffer.concat([ephRaw, rawX25519(recipientBoxPublicPem)]),
      label,
      32,
    ),
  );
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([ephRaw, iv, cipher.getAuthTag(), ct]);
}

/**
 * Opens what `seal` made for this key, with the same label. Throws when it was changed, or meant
 * for another key or another use.
 */
export function open(
  sealed: Buffer,
  boxPrivatePem: string,
  label: string = TUNNEL_SEAL_LABEL,
): Buffer {
  if (sealed.length < 60) throw new Error("sealed data is too short");
  const priv = createPrivateKey(boxPrivatePem);
  const ownRaw = createPublicKey(priv).export({ type: "spki", format: "der" }).subarray(-32);
  const ephRaw = sealed.subarray(0, 32);
  // SPKI DER of an X25519 public key: a fixed 12-byte prefix, then the 32 raw bytes.
  const ephDer = Buffer.concat([Buffer.from("302a300506032b656e032100", "hex"), ephRaw]);
  const shared = diffieHellman({
    privateKey: priv,
    publicKey: createPublicKey({ key: ephDer, format: "der", type: "spki" }),
  });
  const key = Buffer.from(hkdfSync("sha256", shared, Buffer.concat([ephRaw, ownRaw]), label, 32));
  const decipher = createDecipheriv("aes-256-gcm", key, sealed.subarray(32, 44));
  decipher.setAuthTag(sealed.subarray(44, 60));
  return Buffer.concat([decipher.update(sealed.subarray(60)), decipher.final()]);
}

const hmac = (code: string, value: unknown) =>
  createHmac("sha256", code).update(canonicalJson(value)).digest("hex");

/**
 * Control's proof, in its enrollment request, that it holds the launch's code: bound to the rig,
 * the pod and the request's nonce, so it is good for that one request only.
 */
export function controlCodeProof(code: string, rig: string, pod: string, nonce: string): string {
  return hmac(code, { v: TUNNEL_VERSION, kind: "enroll_request", rig, pod, nonce });
}

/** The pod's proof: its public keys, bound to the launch's code. */
export function enrollmentProof(code: string, signPublicPem: string, boxPublicPem: string): string {
  return hmac(code, {
    v: TUNNEL_VERSION,
    kind: "enroll_answer",
    sign: signPublicPem,
    box: boxPublicPem,
  });
}

export function sameHex(a: string, b: string): boolean {
  if (!/^[0-9a-f]*$/.test(a) || !/^[0-9a-f]*$/.test(b)) return false;
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

/**
 * The harness settings control may give a rig at enrollment: the rig's target and GPUs, its
 * workers and trials, and its promotion policy. Nothing secret and no path, so a launch's settings
 * can only say what the rig's environment could.
 */
export const POD_CONFIG_ENV = [
  "THERMITE_TARGET",
  "THERMITE_TARGET_CLASS",
  "THERMITE_GPUS",
  "THERMITE_GPU_INDEX",
  "THERMITE_DEV_GPU_INDEX",
  "THERMITE_JUDGE_GPUS",
  "THERMITE_MAX_TRIALS",
  "THERMITE_TRIAL_MINUTES",
  "THERMITE_PROMOTION",
] as const;

/** A value a shell can take as it is: letters, digits and `. _ , : -`. */
export const POD_CONFIG_VALUE = /^[A-Za-z0-9._,:-]{1,100}$/;
const SafeValue = z.string().regex(POD_CONFIG_VALUE, "letters, digits and . _ , : -");

/** The rig's settings, as control signs them in its enrollment request. */
export const PodConfig = z.strictObject({
  env: z.partialRecord(z.enum(POD_CONFIG_ENV), SafeValue).default({}),
});
export type PodConfig = z.infer<typeof PodConfig>;

/** What control's enrollment request carries (signed, in plain text: nothing in it is secret). */
export const EnrollRequest = z.strictObject({
  /** Control's command-signing public key: its SHA-256 must be the one the launch named. */
  control_key: z.string().min(1).max(4000),
  /** controlCodeProof for this request. */
  code_proof: z.string().regex(/^[0-9a-f]{64}$/),
  config: PodConfig,
});
export type EnrollRequest = z.infer<typeof EnrollRequest>;

/** The pod's enrollment answer: its public keys, bound to the code. */
export const EnrollAnswer = z.strictObject({
  sign: z.string().min(1).max(4000),
  box: z.string().min(1).max(4000),
  proof: z.string().regex(/^[0-9a-f]{64}$/),
});
export type EnrollAnswer = z.infer<typeof EnrollAnswer>;

/** Control's side of an exchange (sealed to the pod): answers to the rig's calls, in pieces. */
export const ExchangeIn = z.object({
  answers: z
    .array(
      z.object({
        id: z.string().min(1).max(64),
        status: z.number().int().min(100).max(599),
        headers: z.record(z.string(), z.string().max(200)).optional(),
        body: z.string(),
        part: z.number().int().min(0).optional(),
        parts: z.number().int().min(1).optional(),
      }),
    )
    .default([]),
  wait_ms: z.number().min(0).optional(),
});
export type ExchangeIn = z.infer<typeof ExchangeIn>;

/** The pod's side of an exchange (sealed to control): the rig's calls, and what it refused. */
export const ExchangeOut = z.object({
  requests: z
    .array(
      z.object({
        id: z.string().min(1).max(64),
        method: z.string().min(1).max(10),
        path: z.string().min(1).max(4000),
        headers: z.record(z.string(), z.string().max(1000)).optional(),
        body: z.string(),
      }),
    )
    .max(64)
    .default([]),
  refused: z.number().int().min(0).default(0),
});
export type ExchangeOut = z.infer<typeof ExchangeOut>;

/**
 * What a pod launched in pull mode gets in its environment: public material, the one-time code
 * and the key its state snapshot is sealed with. Control's own command-signing key is named by
 * its SHA-256 and arrives at enrollment; the pod's ID comes from RunPod (RUNPOD_POD_ID).
 */
export interface PodLaunchEnv {
  /**
   * 32 random bytes in base64url, new for each launch, that seal the pod's state snapshot on its
   * volume (src/harness/broker/seal.ts). Control keeps no copy: the pod's settings at RunPod
   * hold it, as they hold the code, and a stopped pod keeps them. The pod's broker takes it out
   * of its environment at start, so only root has it.
   */
  THERMITE_STATE_SNAPSHOT_KEY: string;
  THERMITE_RIG_ID: string;
  THERMITE_TUNNEL_PORT: string;
  THERMITE_TUNNEL_PREFIX: string;
  THERMITE_TUNNEL_CONTROL_KEY_SHA256: string;
  /** This rig's X25519 key at control, on one line (publicKeyLine). */
  THERMITE_TUNNEL_CONTROL_BOX: string;
  THERMITE_TUNNEL_ENROLL_CODE: string;
  /** Only when the owner set an expiry for the code: an ISO time. */
  THERMITE_TUNNEL_ENROLL_UNTIL?: string;
}

/**
 * The files enrollment leaves on the pod, all public, each written whole: `rig.json`, then
 * `rig.env`, then `control.pub`, so once `control.pub` is there the other two are complete.
 */
export const ENROLLED_FILES = {
  /**
   * Control's command-signing public key. In the one-container rig image, root checks it against
   * the launch's SHA-256 and gives the harness a copy of its own (src/harness/broker/).
   */
  controlKey: "control.pub",
  /** The rig and its settings from control, as JSON. */
  rig: "rig.json",
  /** The rig's ID and its settings, as `NAME=value` lines whose values a shell takes as they are. */
  env: "rig.env",
} as const;

/**
 * A pod's folders in pull mode: its private state (its keys, its enrollment, the nonces it has
 * seen), and the folder enrollment leaves its public files in. Both are in the supervisor's home
 * unless set.
 */
export function podTunnelDirs(
  env: Record<string, string | undefined>,
  home: string,
): { dir: string; enrolledDir: string } {
  return {
    dir: env.THERMITE_TUNNEL_DIR || joinPath(home, "tunnel"),
    enrolledDir: env.THERMITE_TUNNEL_ENROLLED_DIR || joinPath(home, "enrolled"),
  };
}
