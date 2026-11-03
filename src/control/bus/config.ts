import type { Bus } from "../../common/bus/index.ts";
import { log } from "../../common/env.ts";
import { errorText } from "../../common/errors.ts";
import type { ConfigFigures } from "../../core/api/control/rigs.ts";
import { canonicalJson } from "../../core/canonical.ts";
import {
  CONFIG_KEYS,
  CONFIG_MAX_BYTES,
  CONFIG_STREAM,
  CONFIG_STREAM_CONFIG,
  CONFIG_VERSION,
  type ConfigKey,
  ConfigMessage,
  configFits,
  configMessageId,
  configSubject,
  type GitAccessSecret,
  sealConfig,
  sealKeyFingerprint,
} from "../../core/link/config.ts";
import type { McpConnection, McpUnavailable } from "../../core/mcp.ts";
import type { ControlParts } from "../parts.ts";
import { advisorRoutesOf, modelRoutesOf } from "../rigs/index.ts";
import type { ControlStore } from "../store/index.ts";
import { closedRuns } from "../views/index.ts";
import { busRigs } from "./users.ts";

/**
 * Each rig's configuration on the message bus (goal 168, step 3): control writes what a rig's
 * supervisor needs of it to the rig's keys in the config bucket (core/link/config.ts), each value
 * sealed to the rig's seal key, and only when it changes: the model routes, the advisors' routes,
 * the MCP servers and the Git accesses its live assignments name. Control looks at every rig
 * on the bus every CONFIG_WRITE_MS: a value it makes is compared, by its revision, with the one on
 * the bus, and written only when they differ. The look also renews what a value holds before it
 * ends (a ChatGPT login, an MCP server's sign-in). Control's store stays
 * the truth; a value control can't make (a provider's key that does not open) is not written, and
 * the rig keeps the one it has.
 */

/**
 * How often control looks at each rig's config, in milliseconds. A look that finds nothing changed
 * writes nothing; one that changes a value writes that key alone.
 */
export const CONFIG_WRITE_MS = 5_000;

/** What control needs of the bus for the config: the bucket's stream, a write, a read back. */
export type ConfigBus = Pick<Bus, "makeStream" | "publish" | "last">;

/** What control makes a rig's config from: its store and secrets, ChatGPT's logins, MCP servers. */
export type ConfigParts = Pick<ControlParts, "store" | "secrets" | "chatgpt" | "mcpServers">;

/** What the MCP servers' key holds: McpServers.forRig's answer. */
type McpForRig = { servers: McpConnection[]; unavailable: McpUnavailable[] };

/**
 * Records the seal key a rig's supervisor registered beside its user key (checked by the caller
 * with isSealKey), as takeRigBusKey records the user key: its first key, and each change, is an
 * entry in the audit log and a step in the rig's history, with the key's fingerprint, in one
 * transaction with the key. What changed: a first key, another key, or nothing.
 */
export function takeRigSealKey(
  store: ControlStore,
  rig: string,
  key: string,
): "new" | "changed" | "same" {
  const before = store.busKeys.rigSealKey(rig);
  if (before === key) return "same";
  const fingerprint = sealKeyFingerprint(key);
  const previous = before === undefined ? undefined : sealKeyFingerprint(before);
  store.tx(() => {
    store.busKeys.setRigSealKey(rig, key);
    if (previous === undefined) {
      store.auditLog.add(`rig:${rig}`, "rig_seal_key_registered", { fingerprint });
      store.rigHistory.add(rig, "seal_key", true, `fingerprint ${fingerprint}`);
    } else {
      store.auditLog.add(`rig:${rig}`, "rig_seal_key_changed", { fingerprint, previous });
      const detail = `fingerprint ${previous} → ${fingerprint}`;
      store.rigHistory.add(rig, "seal_key_changed", true, detail);
    }
  });
  const what = { rig, fingerprint, ...(previous ? { previous } : {}) };
  log("control", previous ? "a rig's seal key changed" : "a rig's seal key registered", what);
  return previous === undefined ? "new" : "changed";
}

/** What control wrote to the config bucket since it started, which the bus's state shows. */
export class ConfigWritten {
  readonly since = new Date().toISOString();
  /** Values written, by key. */
  readonly written: Record<ConfigKey, number> = Object.fromEntries(
    CONFIG_KEYS.map((k) => [k, 0]),
  ) as Record<ConfigKey, number>;
  /** Writes the bus did not take: tried again at the next look. */
  failed = 0;
  /** Values too large for a message: not written, and the rig keeps the one it has. */
  tooLarge = 0;
  /** Values control could not make, such as a provider's key that does not open: not written. */
  notMade = 0;
  /** Values written, by rig. */
  readonly rigs = new Map<string, number>();
}

export interface ConfigWriterOptions {
  parts: ConfigParts;
  bus: ConfigBus;
  figures: ConfigWritten;
}

/**
 * Writes each rig's config to the bucket, a key at a time, when its value changes. write() makes
 * one look at every rig on the bus, after a look under way; it never throws.
 */
export class ConfigWriter {
  private readonly o: ConfigWriterOptions;
  /** The revision on the bus of each subject, as control wrote it or read it back; "" for none. */
  private readonly onBus = new Map<string, string>();
  /** Why each subject was last not written, so it is logged once until the why changes. */
  private readonly told = new Map<string, string>();
  private made: Promise<void> | undefined;
  private ready = false;
  private last: Promise<void> = Promise.resolve();

  constructor(o: ConfigWriterOptions) {
    this.o = o;
  }

  /**
   * Makes the bucket's stream, or brings it to its settings, trying again until the bus has it;
   * a look before then writes nothing. After a write the bus did not take, it is made again.
   */
  start(): Promise<void> {
    this.made ??= this.o.bus.makeStream(CONFIG_STREAM_CONFIG).then(() => {
      this.ready = true;
      log("control", "rigs' config goes on the message bus", { stream: CONFIG_STREAM });
    });
    return this.made;
  }

  /** One look at every rig on the bus, after the one under way. */
  write(): Promise<void> {
    this.last = this.last.then(() => this.writeNow());
    return this.last;
  }

  private async writeNow(): Promise<void> {
    // A stream being made again (after a write the bus did not take) is waited for, so this
    // look writes every key read back, not some of them.
    if (!this.ready && this.made) await this.made.catch(() => {});
    if (!this.ready) return;
    const { store } = this.o.parts;
    for (const r of busRigs(store)) {
      if (!r.sealKey) continue;
      for (const key of CONFIG_KEYS) {
        // A write the bus did not take ends this look: the next reads every key back.
        if (!(await this.writeKey(r.rig, key, r.sealKey))) return;
      }
    }
  }

  /** Logs why a subject was not written, once until the why changes; a write clears it. */
  private tell(subject: string, why: string, say: () => void): void {
    if (this.told.get(subject) === why) return;
    this.told.set(subject, why);
    say();
  }

  /** The revision on the bus of a subject: read back once, then as control writes it. */
  private async revisionOnBus(subject: string): Promise<string> {
    const known = this.onBus.get(subject);
    if (known !== undefined) return known;
    const m = await this.o.bus.last(CONFIG_STREAM, subject);
    let revision = "";
    try {
      if (m) revision = ConfigMessage.parse(JSON.parse(new TextDecoder().decode(m.data))).revision;
    } catch {
      // Not a message this build reads: written again.
    }
    this.onBus.set(subject, revision);
    return revision;
  }

  /** Writes one key if it changed; false when the bus did not take the write. */
  private async writeKey(rig: string, key: ConfigKey, sealKey: string): Promise<boolean> {
    const { secrets } = this.o.parts;
    const figures = this.o.figures;
    const subject = configSubject(rig, key);
    const where = { rig, key };
    let value: unknown;
    try {
      value = await configValueOf(this.o.parts, rig, key);
    } catch (err) {
      value = { error: errorText(err) };
    }
    if (value && typeof value === "object" && "error" in value) {
      figures.notMade++;
      const error = String(value.error).slice(0, 300);
      this.tell(subject, `not made: ${error}`, () =>
        log(
          "control",
          "a rig's config not written: control can't make it",
          { ...where, error },
          "warn",
        ),
      );
      return true;
    }
    // Changes with the value and with the key it is sealed to; only control's secrets key makes it.
    const revision = secrets.digest(`${key}\n${sealKey}\n${canonicalJson(value)}`);
    try {
      if ((await this.revisionOnBus(subject)) === revision) return true;
    } catch (err) {
      figures.failed++;
      const error = errorText(err);
      this.tell(subject, `not read: ${error}`, () =>
        log("control", "a rig's config not read back from the bus", { ...where, error }, "warn"),
      );
      return true;
    }
    if (this.told.get(subject) === `too large: ${revision}`) return true;
    const writtenAt = new Date().toISOString();
    const message = {
      v: CONFIG_VERSION,
      rig,
      key,
      revision,
      written_at: writtenAt,
      sealed: sealConfig(rig, key, value, sealKey),
    };
    const data = JSON.stringify(message);
    const bytes = Buffer.byteLength(data);
    if (!configFits(bytes)) {
      figures.tooLarge++;
      this.tell(subject, `too large: ${revision}`, () =>
        log(
          "control",
          "a rig's config too large for the bus; the rig keeps what it has",
          { ...where, bytes, max_bytes: CONFIG_MAX_BYTES },
          "error",
        ),
      );
      return true;
    }
    try {
      const ack = await this.o.bus.publish(subject, data, { id: configMessageId(message) });
      this.onBus.set(subject, revision);
      this.told.delete(subject);
      figures.written[key]++;
      figures.rigs.set(rig, (figures.rigs.get(rig) ?? 0) + 1);
      // What a rig gets of the MCP servers and the Git accesses is audited when it changes.
      if (key === "mcp-servers") this.o.parts.mcpServers.handed(rig, value as McpForRig);
      if (key === "git-access") {
        const names = (value as { accesses: GitAccessSecret[] }).accesses.map((a) => a.name);
        this.o.parts.store.auditLog.add(`rig:${rig}`, "git_access_handed", { names });
      }
      log("control", "a rig's config written to the bus", { ...where, revision, seq: ack.seq });
      return true;
    } catch (err) {
      // The bus may have lost its store, the stream with it: the stream is made again, and every
      // key read back again before it is written.
      this.onBus.clear();
      if (this.ready) {
        this.ready = false;
        this.made = undefined;
        void this.start();
      }
      figures.failed++;
      const error = errorText(err);
      this.tell(subject, `not written: ${error}`, () =>
        log(
          "control",
          "a rig's config not written to the bus; trying again",
          { ...where, error },
          "warn",
        ),
      );
      return false;
    }
  }
}

/**
 * What control gives a rig for one key of its config now, before it is sealed: its value, or
 * `{ error }` in words when control can't make it (a provider's key that does not open).
 */
export async function configValueOf(
  parts: ConfigParts,
  rig: string,
  key: ConfigKey,
): Promise<unknown> {
  if (key === "model-route") return modelRoutesOf(parts, rig);
  if (key === "advisor-routes") return advisorRoutesOf(parts, rig);
  if (key === "git-access") return gitAccessesOf(parts, rig);
  return parts.mcpServers.forRig(rig);
}

/**
 * The Git accesses a rig's live assignments name, each opened, with the host it is for: what the
 * rig's supervisor stages their projects with. An access with no host, gone, or that does not
 * open is left out, in control's log: staging then fails for it, in words.
 */
function gitAccessesOf(parts: ConfigParts, rig: string): { accesses: GitAccessSecret[] } {
  const { store, secrets } = parts;
  const accesses: GitAccessSecret[] = [];
  for (const name of store.commands.gitAccessesOf(rig, closedRuns(store, rig))) {
    const g = store.gitAccess.get(name);
    if (!g?.host) continue;
    let secret: string;
    try {
      secret = secrets.open(g.secret_sealed);
    } catch (err) {
      const why = { rig, name, error: errorText(err) };
      log(
        "control",
        "a Git access not given: control's secrets key does not open it",
        why,
        "error",
      );
      continue;
    }
    accesses.push(
      g.kind === "ssh"
        ? { name, kind: "ssh", host: g.host, private_key: secret }
        : {
            name,
            kind: "token",
            host: g.host,
            token: secret,
            ...(g.username ? { username: g.username } : {}),
          },
    );
  }
  return { accesses };
}

/** A rig's config on the bus: control's writes, and its supervisor's own counts. */
export interface RigConfig {
  rig: string;
  /** Whether it registered a seal key: without one, control writes it nothing. */
  sealed: boolean;
  /** Values control wrote it since control started. */
  written: number;
  /** The supervisor's figures, since it started; null before its first figures with them. */
  supervisor: (ConfigFigures & { at: string | null }) | null;
}

/** The config bucket's keys, what control wrote to it, and each rig's counts. */
export function configState(store: ControlStore, written: ConfigWritten) {
  const rigs: RigConfig[] = [];
  const onBus = new Map(busRigs(store).map((r) => [r.rig, Boolean(r.sealKey)]));
  for (const r of store.reportedRigs.list()) {
    const sup = store.reportedRigs.supervisor(r.id);
    const config = sup?.config as ConfigFigures | undefined;
    if (!config && !onBus.has(r.id)) continue;
    const at = typeof sup?.received_at === "string" ? sup.received_at : null;
    rigs.push({
      rig: r.id,
      sealed: onBus.get(r.id) ?? false,
      written: written.rigs.get(r.id) ?? 0,
      supervisor: config ? { ...config, at } : null,
    });
    onBus.delete(r.id);
  }
  for (const [rig, sealed] of onBus)
    rigs.push({ rig, sealed, written: written.rigs.get(rig) ?? 0, supervisor: null });
  return {
    keys: [...CONFIG_KEYS],
    message_bytes: CONFIG_MAX_BYTES,
    written: {
      since: written.since,
      values: { ...written.written },
      failed: written.failed,
      too_large: written.tooLarge,
      not_made: written.notMade,
    },
    rigs,
  };
}
