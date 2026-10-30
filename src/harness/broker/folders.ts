import { execFileSync } from "node:child_process";
import {
  chmodSync,
  chownSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { log, logError } from "../../common/log.ts";
import { type Broker, fatalExit, SECRET_VARS, TG, TU, tryDo } from "./context.ts";
import { emptyScratchKeepingCaches, restoreLaneCaches } from "./lane-caches.ts";
import { IDS, type Role, roleIds } from "./runner.ts";

/**
 * The broker's folders, as root: at its start, the state, scratch, outbox and socket folders, each
 * with the owner and mode its users need, and the secret files read and their folders closed; and
 * a full reset's wipe, before the controller starts.
 */

const WIPE_MARKER = "WIPE_REQUESTED";
const NOT_BEFORE_FILE = "NOT_BEFORE";

export function prepareDirectories(broker: Broker): void {
  for (const d of [broker.stateDir, broker.scratchDir, broker.outboxDir, broker.socketDir])
    mkdirSync(d, { recursive: true });
  // State: owned by thermite; others may only traverse to the build store and models.
  if (statSync(broker.stateDir).uid !== TU) {
    log("broker", "taking ownership of the state volume for thermite");
    tryDo("chown the state volume", () =>
      execFileSync("chown", ["-R", "-P", `${TU}:${TG}`, broker.stateDir], { stdio: "ignore" }),
    );
  }
  chmodSync(broker.stateDir, 0o711);
  shareWithCheckers(broker.stateDir);
  // Scratch is disposable: whatever an earlier run left (including hostile trees) goes now. The
  // lanes' cache folders are kept (goal 079): each a real folder its own lane's user owns.
  chownSync(broker.scratchDir, 0, 0);
  chmodSync(broker.scratchDir, 0o755);
  const kept = emptyScratchKeepingCaches(broker.scratchDir, {
    keep: (lane, st) => st.uid === roleIds(lane as Role).uid,
    remove: (path) =>
      tryDo(`clear scratch ${path}`, () =>
        execFileSync("rm", ["-rf", "--one-file-system", path], { stdio: "ignore" }),
      ),
  });
  const ctl = join(broker.scratchDir, "thermite");
  mkdirSync(join(ctl, "tmp"), { recursive: true });
  execFileSync("chown", ["-R", "-P", `${TU}:${TG}`, ctl], { stdio: "ignore" });
  chmodSync(ctl, 0o711);
  chmodSync(join(ctl, "tmp"), 0o700);
  // Put back after the controller's folder is its own: each cache stays its lane's.
  tryDo("keep the lanes' caches", () =>
    restoreLaneCaches(broker.scratchDir, kept, (dir) => chownSync(dir, TU, TG)),
  );
  if (kept.length) log("broker", "kept the lanes' caches over the start", { lanes: kept });
  // Shared temporary places are closed to every role (each gets a TMPDIR of its own); the
  // controller and the judge's kit scripts may still use them (sticky, group thermite).
  for (const d of ["/tmp", "/var/tmp", "/dev/shm"]) {
    if (!existsSync(d)) continue;
    tryDo(`close ${d}`, () => {
      chownSync(d, 0, TG);
      chmodSync(d, 0o1770);
    });
  }
  prepareOutbox(broker);
}

/**
 * The kits and the baselines: the controller's, and entered by the checkers' group too, which
 * the kit's check runs with (runner.ts): it reads the kit, and later jobs' checks the files a
 * hill climb's baseline kept. No other role may enter either. Every folder under the baselines
 * keeps the group (setgid), and what is there already gets it, readable by the group. Root here
 * has no CAP_FSETID, and a folder keeps its setgid mark only when its group is the process's own:
 * these calls run in children with the checkers' group as theirs. The broker's own group never
 * changes, since a process whose group changed stays undumpable, its environment closed to root.
 */
function shareWithCheckers(stateDir: string): void {
  const group = `${TU}:${IDS.checkersGroup}`;
  const asCheckers = { stdio: "ignore", gid: IDS.checkersGroup } as const;
  tryDo("share the kits and the baselines with the checkers", () => {
    const kits = join(stateDir, "kits");
    mkdirSync(kits, { recursive: true });
    chownSync(kits, TU, IDS.checkersGroup);
    chmodSync(kits, 0o710);
    const baselines = join(stateDir, "baselines");
    mkdirSync(baselines, { recursive: true });
    execFileSync("chown", ["-R", "-P", group, baselines], asCheckers);
    execFileSync("chmod", ["-R", "g+rX,g-w", baselines], asCheckers);
    execFileSync("find", [baselines, "-type", "d", "-exec", "chmod", "g+s", "{}", "+"], asCheckers);
    execFileSync("chmod", ["2710", baselines], asCheckers);
  });
}

/** The broker's socket directory, and a clean socket path to listen on (at broker start only). */
export function prepareSocket(broker: Broker): void {
  mkdirSync(broker.socketDir, { recursive: true });
  chownSync(broker.socketDir, 0, TG);
  chmodSync(broker.socketDir, 0o750);
  rmSync(broker.socketPath, { force: true });
}

/**
 * Exports: written by thermite, readable by the supervisor's group only (setgid keeps the group
 * on new files and directories). Re-asserted every minute too: a container engine may hand a
 * shared, still-empty volume to the user of whichever container mounted it first.
 */
export function prepareOutbox(broker: Broker): void {
  tryDo("prepare the outbox", () => {
    const st = statSync(broker.outboxDir);
    if (st.uid !== TU || st.gid !== broker.outboxGid)
      chownSync(broker.outboxDir, TU, broker.outboxGid);
    if ((st.mode & 0o7777) !== 0o2750) chmodSync(broker.outboxDir, 0o2750);
  });
}

export function readSecrets(broker: Broker): Record<string, string> {
  const values: Record<string, string> = {};
  const dirs = new Set<string>();
  for (const [fileVar, valueVar] of Object.entries(SECRET_VARS)) {
    const path = broker.env[fileVar];
    if (!path || !existsSync(path)) continue;
    values[valueVar] = readFileSync(path, "utf8").trim();
    dirs.add(dirname(path));
  }
  // Nobody but root may open the secret files from here on, whatever their own modes are.
  for (const d of dirs) tryDo(`close ${d}`, () => chmodSync(d, 0o700));
  // Fail closed: a secret another user could still read is a reason not to start.
  for (const fileVar of Object.keys(SECRET_VARS)) {
    const path = broker.env[fileVar];
    if (!path || !existsSync(path)) continue;
    const dirOpen = (statSync(dirname(path)).mode & 0o055) !== 0;
    const fileOpen = (statSync(path).mode & 0o044) !== 0;
    if (dirOpen && fileOpen) {
      logError("broker", "fatal: a secret file stays readable by other users", { file: fileVar });
      fatalExit(broker);
    }
  }
  return values;
}

/**
 * A full reset's wipe, requested by the controller (a marker in the state directory): done here,
 * as root, before the controller starts, so files other users own or locked build trees cannot
 * stop it. The rig's identity key stays; the wipe time is left for the new ledger, which then
 * refuses commands issued before it (they belonged to the wiped ledger).
 */
export function wipeIfMarked(broker: Broker): boolean {
  const marker = join(broker.stateDir, WIPE_MARKER);
  if (!existsSync(marker)) return false;
  const keep = new Set([
    "rig-signing.key",
    "rig-signing.key.pub",
    "unit-signing.key",
    "unit-signing.key.pub",
  ]);
  const rm = (p: string) =>
    execFileSync("rm", ["-rf", "--one-file-system", "--", p], { stdio: "ignore" });
  for (const name of readdirSync(broker.stateDir)) {
    if (name === WIPE_MARKER) continue;
    if (name === "ledger") {
      for (const f of readdirSync(join(broker.stateDir, name)))
        if (!keep.has(f)) rm(join(broker.stateDir, name, f));
      continue;
    }
    rm(join(broker.stateDir, name));
  }
  for (const dir of [broker.scratchDir, broker.outboxDir]) {
    for (const name of existsSync(dir) ? readdirSync(dir) : []) rm(join(dir, name));
  }
  mkdirSync(join(broker.stateDir, "ledger"), { recursive: true });
  // The wipe command's issue time (control's clock), recorded in the marker by the controller.
  let notBefore = new Date().toISOString();
  try {
    const at = (JSON.parse(readFileSync(marker, "utf8")) as { not_before?: string }).not_before;
    if (at && Number.isFinite(Date.parse(at))) notBefore = at;
  } catch {
    // an unreadable marker: now
  }
  writeFileSync(join(broker.stateDir, "ledger", NOT_BEFORE_FILE), notBefore);
  chownSync(join(broker.stateDir, "ledger", NOT_BEFORE_FILE), TU, TG);
  rmSync(marker, { force: true });
  log("broker", "wiped the rig's state (full reset)");
  return true;
}
