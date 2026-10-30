import { randomBytes } from "node:crypto";
import {
  chmodSync,
  chownSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { GPU_OVERRIDE } from "./machine.ts";

/**
 * The local compose stack's folder, `.dev/`: random tokens in `secrets/`, the inbox, the outbox,
 * the advisors' folder and the backups' folder. The release bundle's `init` service makes it with
 * `thermite local init`; a checkout makes the same layout with `npm run dev:init`
 * (scripts/dev/init.mjs, which needs no build). Files that exist are kept, so the tokens stay
 * the same from one start to the next. Each rig's token for control starts empty: the stack's
 * enroll step enrolls the rig with control and writes its token there (local-enroll.ts). Where the
 * machine has NVIDIA GPUs the rig can have, the command also writes compose.gpu.yaml next to
 * `.dev/` (see machine.ts and writeGpuOverride).
 */

/** The token files made once with a random token: control's, then each rig's harness's. */
export const LOCAL_TOKEN_FILES = [
  "control-admin-token",
  // An operating agent's token for control's MCP (it may steer and message agents, never approve).
  "control-operator-token",
  "harness-supervisor-token",
  "harness-proposer-token",
  "harness2-supervisor-token",
  "harness2-proposer-token",
] as const;

/**
 * The local stack's rigs, each with the file in `secrets/` its supervisor reads its token for
 * control from: made empty, and filled when the stack's enroll step enrolls the rig.
 */
export const LOCAL_RIGS = {
  "local-1": "control-rig-token",
  "local-2": "control-rig-token-2",
} as const;

/** The folders, relative to `.dev/`, which is closed to other users. The inbox's: see below. */
export const LOCAL_FOLDERS = [
  "secrets",
  "inbox/repos",
  "inbox/models",
  "outbox",
  // Advisor configuration and keys (mounted read-only into the supervisors).
  "advisors",
  // Control's backups, which the backup service writes (thermite backup).
  "backups",
] as const;

// The supervisor fetches sources into the inbox as its own user in its container: on native
// Linux that user is not you, so the inbox is open to it, inside the closed `.dev/`.
const OPEN_FOLDERS = ["inbox", "inbox/repos", "inbox/models"];

export interface Owner {
  uid: number;
  gid: number;
}

export interface LocalInitResult {
  /** Paths made by this call, relative to `.dev/`, folders first. */
  made: string[];
  /** Token and key files that were there already, relative to `.dev/`. */
  kept: string[];
}

const token = () => randomBytes(24).toString("base64url");

/**
 * Who should own what `localInit` makes. Run as root (the bundle's `init` service, in a
 * container), files would belong to root; when the folder that holds `.dev/` belongs to someone
 * else, they go to that owner, so the person who downloaded the bundle can read and change them.
 * Otherwise nothing changes hands.
 */
export function chooseOwner(processUid: number | undefined, parent: Owner | undefined) {
  if (processUid !== 0 || !parent) return undefined;
  if (parent.uid === 0 && parent.gid === 0) return undefined;
  return parent;
}

/** The owner of the folder that holds `root`, when it exists. */
export function parentOwner(root: string): Owner | undefined {
  const parent = dirname(root);
  if (!existsSync(parent)) return undefined;
  const s = statSync(parent);
  return { uid: s.uid, gid: s.gid };
}

/** Makes `.dev/` at `root` (keeping what is there) and gives what it made to `owner`, if any. */
export function localInit(root: string, owner?: Owner): LocalInitResult {
  const made: string[] = [];
  const kept: string[] = [];
  const give = (rel: string) => {
    if (owner) chownSync(join(root, rel), owner.uid, owner.gid);
  };
  if (!existsSync(root)) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    made.push(".");
    give(".");
  }
  // `.dev/` is its owner's alone, made now or before: no other user of the computer reaches the
  // tokens, the inbox or the advisors' keys. The containers mount the folders and files below it,
  // so their own users still reach those.
  chmodSync(root, 0o700);
  for (const folder of LOCAL_FOLDERS) {
    // Each step of the path, so that a new `inbox` is given away as well as `inbox/repos`.
    const parts = folder.split("/");
    for (let i = 1; i <= parts.length; i++) {
      const rel = parts.slice(0, i).join("/");
      if (existsSync(join(root, rel))) continue;
      mkdirSync(join(root, rel), { mode: 0o755 });
      made.push(rel);
      give(rel);
    }
  }
  for (const rel of OPEN_FOLDERS) chmodSync(join(root, rel), 0o777);
  const write = (name: string, value: string) => {
    const rel = `secrets/${name}`;
    if (existsSync(join(root, rel))) {
      kept.push(rel);
      return;
    }
    writeFileSync(join(root, rel), value, { mode: 0o644, flag: "wx" });
    made.push(rel);
    give(rel);
  };
  for (const name of LOCAL_TOKEN_FILES) write(name, token());
  // Empty until the stack's enroll step writes the rig's token, which control made.
  for (const name of Object.values(LOCAL_RIGS)) write(name, "");
  // A local model route's key: a placeholder to replace for a real OpenAI-compatible endpoint.
  write("model-api-key", "local-placeholder");
  return { made, kept };
}

/** The folder that holds `.dev/`, through a link to it (a source checkout links the release's). */
const stackDir = (root: string) => dirname(realpathSync(root));

/** The compose file next to `.dev/`, when there is one. */
export function readStackCompose(root: string): string | undefined {
  try {
    return readFileSync(join(stackDir(root), "compose.yaml"), "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Writes compose.gpu.yaml next to `.dev/` (mode 0644), again at every run, as the machine is now,
 * and gives it to `owner` when one is given. Returns its path.
 */
export function writeGpuOverride(root: string, text: string, owner?: Owner): string {
  const path = join(stackDir(root), GPU_OVERRIDE);
  writeFileSync(path, text, { mode: 0o644 });
  chmodSync(path, 0o644);
  if (owner) chownSync(path, owner.uid, owner.gid);
  return path;
}
