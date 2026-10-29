import { createPublicKey } from "node:crypto";
import type { ConsumerConfig, StreamConfig } from "@nats-io/jetstream";
import { z } from "zod";
import { ADVISOR_ROUTES, MCP_SERVERS, MODEL_ROUTE } from "../api/control/rigs.ts";
import { sha256Hex } from "../canonical.ts";
import { RIG_ID } from "../ids.ts";
import { generateBoxKeys, open, publicKeyFromLine, publicKeyLine, seal } from "../tunnel.ts";

/**
 * The link's fourth contract (goal 168, step 3): each rig's configuration on the message bus, a
 * key-value bucket. Control writes what a rig's supervisor once polled it for, one key for each
 * kind, so that a change to one rewrites only it: the agents' model route (`model-route`), the
 * advisors' routes (`advisor-routes`) and the MCP servers with their sign-ins (`mcp-servers`).
 * The bucket keeps the latest value of each key; control's store is the truth, and control writes
 * a key only when its value changes.
 *
 * Each value is sealed whole to the rig's own seal key: an X25519 key the supervisor makes beside
 * its key on the bus and registers with it (the bus key is an Ed25519 key, which signs and can't
 * be sealed to). The seal is the tunnel's (core/tunnel.ts: a fresh key for each value,
 * HKDF-SHA256, AES-256-GCM), bound to the rig and the key, so only that rig's supervisor opens it
 * and a value can't pass for another key's. Only control may write the bucket; a rig's user may
 * read only its own rig's keys (core/link/users.ts).
 */

/** The stream that holds the bucket: the latest value of each rig's keys. */
export const CONFIG_STREAM = "CONFIG";
/** Every rig's keys: the stream takes these. */
export const CONFIG_SUBJECTS = "thermite.rig.*.config.*";
/** The keys this build writes and reads, each a subject's last token. */
export const CONFIG_KEYS = ["model-route", "advisor-routes", "mcp-servers"] as const;
export type ConfigKey = (typeof CONFIG_KEYS)[number];

/**
 * What each key holds, before it is sealed: the answer of the route a rig's supervisor polled for
 * it (core/api/control/rigs.ts), so a value has one schema whichever way it comes.
 */
export const CONFIG_VALUES = {
  "model-route": MODEL_ROUTE.answer,
  "advisor-routes": ADVISOR_ROUTES.answer,
  "mcp-servers": MCP_SERVERS.answer,
} as const satisfies Record<ConfigKey, z.ZodType>;
export type ConfigValue<K extends ConfigKey> = z.output<(typeof CONFIG_VALUES)[K]>;

/** The subject a rig's key is on. A rig whose name is not a rig's name has none. */
export function configSubject(rig: string, key: ConfigKey): string {
  if (!RIG_ID.test(rig)) throw new Error(`not a rig's name for a config subject: ${rig}`);
  return `thermite.rig.${rig}.config.${key}`;
}

/** The subjects of every key of a rig this build knows. */
export const configSubjects = (rig: string): string[] =>
  CONFIG_KEYS.map((key) => configSubject(rig, key));

const SUBJECT = /^thermite\.rig\.([^.*>\s]+)\.config\.([^.*>\s]+)$/;

/** The rig and the key a subject names, or null. The key may be one this build does not know. */
export function readConfigSubject(subject: string): { rig: string; key: string } | null {
  const [, rig = "", key = ""] = SUBJECT.exec(subject) ?? [];
  return RIG_ID.test(rig) && key ? { rig, key } : null;
}

/** Whether a key is one this build knows. */
export const isConfigKey = (key: string): key is ConfigKey =>
  (CONFIG_KEYS as readonly string[]).includes(key);

/**
 * The largest config message, its headers included. A value sealed is about a third larger than
 * it is; the largest is the MCP servers' list, 50 servers at most, each with its sign-in.
 */
export const CONFIG_MAX_BYTES = 1024 * 1024;
/** Room kept under the limit for a message's headers: its id. */
const HEADER_ROOM = 4096;

/** Whether a message whose data is this many bytes fits, its headers with it. */
export function configFits(bytes: number): boolean {
  return bytes + HEADER_ROOM <= CONFIG_MAX_BYTES;
}

/** The message's own version: a message of another is refused, and the value known is kept. */
export const CONFIG_VERSION = 1;

/**
 * A message: one key's value, sealed, with what control and the supervisor read without opening
 * it. `revision` changes with the value and with the seal key it is sealed to; it is a digest only
 * control can make, so it tells nothing of a secret. A field this build does not know is passed
 * over.
 */
export const ConfigMessage = z.looseObject({
  v: z.literal(CONFIG_VERSION),
  rig: z.string().regex(RIG_ID),
  key: z.string().min(1).max(64),
  revision: z.string().regex(/^[0-9a-f]{16,64}$/),
  written_at: z.iso.datetime(),
  /** The value as JSON, sealed to the rig's seal key, in base64. */
  sealed: z.string().min(1).max(CONFIG_MAX_BYTES),
});
export type ConfigMessage = z.infer<typeof ConfigMessage>;

/** A message's id: its subject and revision, and when it was written, so each write is kept. */
export function configMessageId(m: Pick<ConfigMessage, "rig" | "key" | "revision" | "written_at">) {
  return `${m.rig}:${m.key}:${m.revision}@${m.written_at}`;
}

/** What binds a sealed value to its rig and key: it opens under no other. */
const sealLabel = (rig: string, key: string) => `thermite-config-v${CONFIG_VERSION} ${rig} ${key}`;

/** A key's value, sealed to the rig's seal key (its public part on one line), in base64. */
export function sealConfig(rig: string, key: ConfigKey, value: unknown, sealKey: string): string {
  const plain = Buffer.from(JSON.stringify(value), "utf8");
  return seal(plain, publicKeyFromLine(sealKey), sealLabel(rig, key)).toString("base64");
}

/** A sealed value, opened with the rig's private seal key. Throws when it does not open. */
export function openConfig(rig: string, key: string, sealed: string, privatePem: string): unknown {
  const plain = open(Buffer.from(sealed, "base64"), privatePem, sealLabel(rig, key));
  return JSON.parse(plain.toString("utf8"));
}

/** A rig's seal key: the private part stays on the rig; control seals to the public part. */
export interface SealKey {
  privatePem: string;
  /** Its public part on one line (base64 of its DER form), as the supervisor registers it. */
  publicKey: string;
}

/** A new seal key. */
export function newSealKey(): SealKey {
  const k = generateBoxKeys();
  return { privatePem: k.boxPrivatePem, publicKey: publicKeyLine(k.boxPublicPem) };
}

/** What a seal key is, in words, for a refusal. */
export const SEAL_KEY_WORDS = "an X25519 public key: base64 of its DER form, on one line";

/** Whether `line` is an X25519 public key on one line. */
export function isSealKey(line: string): boolean {
  if (!/^[A-Za-z0-9+/]{40,80}={0,2}$/.test(line)) return false;
  try {
    return createPublicKey(publicKeyFromLine(line)).asymmetricKeyType === "x25519";
  } catch {
    return false;
  }
}

/** What logs, the audit log and a rig's history show of a seal key: never the key itself. */
export function sealKeyFingerprint(line: string): string {
  return sha256Hex(line).slice(0, 16);
}

/** Why the supervisor did not take a message: a fixed set of words, logged with the subject. */
export type ConfigRefusal =
  | "not a config subject"
  | "another rig's subject"
  | "a key this build does not know"
  | "not a config message"
  | "its rig or key is not its subject's"
  | "it does not open with this rig's seal key"
  | "not a value of its key";

/** A message as the supervisor reads it: a key's value, or why it was not taken. */
export type ConfigRead =
  | { key: ConfigKey; revision: string; writtenAt: string; value: unknown }
  | { refused: ConfigRefusal; error?: string };

/**
 * A message as `rig`'s supervisor reads it, opened with its private seal key, and its value
 * checked against its key's schema. Nothing throws: a message it can't take says why, and the
 * value the supervisor knows stays (owner's decision 6). A key this build does not know, from a
 * newer control, is refused the same way, and counted.
 */
export function readConfig(
  rig: string,
  subject: string,
  data: Uint8Array,
  privatePem: string,
): ConfigRead {
  const on = readConfigSubject(subject);
  if (!on) return { refused: "not a config subject" };
  if (on.rig !== rig) return { refused: "another rig's subject" };
  if (!isConfigKey(on.key)) return { refused: "a key this build does not know" };
  let m: ConfigMessage;
  try {
    m = ConfigMessage.parse(JSON.parse(new TextDecoder().decode(data)));
  } catch (err) {
    return { refused: "not a config message", error: String(err).slice(0, 300) };
  }
  if (m.rig !== on.rig || m.key !== on.key)
    return { refused: "its rig or key is not its subject's" };
  let raw: unknown;
  try {
    raw = openConfig(rig, on.key, m.sealed, privatePem);
  } catch {
    // No more than that: the error of a seal that does not open says nothing useful.
    return { refused: "it does not open with this rig's seal key" };
  }
  const value = CONFIG_VALUES[on.key].safeParse(raw);
  if (!value.success)
    return { refused: "not a value of its key", error: value.error.message.slice(0, 300) };
  return { key: on.key, revision: m.revision, writtenAt: m.written_at, value: value.data };
}

/** How long the bus remembers a message id, in nanoseconds: two minutes. */
const DUPLICATE_WINDOW_NS = 2 * 60 * 1e9;

/**
 * The stream's settings: a key-value bucket. It keeps one message for each subject, the latest;
 * a new value replaces the one before. Nothing ages out: a value stays until control writes the
 * next. A key's latest value is read by its subject (direct get), as a rig's supervisor reads its
 * own keys when it starts watching them.
 */
export const CONFIG_STREAM_CONFIG = {
  name: CONFIG_STREAM,
  subjects: [CONFIG_SUBJECTS],
  description: "Each rig's configuration from control, the latest value of each key, sealed",
  retention: "limits",
  storage: "file",
  max_msgs: -1,
  max_bytes: -1,
  max_age: 0,
  max_msgs_per_subject: 1,
  max_msg_size: CONFIG_MAX_BYTES,
  discard: "old",
  duplicate_window: DUPLICATE_WINDOW_NS,
  allow_direct: true,
  num_replicas: 1,
} satisfies Partial<StreamConfig> & { name: string };

/** The consumer a rig's supervisor watches the rig's keys with. */
export function configConsumerName(rig: string): string {
  if (!RIG_ID.test(rig)) throw new Error(`not a rig's name for a config consumer: ${rig}`);
  return `rig-${rig}-config`;
}

/** How long the supervisor may take over one value before the stream hands it again. */
const ACK_WAIT_NS = 30 * 1e9;

/**
 * A rig's consumer: the rig's keys alone, the latest value of each first, then each new one.
 * Control makes it, as it makes the rig's commands consumer; the rig's user may only read it and
 * take from it. The supervisor reads each key's latest value by its subject each time it starts
 * watching, since the consumer hands only what it has not acked.
 */
export function configConsumerConfig(rig: string) {
  return {
    durable_name: configConsumerName(rig),
    filter_subject: `thermite.rig.${rig}.config.*`,
    ack_policy: "explicit",
    deliver_policy: "last_per_subject",
    max_ack_pending: 1,
    ack_wait: ACK_WAIT_NS,
    max_deliver: -1,
  } satisfies Partial<ConsumerConfig> & { durable_name: string };
}
