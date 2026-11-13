import type { DatabaseSync } from "node:sqlite";
import { type Row, StorePart } from "./part.ts";

/**
 * How a rig's runners of other machines spent their time, as control keeps it (goal 231): a
 * sample of the rig core's running totals at most once a minute, from its reports, for each
 * runner its time with the judge, each lane, free and away, and its GPU's use; and who waited.
 * A restart of the core starts its totals again: the samples keep their history across it.
 * Samples go after RUNNER_USE_DAYS.
 */

/** How long control keeps the samples: a day's window, and a run of a week. */
const RUNNER_USE_DAYS = 8;
/** At most one sample of a rig in this time. */
const SAMPLE_EVERY_MS = 60_000;

/** One sample: the rig's report's runners, their totals alone. */
export interface RunnerUseSample {
  at: string;
  /** By runner: its pool, its totals and its GPU's, as the core reported them. */
  runners: Record<string, { pool: string; use: unknown; gpu?: unknown }>;
  /** Who waited, since the core's pools began (`waited_since`). */
  waited?: unknown;
  waited_since?: string;
}

/** Made by the store's migration to schema version 36. */
export function runnerUseTable(db: DatabaseSync): void {
  db.exec(`create table if not exists runner_use (
  rig text not null,
  at text not null,
  body text not null,
  primary key (rig, at)
)`);
}

/** A report's runners as a sample, or undefined: a core that reports no totals (older). */
function sampleOf(summary: unknown, at: string): RunnerUseSample | undefined {
  const r = (summary as { runners?: Record<string, unknown> } | undefined)?.runners;
  const processes = Array.isArray(r?.processes) ? (r.processes as Record<string, unknown>[]) : [];
  const runners: RunnerUseSample["runners"] = {};
  for (const p of processes)
    for (const x of Array.isArray(p?.runners) ? (p.runners as Record<string, unknown>[]) : [])
      if (typeof x?.name === "string" && x.use && typeof x.use === "object")
        runners[x.name] = {
          pool: String(x.pool ?? ""),
          use: x.use,
          ...(x.gpu && typeof x.gpu === "object" ? { gpu: x.gpu } : {}),
        };
  if (!Object.keys(runners).length) return undefined;
  return {
    at,
    runners,
    ...(r?.waited && typeof r.waited === "object" ? { waited: r.waited } : {}),
    ...(typeof r?.waited_since === "string" ? { waited_since: r.waited_since } : {}),
  };
}

export interface RunnerUse {
  /** A rig's report: its runners' totals, kept unless the rig's newest sample is under a minute. */
  note(rig: string, summary: unknown, now: string): Promise<void>;
  /** A rig's samples from `from` on, oldest first, with the newest one before it. */
  samples(rig: string, from: string): Promise<RunnerUseSample[]>;
}

/** RunnerUse on SQLite: each call answers at once (the store behind the interface, sqlite.ts). */
export class SqliteRunnerUse extends StorePart {
  /** A rig's report: its runners' totals, kept unless the rig's newest sample is under a minute. */
  note(rig: string, summary: unknown, now: string): void {
    const s = sampleOf(summary, now);
    if (!s) return;
    const last = this.db.prepare("select max(at) as at from runner_use where rig = ?").get(rig) as
      | Row
      | undefined;
    if (last?.at && Date.parse(now) - Date.parse(String(last.at)) < SAMPLE_EVERY_MS) return;
    const { at, ...body } = s;
    this.db
      .prepare("insert or replace into runner_use (rig, at, body) values (?, ?, ?)")
      .run(rig, at, JSON.stringify(body));
    const floor = new Date(Date.parse(now) - RUNNER_USE_DAYS * 86_400_000).toISOString();
    this.db.prepare("delete from runner_use where rig = ? and at < ?").run(rig, floor);
  }

  /** A rig's samples from `from` on, oldest first, with the newest one before it. */
  samples(rig: string, from: string): RunnerUseSample[] {
    const read = (r: Row): RunnerUseSample => ({
      at: String(r.at),
      ...(JSON.parse(String(r.body)) as Omit<RunnerUseSample, "at">),
    });
    const before = this.db
      .prepare("select at, body from runner_use where rig = ? and at < ? order by at desc limit 1")
      .get(rig, from) as Row | undefined;
    const rows = this.db
      .prepare("select at, body from runner_use where rig = ? and at >= ? order by at")
      .all(rig, from) as Row[];
    return [...(before ? [read(before)] : []), ...rows.map(read)];
  }
}
