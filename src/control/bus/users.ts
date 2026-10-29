import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createUser, fromSeed } from "@nats-io/nkeys";
import { log, redact } from "../../common/env.ts";
import { errorText } from "../../common/errors.ts";
import { writeAtomic } from "../../common/fs.ts";
import { LIVE_RUNS_PER_RIG } from "../../core/link/live.ts";
import { isUserKey, userKeyFingerprint, usersFile } from "../../core/link/users.ts";
import type { SecretBox } from "../secrets.ts";
import type { BusIdentityName, ControlStore } from "../store/index.ts";

/**
 * Who may use the message bus (goal 168). Each rig's supervisor makes its own key and registers
 * its public part on its regular call to control (takeRigBusKey); control keeps it, writes every
 * user with what it may do to the server's users file, and asks the server to reload the file
 * (BusUsers). Control's own two keys are made here on first use and kept sealed in its store. The
 * backup's key (goal 173) is made here too, its seed in a file of control's state folder that
 * `thermite backup` and `thermite restore` read: its user may snapshot and restore the streams kept
 * for good, and nothing else.
 */

/**
 * The setting that names the folder control writes the bus's server's files to: its users, and its
 * TLS certificate and key (tls.ts). The server's configuration includes them.
 */
export const BUS_CONFIG_DIR_SETTING = "THERMITE_NATS_CONFIG_DIR";
/** The users file's name in that folder. */
export const BUS_USERS_FILE = "users.conf";

/**
 * How often control brings the users file to its store: for a rig retired, a run a rig may now
 * publish the live lines of, or a reload that failed. A look that finds nothing changed writes
 * nothing and asks no reload.
 */
export const BUS_USERS_SYNC_MS = 5_000;

/**
 * The folder of the server's files, from its setting. Control needs one, as it needs its bus: the
 * server knows only the users control writes there, and serves the certificate it writes there.
 * Not set stops control at start.
 */
export function busConfigDir(env: Record<string, string | undefined>): string {
  const dir = env[BUS_CONFIG_DIR_SETTING]?.trim();
  if (!dir)
    throw new Error(
      `control needs ${BUS_CONFIG_DIR_SETTING}: the folder control writes the bus's users and TLS certificate to, which the server's configuration includes`,
    );
  return dir;
}

/** The users file's mode: it holds public keys and permissions, which the server reads. */
const USERS_FILE_MODE = 0o644;

/**
 * Records the key a rig's supervisor registered (checked by the caller with isUserKey). Its first
 * key, and each change, is an entry in the audit log and a step in the rig's history, with the
 * key's fingerprint, in one transaction with the key. What changed: a first key, another key, or
 * nothing.
 */
export function takeRigBusKey(
  store: ControlStore,
  rig: string,
  key: string,
): "new" | "changed" | "same" {
  const before = store.busKeys.rigKey(rig);
  if (before === key) return "same";
  const fingerprint = userKeyFingerprint(key);
  const previous = before === undefined ? undefined : userKeyFingerprint(before);
  store.tx(() => {
    store.busKeys.setRigKey(rig, key);
    if (previous === undefined) {
      store.auditLog.add(`rig:${rig}`, "rig_bus_key_registered", { fingerprint });
      store.rigHistory.add(rig, "bus_key", true, `fingerprint ${fingerprint}`);
    } else {
      store.auditLog.add(`rig:${rig}`, "rig_bus_key_changed", { fingerprint, previous });
      const detail = `fingerprint ${previous} → ${fingerprint}`;
      store.rigHistory.add(rig, "bus_key_changed", true, detail);
    }
  });
  if (previous === undefined) {
    log("control", "a rig's key on the bus registered", { rig, fingerprint });
    return "new";
  }
  log("control", "a rig's key on the bus changed", { rig, fingerprint, previous }, "warn");
  return "changed";
}

/**
 * The rigs that have a user on the bus: each with a registered key, known to control and not
 * retired, with its seal key when it registered one.
 */
export function busRigs(store: ControlStore) {
  return store.busKeys
    .rigKeys()
    .filter((r) => store.enrollments.knownRig(r.rig) && !store.retired.get(r.rig));
}

export interface BusUsersOptions {
  store: ControlStore;
  /** Seals control's own keys in its store. */
  secrets: SecretBox;
  /** The users file the server's configuration includes, in THERMITE_NATS_CONFIG_DIR. */
  file: string;
  /**
   * The server's certificate and key, written beside the users when they must be made anew (true
   * then); none: the server has no TLS of control's.
   */
  tls?: { write(): boolean } | undefined;
  /** Asks the server to read the users file again, signed in as control's system user. */
  reload: (systemSeed: Uint8Array) => Promise<void>;
  /** The file of the backup's seed, made there first (mode 0600); none: the bus has no backup user. */
  backupSeedFile?: string | undefined;
}

/** One of control's own keys: its seed, and the public part the users file names. */
interface Identity {
  seed: Uint8Array;
  publicKey: string;
}

/**
 * The bus's users, as control's store has them: control's own, and one for each rig with a key
 * that is known and not retired. sync writes the users file when what it says changed and has the
 * server reload it, one at a time.
 */
export class BusUsers {
  private readonly o: BusUsersOptions;
  private readonly control: Identity;
  private readonly system: Identity;
  /** The backup's key's public part, when control keeps one. */
  private readonly backup: string | undefined;
  /** The users file as control last wrote it; undefined before its first write. */
  private written: string | undefined;
  /** Whether the server took the file as last written. */
  private reloaded = false;
  /** Whether the last sync failed: a failure is logged in full once, then quietly until one works. */
  private failing = false;
  private last: Promise<void> = Promise.resolve();

  constructor(o: BusUsersOptions) {
    this.o = o;
    this.control = identity(o, "control");
    this.system = identity(o, "system");
    this.backup = o.backupSeedFile ? backupKey(o.backupSeedFile) : undefined;
  }

  /** The seed control signs in to the bus with. */
  get controlSeed(): Uint8Array {
    return this.control.seed;
  }

  /** The seed of control's system user: a reload, and the server's figures of its store. */
  get systemSeed(): Uint8Array {
    return this.system.seed;
  }

  /** The users file's text now: each rig's user with the runs control's run registry gives it. */
  text(): string {
    const { store } = this.o;
    const runs = store.runRegistry.runsByRig(LIVE_RUNS_PER_RIG);
    const rigs = busRigs(store).map((r) => ({
      rig: r.rig,
      key: r.key,
      runs: runs.get(r.rig) ?? [],
    }));
    const own = { control: this.control.publicKey, system: this.system.publicKey };
    return usersFile({ ...own, backup: this.backup, rigs });
  }

  /**
   * Brings the users file to the store, and the server's certificate up to date: writes each when
   * it changed, and asks the server to reload them then, or when the last reload failed. Waits for
   * a sync under way first. It never throws: a file not written or a reload that failed is logged,
   * and tried again at the next sync.
   */
  sync(): Promise<void> {
    this.last = this.last.then(() => this.syncNow());
    return this.last;
  }

  private async syncNow(): Promise<void> {
    const where = { file: this.o.file };
    let text: string;
    try {
      // The certificate first: the server starts once the users file is there.
      if (this.o.tls?.write()) this.reloaded = false;
      text = this.text();
      if (text !== this.written) {
        writeAtomic(this.o.file, text, USERS_FILE_MODE);
        this.written = text;
        this.reloaded = false;
        log("control", "the bus's users written", { ...where, users: usersIn(text) });
      }
    } catch (err) {
      const error = errorText(err);
      const level = this.failing ? "debug" : "error";
      log("control", "the bus's files not written; trying again", { ...where, error }, level);
      this.failing = true;
      return;
    }
    if (this.reloaded) return;
    try {
      await this.o.reload(this.system.seed);
      this.reloaded = true;
      this.failing = false;
      log("control", "the bus's server reloaded its users", { users: usersIn(text) });
    } catch (err) {
      const error = redact(errorText(err)).replace(/\bU[A-Z2-7]{55}\b/g, "U…");
      const what = { error, again_in_s: BUS_USERS_SYNC_MS / 1000 };
      const level = this.failing ? "debug" : "warn";
      log("control", "the bus's server did not reload its users; trying again", what, level);
      this.failing = true;
    }
  }
}

/**
 * The backup's key's public part, from the seed in `file`; made there first (mode 0600, never
 * overwritten). Throws, with what to do, when the file does not hold a user key's seed.
 */
function backupKey(file: string): string {
  if (!existsSync(file)) {
    const made = createUser();
    try {
      // "wx": never over a seed another process made meanwhile.
      writeFileSync(file, made.getSeed(), { mode: 0o600, flag: "wx" });
      log("control", "made the backup's key on the bus", {
        fingerprint: userKeyFingerprint(made.getPublicKey()),
      });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
  try {
    const key = fromSeed(
      new TextEncoder().encode(readFileSync(file, "utf8").trim()),
    ).getPublicKey();
    if (isUserKey(key)) return key;
  } catch {
    // Said below.
  }
  throw new Error(
    `${file} does not hold the seed of a NATS user key: remove it, and control makes the backup's key anew as it starts`,
  );
}

/** How many users a users file names. */
const usersIn = (text: string) => (text.match(/"nkey":/g) ?? []).length;

/**
 * One of control's own keys, from its store; made there first, its seed sealed. Throws, with what
 * to look at, when the seed does not open, as after control's secrets key was replaced.
 */
function identity(o: BusUsersOptions, name: BusIdentityName): Identity {
  const keys = o.store.busKeys;
  if (!keys.identity(name)) {
    const made = createUser();
    const seed = new TextDecoder().decode(made.getSeed());
    keys.addIdentity(name, made.getPublicKey(), o.secrets.seal(seed));
    log("control", "made control's key on the bus", {
      user: name,
      fingerprint: userKeyFingerprint(made.getPublicKey()),
    });
  }
  const kept = keys.identity(name);
  let seed: Uint8Array | undefined;
  try {
    seed = new TextEncoder().encode(o.secrets.open(kept?.sealedSeed ?? ""));
    if (fromSeed(seed).getPublicKey() !== kept?.publicKey) seed = undefined;
  } catch {
    seed = undefined;
  }
  if (!seed || !kept || !isUserKey(kept.publicKey))
    throw new Error(
      `control's ${name} key on the message bus does not open with its secrets key (was THERMITE_CONTROL_SECRETS_KEY_FILE replaced?)`,
    );
  return { seed, publicKey: kept.publicKey };
}
