import {
  RUNNER_USE_DAYS,
  type RunnerUse,
  type RunnerUseSample,
  SAMPLE_EVERY_MS,
  sampleOf,
} from "../runner-use.ts";
import { PgPart, type Row } from "./part.ts";

/** RunnerUse on PostgreSQL: the store behind the interface (store.ts). */
export class PostgresRunnerUse extends PgPart implements RunnerUse {
  /** A rig's report: its runners' totals, kept unless the rig's newest sample is under a minute. */
  async note(rig: string, summary: unknown, now: string): Promise<void> {
    const s = sampleOf(summary, now);
    if (!s) return;
    const last = (await this.q.get("select max(at) as at from runner_use where rig = ?", rig)) as
      | Row
      | undefined;
    if (last?.at && Date.parse(now) - Date.parse(String(last.at)) < SAMPLE_EVERY_MS) return;
    const { at, ...body } = s;
    await this.q.run(
      "insert into runner_use (rig, at, body) values (?, ?, ?) on conflict (rig, at) do update set body = excluded.body",
      rig,
      at,
      JSON.stringify(body),
    );
    const floor = new Date(Date.parse(now) - RUNNER_USE_DAYS * 86_400_000).toISOString();
    await this.q.run("delete from runner_use where rig = ? and at < ?", rig, floor);
  }

  /** A rig's samples from `from` on, oldest first, with the newest one before it. */
  async samples(rig: string, from: string): Promise<RunnerUseSample[]> {
    const read = (r: Row): RunnerUseSample => ({
      at: String(r.at),
      ...(JSON.parse(String(r.body)) as Omit<RunnerUseSample, "at">),
    });
    const before = (await this.q.get(
      "select at, body from runner_use where rig = ? and at < ? order by at desc limit 1",
      rig,
      from,
    )) as Row | undefined;
    const rows = (await this.q.all(
      "select at, body from runner_use where rig = ? and at >= ? order by at",
      rig,
      from,
    )) as Row[];
    return [...(before ? [read(before)] : []), ...rows.map(read)];
  }
}
