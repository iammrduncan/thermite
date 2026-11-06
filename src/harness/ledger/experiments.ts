import type { EventOf } from "../../core/events/bodies.ts";
import type { EventKind } from "../../core/names.ts";
import { LedgerError, LedgerPart, type Row } from "./part.ts";
import { type ExperimentRow, type ExperimentTry, toExperiment } from "./rows.ts";

/**
 * Ledger migration 30 (goal 214): how many trials each experiment gets, and each try that ended
 * without a win, with its lane, trial, attempt, result, verdict and cause, in the order tried.
 */
export const EXPERIMENT_TRIES = `
alter table experiment add column tries integer not null default 1;
create table experiment_try (
  experiment text not null,
  n integer not null,
  run text not null,
  lane text,
  trial text not null,
  attempt text,
  result text not null,
  verdict text,
  cause text,
  at text not null,
  primary key (experiment, n)
);
create index experiment_try_attempt on experiment_try (attempt);
`;

/** The `experiment` table: the experiment queue's rows. */
export class LedgerExperiments extends LedgerPart {
  /**
   * Every change to a run's experiment queue goes through here: the rows it changes (the
   * experiment, and the queued ones whose place moved) and its one event, in one transaction.
   * A row keeps its creation time, its author and where it came from; its update time is now.
   * `tried`: the try of the first row that ended without a win, kept with them (goal 214).
   */
  write(
    rows: Omit<ExperimentRow, "created_at" | "updated_at">[],
    event: EventOf<Extract<EventKind, `experiment_${string}`>> & { actor: string; run: string },
    tried?: Omit<ExperimentTry, "at">,
  ): number {
    return this.tx(() => {
      const now = this.now();
      const first = rows[0];
      if (tried && first)
        this.db
          .prepare(
            `insert into experiment_try (experiment, n, run, lane, trial, attempt, result, verdict, cause, at)
             values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            first.id,
            tried.n,
            first.run,
            tried.lane,
            tried.trial,
            tried.attempt,
            tried.result,
            tried.verdict,
            tried.cause,
            now,
          );
      const upsert = this.db.prepare(
        `insert into experiment (id, run, title, details, direction, why, added_by, state, place, lane,
           trial, attempt, result, dropped_by, dropped_why, from_run, from_id, cause, returns,
           question, yield, tries, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         on conflict (id) do update set title = excluded.title, details = excluded.details,
           direction = excluded.direction, why = excluded.why, state = excluded.state,
           place = excluded.place, lane = excluded.lane, trial = excluded.trial,
           attempt = excluded.attempt, result = excluded.result, dropped_by = excluded.dropped_by,
           dropped_why = excluded.dropped_why, cause = excluded.cause, returns = excluded.returns,
           question = coalesce(excluded.question, experiment.question),
           yield = coalesce(excluded.yield, experiment.yield), tries = excluded.tries,
           updated_at = excluded.updated_at
         where experiment.run = excluded.run`,
      );
      for (const r of rows) {
        const out = upsert.run(
          r.id,
          r.run,
          r.title,
          r.details,
          r.direction,
          r.why,
          r.added_by,
          r.state,
          r.place,
          r.lane,
          r.trial,
          r.attempt,
          r.result,
          r.dropped_by,
          r.dropped_why,
          r.from_run,
          r.from_id,
          r.cause ?? null,
          r.returns ?? 0,
          r.question ?? null,
          r.yield ?? null,
          r.tries ?? 1,
          now,
          now,
        );
        if (Number(out.changes) === 0)
          throw new LedgerError("conflict", `experiment ${r.id} belongs to another run`);
      }
      return this.ledger.appendEvent(event.actor, event.kind, event.run, event.body);
    });
  }

  /** A run's experiments, oldest first. */
  list(run: string): ExperimentRow[] {
    return this.rows<ExperimentRow>(
      "select * from experiment where run = ? order by created_at, rowid",
      run,
    ).map(toExperiment);
  }

  get(id: string): ExperimentRow | undefined {
    const r = this.row<ExperimentRow>("select * from experiment where id = ?", id);
    return r ? toExperiment(r) : undefined;
  }

  /** The experiment a trial works (or worked) on, if it had one. */
  ofTrial(trial: string): ExperimentRow | undefined {
    const r = this.row<ExperimentRow>(
      "select * from experiment where trial = ? order by updated_at desc limit 1",
      trial,
    );
    return r ? toExperiment(r) : undefined;
  }

  /** The experiment an attempt came from, if it came from one: in its try now, or an earlier one. */
  ofAttempt(attempt: string): ExperimentRow | undefined {
    const r =
      this.row<ExperimentRow>(
        "select * from experiment where attempt = ? order by updated_at desc limit 1",
        attempt,
      ) ??
      this.row<ExperimentRow>(
        "select e.* from experiment e join experiment_try t on t.experiment = e.id where t.attempt = ? limit 1",
        attempt,
      );
    return r ? toExperiment(r) : undefined;
  }

  /** An experiment's tries that ended without a win (goal 214), the first first. */
  triesOf(id: string): ExperimentTry[] {
    return this.rows<Row>("select * from experiment_try where experiment = ? order by n", id).map(
      (r) => ({
        n: Number(r.n),
        lane: r.lane === null ? null : String(r.lane),
        trial: String(r.trial),
        attempt: r.attempt === null ? null : String(r.attempt),
        result: String(r.result),
        verdict: r.verdict === null ? null : String(r.verdict),
        cause: r.cause === null ? null : String(r.cause),
        at: String(r.at),
      }),
    );
  }

  /**
   * A run's experiments that are done with an attempt and have tries left (goal 214), the oldest
   * first: each goes back to the queue once the judge settles its attempt without a win.
   */
  doneWithTriesLeft(run: string): ExperimentRow[] {
    return this.rows<ExperimentRow>(
      `select * from experiment e where e.run = ? and e.state = 'done' and e.attempt is not null
         and e.tries > 1 + (select count(*) from experiment_try t where t.experiment = e.id)
       order by e.updated_at, e.rowid`,
      run,
    ).map(toExperiment);
  }

  /** A lane's newest experiment, if it had one. */
  lastOfLane(run: string, lane: string): ExperimentRow | undefined {
    const r = this.row<ExperimentRow>(
      "select * from experiment where run = ? and lane = ? order by updated_at desc, rowid desc limit 1",
      run,
      lane,
    );
    return r ? toExperiment(r) : undefined;
  }

  /** The experiments still assigned whose trial ended or is gone, with how their trial ended. */
  orphans(): {
    trial: string;
    stopped: string | null;
    attempt: string | null;
    error: string | null;
  }[] {
    return this.rows<Row>(
      `select e.trial as trial, t.stopped as stopped, t.attempt as attempt, t.error as error
       from experiment e left join trial t on t.id = e.trial
       where e.state = 'assigned' and (t.id is null or t.ended_at is not null)`,
    ).map((r) => ({
      trial: String(r.trial),
      stopped: r.stopped === null ? null : String(r.stopped),
      attempt: r.attempt === null ? null : String(r.attempt),
      error: r.error === null ? null : String(r.error),
    }));
  }

  // A research run's tasks (goal 117): experiments that name a question.

  /** What a question's newest `n` finished tasks added, as JSON, the newest first. */
  yields(run: string, question: number, n: number): { yield: string; created_at: string }[] {
    return this.rows<Row>(
      `select yield, created_at from experiment
         where run = ? and question = ? and state = 'done' and yield is not null
         order by updated_at desc, rowid desc limit ?`,
      run,
      question,
      n,
    ).map((r) => ({ yield: String(r.yield), created_at: String(r.created_at) }));
  }

  /** The questions of a run's newest `n` tasks a trial took, the newest first. */
  takenQuestions(run: string, n: number): number[] {
    return this.rows<Row>(
      `select e.question as question from experiment e join trial t on t.id = e.trial
         where e.run = ? and e.question is not null and e.state in ('assigned', 'done')
       order by t.rowid desc limit ?`,
      run,
      n,
    ).map((r) => Number(r.question));
  }

  /** How many of a run's tasks, not dropped, ask each question; within one round, when given. */
  questionCounts(run: string, epoch?: number): Map<number, number> {
    const rows =
      epoch === undefined
        ? this.rows<Row>(
            `select question, count(*) as c from experiment where run = ? and question is not null
               and state in ('queued', 'assigned', 'done') group by question`,
            run,
          )
        : this.rows<Row>(
            `select e.question as question, count(*) as c from experiment e join trial t on t.id = e.trial
               where e.run = ? and e.question is not null and t.epoch = ? and e.state in ('assigned', 'done')
             group by e.question`,
            run,
            epoch,
          );
    return new Map(rows.map((r) => [Number(r.question), Number(r.c)]));
  }
}
