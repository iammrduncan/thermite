import { type FreeSpace, freeSpace, GIB, gib } from "../common/disk.ts";
import { log } from "../common/env.ts";
import { errorText } from "../common/errors.ts";
import type { BusStoreUse } from "./bus/index.ts";
import type { ControlStore } from "./store/index.ts";

/**
 * Control's disk floor (goal 173): the free space of control's state folder, and the room left in
 * the message bus's store (its limit less what JetStream uses, from the server's monitoring),
 * against THERMITE_DISK_FLOOR_GIB, as a rig keeps its own. At the floor control holds new
 * assignments, each refused with the reason; says so under Needs you and in its health, degraded
 * and not down; and drops nothing: reports, commands and the runs under way go on, and a store
 * that is full refuses a report for now, which its rig sends again. It lets go once each place has
 * 1 GiB more than the floor, so a disk that hovers at it does not flap. Each change is a line in
 * the audit log.
 */

/** One place control writes to: its free space and its size, in GiB. */
export interface ControlDiskPlace {
  name: "state" | "bus store";
  free_gib: number;
  total_gib: number;
}

/** Control's disk, as its last look found it. */
export interface ControlDiskState {
  /** The floor, in GiB; 0: none. */
  floor_gib: number;
  low: boolean;
  /** When it reached the floor; null while above it. */
  since: string | null;
  /** When it last looked; null before its first look. */
  checked_at: string | null;
  places: ControlDiskPlace[];
  /** The places it could not read at its last look, with why. */
  unread: { name: string; error: string }[];
}

/** How often control looks at its disk. */
export const CONTROL_DISK_CHECK_MS = 60_000;

/** The watch of each store's control, where one was made: every path that issues has the store. */
const watched = new WeakMap<ControlStore, ControlDisk>();

/** Control's disk floor, kept beside its store; undefined where control made no watch, as in a test. */
export function controlDiskOf(store: ControlStore): ControlDisk | undefined {
  return watched.get(store);
}

/** "state 40.2 of 100 GiB free · bus store 3.1 of 10 GiB free": each place, in words. */
export const controlPlacesWords = (d: Pick<ControlDiskState, "places">): string =>
  d.places.map((p) => `${p.name} ${p.free_gib} of ${p.total_gib} GiB free`).join(" · ");

export interface ControlDiskOptions {
  store: ControlStore;
  /** Control's state folder (THERMITE_CONTROL_DIR). */
  stateDir: string;
  /** The floor, in GiB; 0: none. */
  floorGib: number;
  /** The free-space reader (a test gives a full disk of its own). */
  free?: FreeSpace | undefined;
  /** The bus's store's use and limit; none: control does not look at it. */
  busStore?: (() => Promise<BusStoreUse>) | undefined;
  clock?: (() => Date) | undefined;
}

export class ControlDisk {
  private readonly o: ControlDiskOptions & { free: FreeSpace; clock: () => Date };
  private last: ControlDiskState;
  /** Why each place was last unread, so that a failure is logged once until it changes. */
  private readonly told = new Map<string, string>();

  constructor(o: ControlDiskOptions) {
    this.o = { ...o, free: o.free ?? freeSpace, clock: o.clock ?? (() => new Date()) };
    this.last = {
      floor_gib: o.floorGib,
      low: false,
      since: null,
      checked_at: null,
      places: [],
      unread: [],
    };
    watched.set(o.store, this);
  }

  /** The last look's reading. */
  state(): ControlDiskState {
    return { ...this.last, places: this.last.places.map((p) => ({ ...p })) };
  }

  /** Why control holds new assignments now, in words; undefined while it is above its floor. */
  get held(): string | undefined {
    if (!this.last.low) return undefined;
    const floor = this.o.floorGib;
    const below = this.last.places.filter((p) => p.free_gib < floor);
    const where = (below.length ? below : this.last.places)
      .map((p) =>
        p.name === "state"
          ? `its state folder has ${p.free_gib} GiB free`
          : `the bus's store has ${p.free_gib} GiB left of its ${p.total_gib} GiB`,
      )
      .join(", and ");
    return `Control's disk is at its floor of ${floor} GiB: ${where}. No new run starts until there is room: free space there, or raise the bus's store (THERMITE_NATS_STORE). Reports, commands and the runs under way go on.`;
  }

  /** Reads each place again and records a change: at the floor, or back above it. */
  async check(): Promise<ControlDiskState> {
    const floor = this.o.floorGib * GIB;
    const places: ControlDiskPlace[] = [];
    const unread: ControlDiskState["unread"] = [];
    const read = async (
      name: ControlDiskPlace["name"],
      how: () => Promise<{ free: number; total: number }>,
    ) => {
      try {
        const s = await how();
        places.push({ name, free_gib: gib(s.free), total_gib: gib(s.total) });
        this.told.delete(name);
        return s.free;
      } catch (err) {
        const error = errorText(err);
        unread.push({ name, error });
        if (this.told.get(name) !== error)
          log("control", "a place's free space can't be read", { place: name, error }, "warn");
        this.told.set(name, error);
        return undefined;
      }
    };
    const frees: (number | undefined)[] = [
      await read("state", async () => this.o.free(this.o.stateDir)),
    ];
    const busStore = this.o.busStore;
    if (busStore)
      frees.push(
        await read("bus store", async () => {
          const u = await busStore();
          return { free: Math.max(0, u.limit - u.used), total: u.limit };
        }),
      );
    const known = frees.filter((f): f is number => f !== undefined);
    const now = this.o.clock().toISOString();
    const was = this.last.low;
    // Held below the floor; let go once every place has 1 GiB more, each read. No reading at all
    // changes nothing.
    let low: boolean;
    if (floor <= 0) low = false;
    else if (!known.length) low = was;
    else if (was) low = known.length < frees.length || known.some((f) => f < floor + GIB);
    else low = known.some((f) => f < floor);
    this.last = {
      floor_gib: this.o.floorGib,
      low,
      since: low ? (this.last.since ?? now) : null,
      checked_at: now,
      places,
      unread,
    };
    if (low !== was) {
      const what = { floor_gib: this.o.floorGib, places };
      log(
        "control",
        low ? "control's disk is at its floor" : "control's disk has room again",
        what,
        low ? "warn" : "info",
      );
      try {
        this.o.store.auditLog.add("control", low ? "disk_low" : "disk_room", {
          ...what,
          ...(low ? { held: this.held } : {}),
        });
      } catch (err) {
        // A store whose disk is full may refuse the line: the log above keeps it.
        log("control", "the disk's change not in the audit log", { error: errorText(err) }, "warn");
      }
    }
    return this.state();
  }
}
