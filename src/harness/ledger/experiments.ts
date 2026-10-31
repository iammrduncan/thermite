import type { EventOf } from "../../core/events/bodies.ts";
import type { EventKind } from "../../core/names.ts";
import { LedgerError, LedgerPart, type Row } from "./part.ts";
import { type ExperimentRow, toExperiment } from "./rows.ts";

/** The `experiment` table: the experiment queue's rows. */
export class LedgerExperiments extends LedgerPart {
  /**
   * Every change to a run's experiment queue goes through here: the rows it changes (the
   * experiment, and the queued ones whose place moved) and its one event, in one transaction.
   * A row keeps its creation time, its author and where it came from; its update time is now.
   */
  write(
    rows: Omit<ExperimentRow, "created_at" | "updated_at">[],
    event: EventOf<Extract<EventKind, `experiment_${string}`>> & { actor: string; run: string },
  ): number {
    return this.tx(() => {
      const now = this.now();
      const upsert = this.db.prepare(
        `insert into experiment (id, run, title, details, family, why, added_by, state, place, lane,
           trial, attempt, result, dropped_by, dropped_why, from_run, from_id, cause, returns,
           question, yield, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         on conflict (id) do update set title = excluded.title, details = excluded.details,
           family = excluded.family, why = excluded.why, state = excluded.state,
           place = excluded.place, lane = excluded.lane, trial = excluded.trial,
           attempt = excluded.attempt, result = excluded.result, dropped_by = excluded.dropped_by,
           dropped_why = excluded.dropped_why, cause = excluded.cause, returns = excluded.returns,
           question = coalesce(excluded.question, experiment.question),
           yield = coalesce(excluded.yield, experiment.yield),
           updated_at = excluded.updated_at
         where experiment.run = excluded.run`,
      );
      for (const r of rows) {
        const out = upsert.run(
          r.id,
          r.run,
          r.title,
          r.details,
          r.family,
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

  /** The experiment an attempt came from, if it came from one. */
  ofAttempt(attempt: string): ExperimentRow | undefined {
    const r = this.row<ExperimentRow>(
      "select * from experiment where attempt = ? order by updated_at desc limit 1",
      attempt,
    );
    return r ? toExperiment(r) : undefined;
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
