import { dirname } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { freeSpace } from "../../common/disk.ts";
import { errorText } from "../../common/errors.ts";
import type { Loops } from "../../common/health.ts";
import { ResourceUse } from "../../common/usage.ts";
import type { PartUse } from "../../core/hardware.ts";
import type { LoopAges } from "../../core/health.ts";
import type { BuildInfo } from "../../core/version.ts";
import type { BusView } from "../bus/index.ts";
import { controlDiskOf } from "../disk.ts";
import { type SpaceKind, spaceKindOf, spaceOf } from "../space.ts";
import type { ControlStore, DbFigures } from "../store/index.ts";
import type { BusFigures } from "./bus.ts";

/**
 * Control itself as Metrics' Control and Storage tabs show it (goal 179): its process's CPU and
 * memory against its container's limits, its event loop's delay and its loops; and where its state
 * sits, in memory and on disk, each place with its used and available space, with control.db's
 * tables as SQLite counts them.
 */

/** The time the event loop's delay is measured over: it starts again after each such window. */
const LOOP_DELAY_WINDOW_MS = 60_000;
/** How many readings of control's CPU and memory it keeps, one each HISTORY_STEP_MS at most. */
const HISTORY_READINGS = 90;
const HISTORY_STEP_MS = 2000;
/** How long a measure of control.db's tables stays the answer: SQLite reads every page for it. */
const DB_LOOK_MS = 5 * 60_000;

export interface ControlFigures {
  at: string;
  use: PartUse;
  /** Node's own count of the process's memory. */
  memory: {
    rss: number;
    heap_used: number;
    heap_total: number;
    external: number;
    array_buffers: number;
  };
  /** How late the event loop ran its work, in milliseconds, since `since`. */
  event_loop: { mean_ms: number; p99_ms: number; max_ms: number; since: string };
  started_at: string;
  node: string;
  build: BuildInfo;
  ok: boolean;
  loops: LoopAges;
  /** Its last readings, oldest first: CPUs busy and memory in use, for the tab's small charts. */
  history: { at: string; cpu: number | null; memory_bytes: number }[];
}

const ms = (ns: number) => Math.round((Number.isFinite(ns) ? ns : 0) / 1e4) / 100;

/** Control's process, read at each ask; the event loop's delay over the last window. */
export class ControlLook {
  private readonly use = new ResourceUse();
  private readonly delay = monitorEventLoopDelay({ resolution: 20 });
  private since = 0;
  private readonly history: ControlFigures["history"] = [];
  private readonly o: { loops: Loops; build: BuildInfo };

  constructor(o: { loops: Loops; build: BuildInfo }) {
    this.o = o;
  }

  /** The figures now. The event loop is measured from the first ask on, not before it. */
  read(now = Date.now()): ControlFigures {
    if (!this.since) {
      this.delay.enable();
      this.since = now;
    }
    const m = process.memoryUsage();
    const health = this.o.loops.health();
    const use = this.use.read();
    const last = this.history.at(-1);
    if (!last || now - Date.parse(last.at) >= HISTORY_STEP_MS) {
      this.history.push({ at: use.at, cpu: use.cpu, memory_bytes: use.memory_bytes });
      if (this.history.length > HISTORY_READINGS) this.history.shift();
    }
    const figures: ControlFigures = {
      at: new Date(now).toISOString(),
      use,
      memory: {
        rss: m.rss,
        heap_used: m.heapUsed,
        heap_total: m.heapTotal,
        external: m.external,
        array_buffers: m.arrayBuffers,
      },
      event_loop: {
        mean_ms: ms(this.delay.mean),
        p99_ms: ms(this.delay.percentile(99)),
        max_ms: ms(this.delay.max),
        since: new Date(this.since).toISOString(),
      },
      started_at: new Date(Math.round(now - process.uptime() * 1000)).toISOString(),
      node: process.version,
      build: this.o.build,
      ok: health.ok,
      loops: health.loops,
      history: [...this.history],
    };
    if (now - this.since >= LOOP_DELAY_WINDOW_MS) {
      this.delay.reset();
      this.since = now;
    }
    return figures;
  }

  close(): void {
    this.delay.disable();
  }
}

// ---------------------------------------------------------------- storage

/** A place that holds state: what it uses, what it may still use, and its size, in bytes. */
export interface Place {
  name: string;
  used: number;
  /** What it may still use; null where nothing says (a process with no limit). */
  available: number | null;
  total: number | null;
  /** What sets its size, in words. */
  of: string;
}

export interface StorageFigures {
  at: string;
  memory: Place[];
  disk: Place[];
  /** What each kind of state control keeps takes on disk (Settings › Space), each counted once. */
  kinds: { kind: SpaceKind; label: string; bytes: number | null; error?: string }[];
  /** Each stream's bytes in the bus's store. */
  streams: { name: string; bytes: number }[];
  db: DbFigures | null;
  db_error: string | null;
  /** Control's disk floor: new runs wait below it. Null where control watches no disk. */
  floor: { floor_gib: number; low: boolean } | null;
}

/** Each store's last measure of control.db, and when. */
const DB_LOOKS = new WeakMap<ControlStore, DbFigures>();

/** control.db's figures from the measure of the last DB_LOOK_MS, or a new one. */
function keptDbFigures(store: ControlStore, now = Date.now()): DbFigures {
  const kept = DB_LOOKS.get(store);
  if (kept && now - Date.parse(kept.at) < DB_LOOK_MS) return kept;
  const fresh = store.size.measure(now);
  DB_LOOKS.set(store, fresh);
  return fresh;
}

/** Where control's state sits now, in memory and on disk, with its used and available space. */
export async function storageFigures(o: {
  store: ControlStore;
  bus: BusView | undefined;
  control: ControlFigures;
  busFigures: BusFigures;
  now?: number;
}): Promise<StorageFigures> {
  const now = o.now ?? Date.now();
  const use = o.control.use;
  const limit = use.memory_limit_bytes;
  const server = o.busFigures.server;
  const js = server?.jetstream ?? null;
  const memory: Place[] = [
    {
      name: "control",
      used: use.memory_bytes,
      available: limit === null ? null : Math.max(0, limit - use.memory_bytes),
      total: limit,
      of:
        use.of === "container"
          ? limit === null
            ? "its container, with no memory limit"
            : "its container's memory limit"
          : "its own process: control runs in no container",
    },
  ];
  if (server)
    memory.push({
      name: "the bus's server",
      used: server.memory_bytes,
      available: null,
      total: null,
      of: "its process: the server does not know its container's limit",
    });
  if (js)
    memory.push({
      name: "streams kept in memory",
      used: js.memory_bytes,
      available: Math.max(0, js.memory_max - js.memory_bytes),
      total: js.memory_max,
      of: "JetStream's memory store, against its limit",
    });
  const disk: Place[] = [];
  if (o.store.path !== ":memory:") {
    try {
      const f = freeSpace(dirname(o.store.path));
      disk.push({
        name: "control's state folder",
        used: Math.max(0, f.total - f.free),
        available: f.free,
        total: f.total,
        of: "the disk that holds it",
      });
    } catch (err) {
      disk.push({
        name: "control's state folder",
        used: 0,
        available: null,
        total: null,
        of: errorText(err),
      });
    }
  }
  if (js)
    disk.push({
      name: "the bus's store",
      used: js.store_bytes,
      available: Math.max(0, js.store_max - js.store_bytes),
      total: js.store_max,
      of: "JetStream's file store, against its limit",
    });
  let db: DbFigures | null = null;
  let dbError: string | null = null;
  try {
    db = keptDbFigures(o.store, now);
  } catch (err) {
    dbError = errorText(err);
  }
  // Control's own kinds, each once: a kind inside control.db (inStore) is in the store's bytes.
  const kinds = (await spaceOf(o.store, o.bus, now))
    .filter((k) => spaceKindOf(k.kind).on === "Control" && !spaceKindOf(k.kind).inStore)
    .map((k) => ({
      kind: k.kind,
      label: spaceKindOf(k.kind).label,
      bytes: k.bytes,
      ...(k.error ? { error: k.error } : {}),
    }));
  const floor = controlDiskOf(o.store)?.state();
  return {
    at: new Date(now).toISOString(),
    memory,
    disk,
    kinds,
    streams: o.busFigures.streams.map((s) => ({ name: s.name, bytes: s.bytes })),
    db,
    db_error: dbError,
    floor: floor ? { floor_gib: floor.floor_gib, low: floor.low } : null,
  };
}
