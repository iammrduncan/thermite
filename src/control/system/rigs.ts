import type { BusReach } from "../../core/api/control/bus.ts";
import { type PartUse, readPartUse } from "../../core/hardware.ts";
import { busReach } from "../bus/index.ts";
import type { ControlStore } from "../store/index.ts";
import { podStopped, type RigView } from "../views/index.ts";

/**
 * Each rig as Metrics' Rigs tab shows it (goal 179): its harness's and its supervisor's CPU and
 * memory, as each last reported them (the harness in its report's summary, the supervisor in its
 * figures), its CPUs and memory limit, its free disk against its floor, and its connection to the
 * bus. A rig whose parts are older than this control reports no use: its row says so.
 */

export interface RigFigures {
  rig: string;
  state: RigView["state"];
  last_seen: string;
  harness: PartUse | null;
  supervisor: PartUse | null;
  /** The CPUs and the memory limit its harness found at its start. */
  cpus: number | null;
  memory_limit_mib: number | null;
  /** Each place its harness writes to, as last read, and its floor. */
  disks: { name: string; free_gib: number; total_gib: number }[];
  disk_floor_gib: number | null;
  bus: BusReach;
}

/** A report's disk summary, read loosely. */
function diskOf(x: unknown): { places: RigFigures["disks"]; floor: number | null } {
  const d = x as { places?: unknown; floor_gib?: unknown } | null | undefined;
  const places = Array.isArray(d?.places)
    ? d.places.filter(
        (p): p is RigFigures["disks"][number] =>
          typeof p?.name === "string" &&
          typeof p?.free_gib === "number" &&
          typeof p?.total_gib === "number",
      )
    : [];
  return { places, floor: typeof d?.floor_gib === "number" ? d.floor_gib : null };
}

/** Each rig control knows, from its last report. */
export function rigFigures(
  store: ControlStore,
  views: readonly RigView[],
  now = Date.now(),
): RigFigures[] {
  return views
    .map((v) => {
      const summary = v.summary as { usage?: unknown; disk?: unknown } | null | undefined;
      const disk = diskOf(summary?.disk);
      return {
        rig: v.id,
        state: v.state,
        last_seen: v.last_seen,
        harness: readPartUse(summary?.usage),
        supervisor: readPartUse(v.supervisor?.usage),
        cpus: v.hardware ? (v.hardware.cpu.quota ?? v.hardware.cpu.usable) : null,
        memory_limit_mib: v.hardware?.memory.limit_mib ?? null,
        disks: disk.places,
        disk_floor_gib: disk.floor,
        bus: busReach(store, v.id, { lastSeen: v.last_seen, now, podStopped: podStopped(v) }),
      };
    })
    .sort((a, b) => a.rig.localeCompare(b.rig));
}
