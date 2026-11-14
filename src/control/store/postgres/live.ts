import { log } from "../../../common/env.ts";
import { errorText } from "../../../common/errors.ts";
import { MAX_LANES } from "../../../core/contract.ts";
import type { LiveEntry } from "../../../core/live.ts";
import {
  entryOf,
  type LiveLines,
  type LiveSaid,
  OF_RUN,
  OPEN_TRIAL_LINES,
  TRIALS_LEFT_MAX,
} from "../live.ts";
import { PgPart, type Row } from "./part.ts";

/** LiveLines on PostgreSQL: the store behind the interface (store.ts). */
export class PostgresLiveLines extends PgPart implements LiveLines {
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
  async add(
    rig: string,
    logId: string,
    entries: LiveEntry[],
    signed: boolean,
    keep = 20_000,
  ): Promise<number> {
    const added = await this.keepLines(rig, logId, entries, signed, keep);
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

  private async keepLines(
    rig: string,
    logId: string,
    entries: LiveEntry[],
    signed: boolean,
    keep: number,
  ): Promise<number> {
    const now = new Date().toISOString();
    return await this.tx(async () => {
      const insert = `insert into rig_live (rig, log_id, seq, at, source, kind, text, lane, run, signed, received_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) on conflict do nothing`;
      let added = 0;
      for (const e of entries) {
        added += Number(
          (
            await this.q.run(
              insert,
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
            )
          ).changes,
        );
      }
      const cut = (await this.q.get(
        "select id from rig_live where rig = ? order by id desc limit 1 offset ?",
        rig,
        keep,
      )) as { id: number } | undefined;
      if (!cut) return added;
      // Each open trial's newest lines stay, from the oldest of them on.
      const kept: { source: string; from: number }[] = [];
      for (const source of await this.openTrialSources(rig)) {
        const oldest = (await this.q.get(
          "select id from rig_live where rig = ? and source = ? order by id desc limit 1 offset ?",
          rig,
          source,
          OPEN_TRIAL_LINES - 1,
        )) as { id: number } | undefined;
        kept.push({ source, from: oldest?.id ?? 0 });
      }
      await this.q.run(
        `delete from rig_live where rig = ? and id <= ?${kept.map(() => " and not (source = ? and id >= ?)").join("")}`,
        rig,
        cut.id,
        ...kept.flatMap((k) => [k.source, k.from]),
      );
      return added;
    });
  }

  /**
   * The owner leaves a stuck trial running (goal 143): its card stays away while it is stuck
   * since the same time. Keeps the newest TRIALS_LEFT_MAX of them.
   */
  async leaveTrial(o: {
    rig: string;
    trial: string;
    kind: string;
    since: string;
    by: string;
  }): Promise<void> {
    await this.tx(async () => {
      await this.q.run(
        `insert into trial_left (rig, trial, kind, since, at, by) values (?, ?, ?, ?, ?, ?)
           on conflict (rig, trial, kind) do update set since = excluded.since, at = excluded.at, by = excluded.by`,
        o.rig,
        o.trial,
        o.kind,
        o.since,
        new Date().toISOString(),
        o.by,
      );
      await this.q.run(
        "delete from trial_left where (rig, trial, kind) not in (select rig, trial, kind from trial_left order by at desc limit ?)",
        TRIALS_LEFT_MAX,
      );
    });
  }

  /** Since when the trial was stuck when the owner left it running; null: never left. */
  async trialLeft(rig: string, trial: string, kind: string): Promise<string | null> {
    const r = (await this.q.get(
      "select since from trial_left where rig = ? and trial = ? and kind = ?",
      rig,
      trial,
      kind,
    )) as Row | undefined;
    return r ? String(r.since) : null;
  }

  /** The live sources of the trials the rig's last report lists as open (at most MAX_LANES). */
  private async openTrialSources(rig: string): Promise<string[]> {
    const r = (await this.q.get("select summary from rig where id = ?", rig)) as Row | undefined;
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

  /**
   * Live lines of a rig after `after` (control's own ids), oldest first; one source if given, and
   * of one run if given too (an advisor's source holds every run's lines, goal 218).
   */
  async after(
    rig: string,
    after: number,
    limit: number,
    source?: string,
    run?: string,
  ): Promise<(LiveEntry & { id: number; signed: boolean })[]> {
    const rows = (
      source && run
        ? await this.q.all(
            "select * from rig_live where rig = ? and id > ? and source = ? and run = ? order by id limit ?",
            rig,
            after,
            source,
            run,
            limit,
          )
        : source
          ? await this.q.all(
              "select * from rig_live where rig = ? and id > ? and source = ? order by id limit ?",
              rig,
              after,
              source,
              limit,
            )
          : await this.q.all(
              "select * from rig_live where rig = ? and id > ? order by id limit ?",
              rig,
              after,
              limit,
            )
    ) as Row[];
    return rows.map(entryOf);
  }

  /**
   * Every rig's live lines after `after` (control's own ids, one count for every rig), oldest
   * first, each with its rig: Live's Everything (goal 188).
   */
  async everywhere(
    after: number,
    limit: number,
  ): Promise<(LiveEntry & { id: number; signed: boolean; rig: string })[]> {
    const rows = (await this.q.all(
      "select * from rig_live where id > ? order by id limit ?",
      after,
      limit,
    )) as Row[];
    return rows.map((r) => ({ ...entryOf(r), rig: String(r.rig) }));
  }

  /** Every rig's newest live lines, newest last, each with its rig. */
  async everywhereTail(
    limit: number,
  ): Promise<(LiveEntry & { id: number; signed: boolean; rig: string })[]> {
    const top = (await this.q.get(
      "select id from rig_live order by id desc limit 1 offset ?",
      limit,
    )) as { id: number } | undefined;
    return await this.everywhere(top?.id ?? 0, limit);
  }

  /** How many lines of every rig there are after `after`. */
  async everywhereCount(after: number): Promise<number> {
    const row = (await this.q.get("select count(*) as n from rig_live where id > ?", after)) as {
      n: number;
    };
    return Number(row.n);
  }

  /**
   * One run's live lines after `after`, oldest first: its trials', planner's and judge's lines,
   * plus the judge's and the supervisor's lines that name no run.
   */
  async ofRun(
    rig: string,
    run: string,
    after: number,
    limit: number,
    ids?: number[],
  ): Promise<(LiveEntry & { id: number; signed: boolean })[]> {
    // With ids: only those lines (Live draws again the ones waiting for their event).
    const only = ids?.length ? ` and id in (${ids.map(() => "?").join(",")})` : "";
    const rows = (await this.q.all(
      `select * from rig_live where rig = ? and id > ? and ${OF_RUN}${only} order by id limit ?`,
      rig,
      after,
      run,
      ...(ids ?? []),
      limit,
    )) as Row[];
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
  async reviewLines(
    rig: string,
    run: string,
  ): Promise<{ review: number; at: string; text: string }[]> {
    const rows = (await this.q.all(
      `select at, text from rig_live where rig = ? and run = ? and source = 'supervisor'
           and text ilike 'review %' order by id limit 5000`,
      rig,
      run,
    )) as Row[];
    return rows.flatMap((r) => {
      const m = /^review (\d+)\b/.exec(String(r.text));
      return m ? [{ review: Number(m[1]), at: String(r.at), text: String(r.text) }] : [];
    });
  }

  /**
   * Each advisor's newest Live line in a run that says its call had no answer (goal 193), by its
   * source (`advisor:teacher-2`): "teacher-2 has no answer after 6 min: …". Kept only while the
   * rig's live log keeps it.
   */
  async noAnswers(
    rig: string,
    run: string,
    sources: readonly string[],
  ): Promise<Map<string, LiveSaid>> {
    const out = new Map<string, LiveSaid>();
    if (!sources.length) return out;
    const rows = (await this.q.all(
      `select source, at, text from rig_live where rig = ? and run = ? and kind = 'status'
           and source in (${sources.map(() => "?").join(",")}) and text ilike '% has no answer after %'
         order by id desc limit 200`,
      rig,
      run,
      ...sources,
    )) as Row[];
    for (const r of rows)
      if (!out.has(String(r.source)))
        out.set(String(r.source), { at: String(r.at), text: String(r.text) });
    return out;
  }

  /** One run's newest live lines, newest last (for the Live page's first view). */
  async runTail(
    rig: string,
    run: string,
    limit: number,
  ): Promise<(LiveEntry & { id: number; signed: boolean })[]> {
    const top = (await this.q.get(
      `select id from rig_live where rig = ? and ${OF_RUN} order by id desc limit 1 offset ?`,
      rig,
      run,
      limit,
    )) as { id: number } | undefined;
    return await this.ofRun(rig, run, top?.id ?? 0, limit);
  }

  /** How many of one run's lines there are after `after`, as ofRun reads them. */
  async countOfRun(rig: string, run: string, after: number): Promise<number> {
    const row = (await this.q.get(
      `select count(*) as n from rig_live where rig = ? and id > ? and ${OF_RUN}`,
      rig,
      after,
      run,
    )) as { n: number };
    return Number(row.n);
  }

  /** How many lines of a rig there are after `after`; of one source if given, as after() reads. */
  async count(rig: string, after: number, source?: string): Promise<number> {
    const row = (
      source
        ? await this.q.get(
            "select count(*) as n from rig_live where rig = ? and id > ? and source = ?",
            rig,
            after,
            source,
          )
        : await this.q.get(
            "select count(*) as n from rig_live where rig = ? and id > ?",
            rig,
            after,
          )
    ) as { n: number };
    return Number(row.n);
  }

  /** The newest live lines of a rig, newest last (for a page's first view). */
  async tail(
    rig: string,
    limit: number,
    source?: string,
  ): Promise<(LiveEntry & { id: number; signed: boolean })[]> {
    const top = (await this.q.get(
      source
        ? "select id from rig_live where rig = ? and source = ? order by id desc limit 1 offset ?"
        : "select id from rig_live where rig = ? order by id desc limit 1 offset ?",
      ...(source ? [rig, source, limit] : [rig, limit]),
    )) as { id: number } | undefined;
    return await this.after(rig, top?.id ?? 0, limit, source);
  }

  /** Each live source of a rig with its newest line (sessions to pick from). */
  async sources(rig: string): Promise<
    {
      source: string;
      lane: string | null;
      run: string | null;
      last_at: string;
      lines: number;
      ended: boolean;
    }[]
  > {
    return (
      (await this.q.all(
        `select source, max(lane) as lane, max(run) as run, max(at) as last_at, count(*) as lines,
             max(case when kind = 'status' and text ilike 'trial ended%' then 1 else 0 end) as ended
           from rig_live where rig = ? group by source order by max(id) desc`,
        rig,
      )) as Row[]
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
   * Each advisor with lines in one run of a rig's live log (goal 218): its source, its first and
   * newest line's time, how many lines, and its newest line. Newest first.
   */
  async advisors(
    rig: string,
    run: string,
  ): Promise<{ source: string; first_at: string; last_at: string; lines: number; last: string }[]> {
    const rows = (await this.q.all(
      `select source, min(at) as first_at, max(at) as last_at, count(*) as lines,
           (select text from rig_live x where x.rig = l.rig and x.source = l.source and x.run = l.run
             order by x.id desc limit 1) as last
         from rig_live l where rig = ? and run = ? and source ilike 'advisor:%'
         group by l.rig, l.run, l.source order by max(id) desc`,
      rig,
      run,
    )) as Row[];
    return rows.map((r) => ({
      source: String(r.source),
      first_at: String(r.first_at),
      last_at: String(r.last_at),
      lines: Number(r.lines),
      last: r.last ? String(r.last) : "",
    }));
  }

  /**
   * Each worker trial's session in a rig's live log: when it started and what it was asked to do
   * (its first status line: "trial on lane-1: direction, focus"), what it did last (its newest tool
   * call), and how it ended. Newest first.
   */
  async trials(rig: string): Promise<
    {
      source: string;
      lane: string | null;
      run: string | null;
      started_at: string;
      last_at: string;
      intro: string;
      last_tool: string | null;
      last_tool_at: string | null;
      ended: string | null;
    }[]
  > {
    const rows = (await this.q.all(
      `select source, max(lane) as lane, max(run) as run, min(at) as started_at, max(at) as last_at,
           (select text from rig_live x where x.rig = l.rig and x.source = l.source and x.kind = 'status'
             order by x.id limit 1) as intro,
           (select text from rig_live x where x.rig = l.rig and x.source = l.source and x.kind = 'tool'
             order by x.id desc limit 1) as last_tool,
           (select at from rig_live x where x.rig = l.rig and x.source = l.source and x.kind = 'tool'
             order by x.id desc limit 1) as last_tool_at,
           (select text from rig_live x where x.rig = l.rig and x.source = l.source and x.kind = 'status'
             and x.text ilike 'trial ended%' order by x.id desc limit 1) as ended
         from rig_live l where rig = ? and source ilike 'trial:%'
         group by l.rig, l.source order by max(id) desc`,
      rig,
    )) as Row[];
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
