import { basename, dirname, isAbsolute, relative, sep } from "node:path";
import { readNumber } from "../../../common/settings.ts";
import { oneContainer, supervisorPaths } from "../one-container.ts";
import { IDS } from "../runner.ts";
import { BROKER_NUMBERS } from "../settings.ts";

/**
 * What a snapshot holds and where: the parts of the live state, each with its owner (snapshotAreas);
 * the names in the snapshot folder; whether a layout can be used at all; and what a snapshot leaves
 * out of a part.
 */

type Env = Record<string, string | undefined>;

/** The parts of the rig's state a snapshot holds, by their names in it. */
export const AREA_NAMES = ["harness", "outbox", "inbox", "supervisor", "secrets"] as const;
export type AreaName = (typeof AREA_NAMES)[number];

/** One part of the live state: where it is, and the owner everything in it has. */
export interface SnapshotArea {
  name: AreaName;
  /** Its live folder, on the container's own disk. */
  live: string;
  uid: number;
  gid: number;
  /** Only this file at its top (the secrets folder: root's copy of the supervisor's token). */
  only?: string | undefined;
}

/** The names in the snapshot folder: the manifest, and the one being written. */
export const SEALED = { manifest: "manifest", next: "manifest.new" } as const;
/** A sealed file: the keyed hash of its content, in hexadecimal. */
export const SEALED_FILE = /^[0-9a-f]{64}$/;
/** A sealed file being written. */
export const SEALING_FILE = /^\.new-[0-9a-f]{32}$/;
/** What a user's probe of the folder makes, empty, and removes again. */
export const PROBE_FILE = /^probe-\d+$/;
/** The folders an image before sealing kept its snapshot in, unsealed. */
export const UNSEALED_DIRS: readonly string[] = ["snapshot", "snapshot.new", "snapshot.old"];
/** The ledger, in the harness's state folder. */
export const LEDGER_FILE = "ledger/ledger.db";
/** The broker's record of the snapshot folder, next to its socket, for the isolation selftest. */
export const SNAPSHOT_RECORD = "snapshot.json";

/** THERMITE_STATE_SNAPSHOT_DIR, or none: no snapshot (compose and Kubernetes rigs). */
export function snapshotDir(env: Env): string | undefined {
  return env.THERMITE_STATE_SNAPSHOT_DIR || undefined;
}

/**
 * The parts a snapshot holds: the harness's state and the outbox; in the one-container rig image
 * also the inbox, the supervisor's state (its pull mode keys and enrollment among it) and root's
 * copy of the supervisor's token. Each with the owner the broker gives it at a start.
 */
export function snapshotAreas(env: Env): SnapshotArea[] {
  const t = IDS.thermite;
  const areas: SnapshotArea[] = [
    {
      name: "harness",
      live: env.THERMITE_STATE_DIR ?? "/var/lib/thermite",
      uid: t.uid,
      gid: t.gid,
    },
    {
      name: "outbox",
      live: env.THERMITE_OUTBOX_DIR ?? "/outbox",
      uid: t.uid,
      gid: readNumber(env, BROKER_NUMBERS.outboxGid),
    },
  ];
  if (oneContainer(env)) {
    const p = supervisorPaths(env);
    const s = IDS.supervisor;
    areas.push(
      { name: "inbox", live: p.inbox, uid: s.uid, gid: t.gid },
      { name: "supervisor", live: p.home, uid: s.uid, gid: s.gid },
    );
    const token = env.THERMITE_SUPERVISOR_TOKEN_FILE;
    if (token)
      areas.push({ name: "secrets", live: dirname(token), uid: 0, gid: 0, only: basename(token) });
  }
  return areas;
}

const within = (path: string, folder: string): boolean => {
  const r = relative(folder, path);
  return r === "" || (r !== ".." && !r.startsWith(`..${sep}`) && !isAbsolute(r));
};

/**
 * What makes this layout unusable, or nothing: the live folders must stay out of the snapshot
 * folder (so nothing the broker gives an owner is ever on the volume), and apart from each other.
 */
export function layoutProblem(dir: string, areas: readonly SnapshotArea[]): string | undefined {
  if (!isAbsolute(dir)) return `THERMITE_STATE_SNAPSHOT_DIR must be an absolute path, not ${dir}`;
  for (const a of areas) {
    if (!isAbsolute(a.live)) return `the ${a.name} folder ${a.live} is not an absolute path`;
    if (within(a.live, dir))
      return `the ${a.name} folder ${a.live} is in the snapshot folder ${dir}: the live state must stay on the container's own disk`;
    if (within(dir, a.live))
      return `the snapshot folder ${dir} is in the ${a.name} folder ${a.live}`;
    for (const b of areas)
      if (a !== b && within(a.live, b.live))
        return `the ${a.name} folder ${a.live} is in the ${b.name} folder ${b.live}`;
  }
  return undefined;
}

/**
 * What a snapshot never holds: the ledger's write-ahead files (the ledger itself is copied with
 * SQLite's backup), exports still being written (dot names in the outbox), the supervisor's
 * temporary folder and its copy of the token (root writes it again at every start), and anything
 * in the secrets folder but the token.
 */
export function leftOut(area: SnapshotArea, rel: string): boolean {
  if (rel === "") return false;
  const top = rel.split("/")[0] as string;
  switch (area.name) {
    case "harness":
      return [`${LEDGER_FILE}-wal`, `${LEDGER_FILE}-shm`, `${LEDGER_FILE}-journal`].includes(rel);
    case "outbox":
      return top.startsWith(".");
    case "supervisor":
      return top === "tmp" || rel === "harness-token";
    case "secrets":
      return rel !== area.only;
    default:
      return false;
  }
}

/** A path in a snapshot: names joined by "/", never empty, "." or "..". "" is the area's folder. */
export function safeRel(rel: string): boolean {
  if (rel === "") return true;
  if (rel.includes("\0") || rel.length > 4096) return false;
  return rel.split("/").every((s) => s !== "" && s !== "." && s !== "..");
}
