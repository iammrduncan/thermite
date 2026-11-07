import type { ControlStore, RunnerUseSample } from "../store/index.ts";
import type { RigView } from "./types.ts";

/**
 * How a rig's runners spent a window of time (goal 231), from control's samples of the core's
 * running totals: each runner's time with the judge, each lane, free and away, its GPU's mean use
 * where it was read, and who waited for a runner and how long. Each sample is set against the one
 * before it of the same life of the core (its `since`); the first of a life against nothing at its
 * start, so a restart of the core loses nothing it reported. A span that starts before the window
 * counts for its part inside it.
 */

/** The windows a rig's page and the tools offer. */
export const USE_WINDOWS = ["hour", "day", "run"] as const;
export type UseWindow = (typeof USE_WINDOWS)[number];

export interface RunnerShare {
  runner: string;
  pool: string;
  judge_ms: number;
  lanes_ms: Record<string, number>;
  free_ms: number;
  away_ms: number;
  /** Its GPU over the window, where its core read it: its mean use, and for how long it was read. */
  gpu: {
    mean_pct: number | null;
    read_ms: number;
    now_pct: number | null;
    at: string | null;
    mem_used_mib: number | null;
    mem_total_mib: number | null;
  } | null;
}

export interface UseView {
  window: UseWindow;
  from: string;
  to: string;
  /** Control's first sample in it: the window's time before had none. */
  first: string | null;
  runners: RunnerShare[];
  /** By whose: `judge` or a lane. */
  waited: Record<string, { count: number; ms: number }>;
}

type Totals = Record<string, number>;

const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) && x >= 0 ? x : 0);

/** A runner's time totals, flat: judge, free, away and `lane:<lane>`. */
function timeOf(use: unknown): { since: string; t: Totals } | undefined {
  const u = (use ?? {}) as Record<string, unknown>;
  if (typeof u.since !== "string") return undefined;
  const t: Totals = { judge: num(u.judge_ms), free: num(u.free_ms), away: num(u.away_ms) };
  const lanes = (u.lanes_ms ?? {}) as Record<string, unknown>;
  for (const [lane, ms] of Object.entries(lanes)) t[`lane:${lane}`] = num(ms);
  return { since: u.since, t };
}

/** The waits' totals, flat: `<whose>:count` and `<whose>:ms`. */
function waitsOf(waited: unknown): Totals {
  const t: Totals = {};
  for (const [k, v] of Object.entries((waited ?? {}) as Record<string, unknown>)) {
    const w = (v ?? {}) as Record<string, unknown>;
    t[`${k}:count`] = num(w.count);
    t[`${k}:ms`] = num(w.ms);
  }
  return t;
}

/**
 * The sum, over a series of one thing's totals at sample times, of what each span added inside
 * [from, …): each against the one before of the same life, or against nothing at its life's start.
 */
function windowSum(series: { at: number; since: number; t: Totals }[], from: number): Totals {
  const out: Totals = {};
  let prev: (typeof series)[number] | undefined;
  for (const b of series) {
    const base = prev && prev.since === b.since ? prev : { at: b.since, t: {} as Totals };
    const span = b.at - base.at;
    const inside = b.at - Math.max(base.at, from);
    if (span > 0 && inside > 0) {
      const f = Math.min(1, inside / span);
      for (const [k, v] of Object.entries(b.t)) {
        const d = v - (base.t[k] ?? 0);
        // A total that fell is a new life the sample did not say: count it from nothing.
        out[k] = (out[k] ?? 0) + f * (d >= 0 ? d : v);
      }
    }
    prev = b;
  }
  return out;
}

export function runnerUse(
  samples: RunnerUseSample[],
  window: UseWindow,
  from: string,
  to: string,
): UseView {
  const start = Date.parse(from);
  const inWindow = samples.filter((s) => Date.parse(s.at) >= start);
  const names = [...new Set(inWindow.flatMap((s) => Object.keys(s.runners)))].sort();
  const runners = names.map((name): RunnerShare => {
    const time: { at: number; since: number; t: Totals }[] = [];
    const gpu: { at: number; since: number; t: Totals }[] = [];
    let pool = "";
    let last: Record<string, unknown> | undefined;
    for (const s of samples) {
      const r = s.runners[name];
      const u = r && timeOf(r.use);
      if (!r || !u) continue;
      pool = r.pool;
      const at = Date.parse(s.at);
      const since = Date.parse(u.since);
      time.push({ at, since, t: u.t });
      const g = (r.gpu ?? undefined) as Record<string, unknown> | undefined;
      if (g) {
        gpu.push({ at, since, t: { busy: num(g.busy_ms), read: num(g.read_ms) } });
        last = g;
      }
    }
    const t = windowSum(time, start);
    const g = windowSum(gpu, start);
    const lanes_ms: Record<string, number> = {};
    for (const [k, v] of Object.entries(t))
      if (k.startsWith("lane:")) lanes_ms[k.slice(5)] = Math.round(v);
    const read = Math.round(g.read ?? 0);
    const n = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : null);
    return {
      runner: name,
      pool,
      judge_ms: Math.round(t.judge ?? 0),
      lanes_ms,
      free_ms: Math.round(t.free ?? 0),
      away_ms: Math.round(t.away ?? 0),
      gpu: last
        ? {
            mean_pct: read > 0 ? Math.round((1000 * (g.busy ?? 0)) / read) / 10 : null,
            read_ms: read,
            now_pct: n(last.util_pct),
            at: typeof last.at === "string" ? last.at : null,
            mem_used_mib: n(last.mem_used_mib),
            mem_total_mib: n(last.mem_total_mib),
          }
        : null,
    };
  });
  const waits = windowSum(
    samples.flatMap((s) =>
      typeof s.waited_since === "string"
        ? [{ at: Date.parse(s.at), since: Date.parse(s.waited_since), t: waitsOf(s.waited) }]
        : [],
    ),
    start,
  );
  const waited: UseView["waited"] = {};
  for (const [k, v] of Object.entries(waits)) {
    const [who, what] = [k.slice(0, k.lastIndexOf(":")), k.slice(k.lastIndexOf(":") + 1)];
    const w = waited[who] ?? { count: 0, ms: 0 };
    if (what === "count") w.count = Math.round(v);
    else w.ms = Math.round(v);
    waited[who] = w;
  }
  return { window, from, to, first: inWindow[0]?.at ?? null, runners, waited };
}

/** A window's name as a page's query or a tool gives it; the last hour by default. */
export function useWindowOf(v: unknown): UseWindow {
  return (USE_WINDOWS as readonly unknown[]).includes(v) ? (v as UseWindow) : "hour";
}

/** When the rig's newest run began: its running one's, else its newest's. */
export function newestRunStart(u: Pick<RigView, "runs">): string | undefined {
  const starts = (rs: RigView["runs"]) =>
    rs.flatMap((r) => (r.created_at ? [r.created_at] : [])).sort();
  return starts(u.runs.filter((r) => r.status === "running")).at(-1) ?? starts(u.runs).at(-1);
}

/**
 * A rig's runners over a window, from control's samples: the last hour, the last 24 hours, or
 * from `runStarted`, its newest run's start. Undefined: the run's window, with no run.
 */
export function rigRunnerUse(
  store: Pick<ControlStore, "runnerUse">,
  rig: string,
  window: UseWindow,
  now: number,
  runStarted?: string | undefined,
): UseView | undefined {
  const start =
    window === "hour"
      ? now - 3_600_000
      : window === "day"
        ? now - 86_400_000
        : runStarted
          ? Date.parse(runStarted)
          : Number.NaN;
  if (!Number.isFinite(start)) return undefined;
  const from = new Date(start).toISOString();
  return runnerUse(store.runnerUse.samples(rig, from), window, from, new Date(now).toISOString());
}

/**
 * The read MCP's runner_use and REST's `GET /v1/rigs/<rig>/runner-use` give: the window's view,
 * each runner with its shares in percent of the time it reported. Undefined: the run's window on a
 * rig with no run.
 */
export function runnerUseRead(
  store: Pick<ControlStore, "runnerUse">,
  u: RigView,
  window: UseWindow,
  now: number,
) {
  const v = rigRunnerUse(store, u.id, window, now, newestRunStart(u));
  if (!v) return undefined;
  return {
    rig: u.id,
    ...v,
    runners: v.runners.map((r) => {
      const lanes = Object.values(r.lanes_ms).reduce((n, ms) => n + ms, 0);
      const total = r.judge_ms + lanes + r.free_ms + r.away_ms;
      const pct = (ms: number) => (total ? Math.round((1000 * ms) / total) / 10 : 0);
      return {
        ...r,
        reported_ms: total,
        shares: {
          judge: pct(r.judge_ms),
          lanes: Object.fromEntries(Object.entries(r.lanes_ms).map(([l, ms]) => [l, pct(ms)])),
          idle: pct(r.free_ms),
          away: pct(r.away_ms),
        },
      };
    }),
  };
}
