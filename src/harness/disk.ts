import { type FreeSpace, freeSpace, GIB, gib } from "../common/disk.ts";
import { errorText } from "../common/errors.ts";
import { log } from "../common/log.ts";
import type { RigDisk } from "../core/health.ts";
import { type Ledger, LedgerError } from "./ledger/index.ts";

/**
 * The rig's disk against its floor (goal 173; THERMITE_DISK_FLOOR_GIB): the free space on each
 * place the harness writes to, its state (the ledger, kits, builds, models), its scratch
 * (workspaces, builds under way) and its outbox (exports). Below the floor on any of them, the rig
 * holds new work: no trial, plan, judge's job or export starts, and the work under way ends as it
 * would, so the judge's job in flight still writes its verdict. It goes back to work once each
 * place has 1 GiB more than the floor, so a disk that hovers at the floor does not flap.
 *
 * The ledger records each change as `rig_disk`, the rig's report carries the last reading
 * (`summary.disk`), and control shows it on the rig's page and under Needs you. The exports loop
 * reads the places again every few seconds; nothing here fails, so nothing fails in a loop.
 */
export class DiskWatch {
  private readonly o: {
    ledger: Ledger;
    places: { name: string; path: string }[];
    floorGib: number;
    free: FreeSpace;
    clock: () => Date;
  };
  private last: RigDisk;
  /** Places it could not read, each logged once. */
  private readonly unread = new Set<string>();

  constructor(o: {
    ledger: Ledger;
    places: { name: string; path: string }[];
    /** The floor, in GiB; 0: none. */
    floorGib: number;
    /** The free-space reader (tests give a full disk of their own). */
    free?: FreeSpace | undefined;
    clock?: (() => Date) | undefined;
  }) {
    this.o = { ...o, free: o.free ?? freeSpace, clock: o.clock ?? (() => new Date()) };
    // A floor the ledger left reached (a restart at the floor) holds from the start, until a
    // reading says otherwise.
    const kept = this.o.ledger.events.newest("rig_disk");
    const since = kept?.body.low === true ? kept.at : null;
    this.last = { floor_gib: o.floorGib, low: since !== null, since, checked_at: "", places: [] };
    this.check();
  }

  /** Why the rig holds new work now, in words; undefined while it is above its floor. */
  get held(): string | undefined {
    if (!this.last.low) return undefined;
    const below = this.last.places.filter((p) => p.free_gib < this.o.floorGib);
    const where = (below.length ? below : this.last.places)
      .map((p) => `its ${p.name} has ${p.free_gib} GiB free`)
      .join(", ");
    return `the rig's disk is at its floor of ${this.o.floorGib} GiB (${where}): no new trial, judge's job or export starts until there is room again`;
  }

  /** The last reading, for the rig's report. */
  summary(): RigDisk {
    return { ...this.last, places: this.last.places.map((p) => ({ ...p })) };
  }

  /**
   * Refuses to write `bytes` more where `path` is when that would take its disk below the floor,
   * with the reason: an import the supervisor fetched, before it is copied. A place whose free
   * space can't be read is not refused here (check() logs it).
   */
  refuseBelowFloor(what: string, path: string, bytes: number): void {
    const floor = this.o.floorGib * GIB;
    if (floor <= 0) return;
    let free: number;
    try {
      free = this.o.free(path).free;
    } catch {
      return;
    }
    if (free - bytes < floor)
      throw new LedgerError(
        "conflict",
        `${what} is ${gib(bytes)} GiB, and the rig's disk has ${gib(free)} GiB free with a floor of ${this.o.floorGib} GiB: it is not copied`,
      );
  }

  /** Refuses an export at the floor, with the reason. */
  refuseAtFloor(what: string): void {
    const why = this.held;
    if (why) throw new LedgerError("conflict", `${what} waits: ${why}`);
  }

  /** Reads each place again and records a change: at the floor, or back above it. */
  check(): RigDisk {
    const floor = this.o.floorGib * GIB;
    const places: RigDisk["places"] = [];
    let below = false;
    let roomy = true;
    for (const p of this.o.places) {
      let s: { free: number; total: number };
      try {
        s = this.o.free(p.path);
      } catch (err) {
        if (!this.unread.has(p.name))
          log("harness", "a place's free space can't be read", {
            place: p.name,
            path: p.path,
            error: errorText(err),
          });
        this.unread.add(p.name);
        continue;
      }
      places.push({ name: p.name, free_gib: gib(s.free), total_gib: gib(s.total) });
      if (s.free < floor) below = true;
      if (s.free < floor + GIB) roomy = false;
    }
    const now = this.o.clock().toISOString();
    const was = this.last.low;
    const low = floor > 0 && (was ? !roomy : below);
    this.last = {
      floor_gib: this.o.floorGib,
      low,
      since: low ? (this.last.since ?? now) : null,
      checked_at: now,
      places,
    };
    if (low !== was) {
      const reason = low ? this.held : "there is room again: new work starts";
      this.o.ledger.appendEvent("harness", "rig_disk", null, {
        low,
        floor_gib: this.o.floorGib,
        places,
        ...(reason ? { reason } : {}),
      });
      log("harness", low ? "the disk is at its floor" : "the disk has room again", {
        floor_gib: this.o.floorGib,
        places,
      });
    }
    return this.summary();
  }
}
