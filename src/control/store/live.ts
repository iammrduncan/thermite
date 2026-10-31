import { log } from "../../common/env.ts";
import { errorText } from "../../common/errors.ts";
import { MAX_LANES } from "../../core/contract.ts";
import type { LiveEntry } from "../../core/live.ts";
import { type Row, StorePart } from "./part.ts";

/**
 * Each rig's live log (goal 125, T6): the lines its trials, planner, judge and supervisor write,
 * and the stuck trials the owner left running (goal 143).
 */

/** How many of each open trial's newest live lines control keeps past the rig's window. */
export const OPEN_TRIAL_LINES = 400;

/** How many stuck trials left running control remembers (goal 143); a trial ends in hours. */
const TRIALS_LEFT_MAX = 1000;

/** One run's lines on its rig: its own, and the judge's and the supervisor's that name no run. */
const OF_RUN = "(run = ? or (run is null and source in ('judge', 'supervisor')))";

export class LiveLines extends StorePart {
  /** Told of each rig that has new lines, once they are stored: the Live pages' pushes. */
  private readonly watchers = new Set<(rig: string) => void>();

  /** Tells `fn` each time a rig has new lines, until the function it returns is called. */
  watch(fn: (rig: string) => void): () => void {
    this.watchers.add(fn);
    return () => {
      this.watchers.delete(fn);
    };
  }

  /**
   * Stores live-log lines (duplicates by log id and sequence are ignored) and keeps only the
   * newest `keep` lines of the rig, and each open trial's newest OPEN_TRIAL_LINES: a trial that
   * writes many lines can't push out another's (goal 143). The open trials are those the rig's
   * last report lists. Then tells the watchers, when it stored any.
   */
  add(rig: string, logId: string, entries: LiveEntry[], signed: boolean, keep = 20_000): number {
    const added = this.keepLines(rig, logId, entries, signed, keep);
    if (!added) return added;
    for (const fn of this.watchers) {
      try {
        fn(rig);
      } catch (err) {
        log(
          "control",
          "a watcher of the live view failed",
          { rig, error: errorText(err) },
          "error",
        );
      }
    }
    return added;
  }

  private keepLines(
    rig: string,
    logId: string,
    entries: LiveEntry[],
    signed: boolean,
    keep: number,
  ): number {
    const now = new Date().toISOString();
    return this.tx(() => {
      const insert = this.db.prepare(
        `insert or ignore into rig_live (rig, log_id, seq, at, source, kind, text, lane, run, signed, received_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      let added = 0;
      for (const e of entries) {
        added += Number(
          insert.run(
            rig,
            logId,
            e.seq,
            e.at,
            e.source,
            e.kind,
            e.text,
            e.lane ?? null,
            e.run ?? null,
            signed ? 1 : 0,
            now,
          ).changes,
        );
      }
      const cut = this.db
        .prepare("select id from rig_live where rig = ? order by id desc limit 1 offset ?")
        .get(rig, keep) as { id: number } | undefined;
      if (!cut) return added;
      // Each open trial's newest lines stay, from the oldest of them on.
      const kept = this.openTrialSources(rig).map((source) => {
        const oldest = this.db
          .prepare(
            "select id from rig_live where rig = ? and source = ? order by id desc limit 1 offset ?",
          )
          .get(rig, source, OPEN_TRIAL_LINES - 1) as { id: number } | undefined;
        return { source, from: oldest?.id ?? 0 };
      });
      this.db
        .prepare(
          `delete from rig_live where rig = ? and id <= ?${kept.map(() => " and not (source = ? and id >= ?)").join("")}`,
        )
        .run(rig, cut.id, ...kept.flatMap((k) => [k.source, k.from]));
      return added;
    });
  }

  /**
   * The owner leaves a stuck trial running (goal 143): its card stays away while it is stuck
   * since the same time. Keeps the newest TRIALS_LEFT_MAX of them.
   */
  leaveTrial(o: { rig: string; trial: string; kind: string; since: string; by: string }): void {
    this.tx(() => {
      this.db
        .prepare(
          `insert into trial_left (rig, trial, kind, since, at, by) values (?, ?, ?, ?, ?, ?)
           on conflict (rig, trial, kind) do update set since = excluded.since, at = excluded.at, by = excluded.by`,
        )
        .run(o.rig, o.trial, o.kind, o.since, new Date().toISOString(), o.by);
      this.db
        .prepare(
          "delete from trial_left where rowid not in (select rowid from trial_left order by at desc limit ?)",
        )
        .run(TRIALS_LEFT_MAX);
    });
  }

  /** Since when the trial was stuck when the owner left it running; null: never left. */
  trialLeft(rig: string, trial: string, kind: string): string | null {
    const r = this.db
      .prepare("select since from trial_left where rig = ? and trial = ? and kind = ?")
      .get(rig, trial, kind) as Row | undefined;
    return r ? String(r.since) : null;
  }

  /** The live sources of the trials the rig's last report lists as open (at most MAX_LANES). */
  private openTrialSources(rig: string): string[] {
    const r = this.db.prepare("select summary from rig where id = ?").get(rig) as Row | undefined;
    if (!r) return [];
    const open = (JSON.parse(String(r.summary)) as { work?: { open?: unknown } }).work?.open;
    if (!Array.isArray(open)) return [];
    return open
      .slice(0, MAX_LANES)
      .flatMap((t) =>
        typeof (t as { trial?: unknown }).trial === "string"
          ? [`trial:${(t as { trial: string }).trial}`]
          : [],
      );
  }

  /** Live lines of a rig after `after` (control's own ids), oldest first; one source if given. */
  after(
    rig: string,
    after: number,
    limit: number,
    source?: string,
  ): (LiveEntry & { id: number; signed: boolean })[] {
    const rows = (
      source
        ? this.db
            .prepare(
              "select * from rig_live where rig = ? and id > ? and source = ? order by id limit ?",
            )
            .all(rig, after, source, limit)
        : this.db
            .prepare("select * from rig_live where rig = ? and id > ? order by id limit ?")
            .all(rig, after, limit)
    ) as Row[];
    return rows.map((r) => ({
      id: Number(r.id),
      seq: Number(r.seq),
      at: String(r.at),
      source: String(r.source),
      kind: String(r.kind) as LiveEntry["kind"],
      text: String(r.text),
      ...(r.lane ? { lane: String(r.lane) } : {}),
      ...(r.run ? { run: String(r.run) } : {}),
      signed: Number(r.signed) === 1,
    }));
  }

  /**
   * One run's live lines after `after`, oldest first: its trials', planner's and judge's lines,
   * plus the judge's and the supervisor's lines that name no run.
   */
  ofRun(
    rig: string,
    run: string,
    after: number,
    limit: number,
    ids?: number[],
  ): (LiveEntry & { id: number; signed: boolean })[] {
    // With ids: only those lines (Live draws again the ones waiting for their event).
    const only = ids?.length ? ` and id in (${ids.map(() => "?").join(",")})` : "";
    const rows = this.db
      .prepare(
        `select * from rig_live where rig = ? and id > ? and ${OF_RUN}${only} order by id limit ?`,
      )
      .all(rig, after, run, ...(ids ?? []), limit) as Row[];
    return rows.map((r) => ({
      id: Number(r.id),
      seq: Number(r.seq),
      at: String(r.at),
      source: String(r.source),
      kind: String(r.kind) as LiveEntry["kind"],
      text: String(r.text),
      ...(r.lane ? { lane: String(r.lane) } : {}),
      ...(r.run ? { run: String(r.run) } : {}),
      signed: Number(r.signed) === 1,
    }));
  }

  /**
   * The supervisor's Live lines about a run's reviews (goal 116), oldest first: each line that
   * starts "review N", such as each reviewer's answer, a failed try's error and the outcome. They
   * are unsigned, and kept only while the rig's live log keeps them (its newest 20,000 lines).
   */
  reviewLines(rig: string, run: string): { review: number; at: string; text: string }[] {
    const rows = this.db
      .prepare(
        `select at, text from rig_live where rig = ? and run = ? and source = 'supervisor'
           and text like 'review %' order by id limit 5000`,
      )
      .all(rig, run) as Row[];
    return rows.flatMap((r) => {
      const m = /^review (\d+)\b/.exec(String(r.text));
      return m ? [{ review: Number(m[1]), at: String(r.at), text: String(r.text) }] : [];
    });
  }

  /** One run's newest live lines, newest last (for the Live page's first view). */
  runTail(
    rig: string,
    run: string,
    limit: number,
  ): (LiveEntry & { id: number; signed: boolean })[] {
    const top = this.db
      .prepare(
        `select id from rig_live where rig = ? and ${OF_RUN} order by id desc limit 1 offset ?`,
      )
      .get(rig, run, limit) as { id: number } | undefined;
    return this.ofRun(rig, run, top?.id ?? 0, limit);
  }

  /** How many of one run's lines there are after `after`, as ofRun reads them. */
  countOfRun(rig: string, run: string, after: number): number {
    const row = this.db
      .prepare(`select count(*) as n from rig_live where rig = ? and id > ? and ${OF_RUN}`)
      .get(rig, after, run) as { n: number };
    return Number(row.n);
  }

  /** How many lines of a rig there are after `after`; of one source if given, as after() reads. */
  count(rig: string, after: number, source?: string): number {
    const row = (
      source
        ? this.db
            .prepare("select count(*) as n from rig_live where rig = ? and id > ? and source = ?")
            .get(rig, after, source)
        : this.db
            .prepare("select count(*) as n from rig_live where rig = ? and id > ?")
            .get(rig, after)
    ) as { n: number };
    return Number(row.n);
  }

  /** The newest live lines of a rig, newest last (for a page's first view). */
  tail(
    rig: string,
    limit: number,
    source?: string,
  ): (LiveEntry & { id: number; signed: boolean })[] {
    const top = this.db
      .prepare(
        source
          ? "select id from rig_live where rig = ? and source = ? order by id desc limit 1 offset ?"
          : "select id from rig_live where rig = ? order by id desc limit 1 offset ?",
      )
      .get(...(source ? [rig, source, limit] : [rig, limit])) as { id: number } | undefined;
    return this.after(rig, top?.id ?? 0, limit, source);
  }

  /** Each live source of a rig with its newest line (sessions to pick from). */
  sources(rig: string): {
    source: string;
    lane: string | null;
    run: string | null;
    last_at: string;
    lines: number;
    ended: boolean;
  }[] {
    return (
      this.db
        .prepare(
          `select source, max(lane) as lane, max(run) as run, max(at) as last_at, count(*) as lines,
             max(case when kind = 'status' and text like 'trial ended%' then 1 else 0 end) as ended
           from rig_live where rig = ? group by source order by max(id) desc`,
        )
        .all(rig) as Row[]
    ).map((r) => ({
      source: String(r.source),
      lane: r.lane ? String(r.lane) : null,
      run: r.run ? String(r.run) : null,
      last_at: String(r.last_at),
      lines: Number(r.lines),
      ended: Number(r.ended) === 1,
    }));
  }

  /**
   * Each worker trial's session in a rig's live log: when it started and what it was asked to do
   * (its first status line: "trial on lane-1: family, focus"), what it did last (its newest tool
   * call), and how it ended. Newest first.
   */
  trials(rig: string): {
    source: string;
    lane: string | null;
    run: string | null;
    started_at: string;
    last_at: string;
    intro: string;
    last_tool: string | null;
    last_tool_at: string | null;
    ended: string | null;
  }[] {
    const rows = this.db
      .prepare(
        `select source, max(lane) as lane, max(run) as run, min(at) as started_at, max(at) as last_at,
           (select text from rig_live x where x.rig = l.rig and x.source = l.source and x.kind = 'status'
             order by x.id limit 1) as intro,
           (select text from rig_live x where x.rig = l.rig and x.source = l.source and x.kind = 'tool'
             order by x.id desc limit 1) as last_tool,
           (select at from rig_live x where x.rig = l.rig and x.source = l.source and x.kind = 'tool'
             order by x.id desc limit 1) as last_tool_at,
           (select text from rig_live x where x.rig = l.rig and x.source = l.source and x.kind = 'status'
             and x.text like 'trial ended%' order by x.id desc limit 1) as ended
         from rig_live l where rig = ? and source like 'trial:%' group by source order by max(id) desc`,
      )
      .all(rig) as Row[];
    return rows.map((r) => ({
      source: String(r.source),
      lane: r.lane ? String(r.lane) : null,
      run: r.run ? String(r.run) : null,
      started_at: String(r.started_at),
      last_at: String(r.last_at),
      intro: r.intro ? String(r.intro) : "",
      last_tool: r.last_tool ? String(r.last_tool) : null,
      last_tool_at: r.last_tool_at ? String(r.last_tool_at) : null,
      ended: r.ended ? String(r.ended) : null,
    }));
  }
}
