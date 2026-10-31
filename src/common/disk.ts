import { statfsSync } from "node:fs";
import type { NumberSpec } from "./settings.ts";

/**
 * A rig's disk floor (goal 173): the free space a rig keeps on each place it writes to. Before an
 * export, a judge's build, a snapshot of its state and a model download, the part that writes
 * checks the place against it; at the floor the rig holds that work, says why, and tries again
 * later, never in a loop of failures. The harness, its broker and the supervisor read it, each
 * through its own table.
 *
 * 5 GiB by default: an export copies the whole ledger into the outbox (`vacuum into`) and a judge's
 * build writes the candidate's build tree, each up to a few GiB on a large run, and the ledger must
 * keep room to commit, so that the judge's job in flight still writes its verdict. 0 turns it off.
 */
export const DISK_FLOOR: NumberSpec & { fallback: number } = {
  name: "THERMITE_DISK_FLOOR_GIB",
  rule: { unit: "GiB", zeroMeans: "no floor" },
  fallback: 5,
};

export const GIB = 2 ** 30;

/** Free and total bytes for an unprivileged user on the file system that holds `path`. */
export type FreeSpace = (path: string) => { free: number; total: number };

export const freeSpace: FreeSpace = (path) => {
  const s = statfsSync(path);
  return { free: Number(s.bavail) * Number(s.bsize), total: Number(s.blocks) * Number(s.bsize) };
};

/** Bytes as GiB with one decimal, as reports and pages give them. */
export const gib = (bytes: number): number => Math.round((bytes / GIB) * 10) / 10;
