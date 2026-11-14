import type { z } from "zod";
import type {
  ModelCallBody,
  ModelPrice,
  PodSpendRow,
  UsageRow,
  UsageScope,
} from "../../../core/usage.ts";
import { type RunningRun, type UsageRecords, usageRowOf } from "../usage.ts";
import { PgPart, type Row } from "./part.ts";

/** UsageRecords on PostgreSQL: the store behind the interface (store.ts). */
export class PostgresUsageRecords extends PgPart implements UsageRecords {
  /**
   * The model usage records the sums read (goal 075): one run's (on one rig, or on any), one
   * campaign's runs' on every rig, or every record, since a time (ISO; null: all). A rig's records
   * stay after it leaves a ledger, or is retired: the calls were made.
   */
  async rows(scope: UsageScope, since: string | null): Promise<UsageRow[]> {
    const where: string[] = [];
    const args: unknown[] = [];
    if (since) {
      where.push("at >= ?");
      args.push(since);
    }
    if (scope.kind === "run") {
      where.push("run = ?");
      args.push(scope.run);
    }
    if (scope.kind === "campaign") {
      where.push("campaign = ?");
      args.push(scope.campaign);
    }
    const rows = (await this.q.all(
      `select rig, run, campaign, trial, agent, harness, provider, model, calls, at, tokens_in,
           cached_in, cache_write_in, tokens_out, reasoning, first_token_ms, call_ms from model_call
         ${where.length ? `where ${where.join(" and ")}` : ""} order by at`,
      ...args,
    )) as Row[];
    return rows.map(usageRowOf);
  }

  /**
   * A model call's usage (goal 075) from a rig's report, as columns the sums read, with the
   * campaign of the run the rig created (control's run registry). A call recorded already is
   * ignored.
   */
  async recordCall(
    rig: string,
    ledgerId: string,
    eventId: number,
    run: string,
    u: z.infer<typeof ModelCallBody>,
  ): Promise<void> {
    await this.q.run(
      `insert into model_call (rig, ledger_id, event_id, run, campaign, trial, round,
           agent, harness, provider, model, calls, at, tokens_in, cached_in, cache_write_in,
           tokens_out, reasoning, first_token_ms, call_ms)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) on conflict do nothing`,
      rig,
      ledgerId,
      eventId,
      run,
      (await this.store.runRegistry.campaignOf(run, rig)) ?? null,
      u.trial,
      u.round,
      u.agent,
      u.harness,
      u.provider,
      u.model,
      u.calls,
      u.at,
      u.tokens_in,
      u.cached_in,
      u.cache_write_in ?? null,
      u.tokens_out,
      u.reasoning,
      u.first_token_ms,
      u.call_ms,
    );
  }

  /**
   * The program (harness) an agent of a run made its newest model call in, on the rig given or
   * any; undefined when control has no call of it.
   */
  async programOf(run: string, agent: string, rig?: string): Promise<string | undefined> {
    const r = (await this.q.get(
      `select harness from model_call where run = ? and agent = ?${rig ? " and rig = ?" : ""}
         order by at desc limit 1`,
      run,
      agent,
      ...(rig ? [rig] : []),
    )) as Row | undefined;
    return r ? String(r.harness) : undefined;
  }

  /**
   * A run's model calls in its reviews (goal 116), by the review's number: the review panel's
   * records, whose round the supervisor names "review N".
   */
  async reviewRows(rig: string, run: string): Promise<Map<number, UsageRow[]>> {
    const rows = (await this.q.all(
      `select rig, run, campaign, trial, round, agent, harness, provider, model, calls, at,
           tokens_in, cached_in, cache_write_in, tokens_out, reasoning, first_token_ms, call_ms
         from model_call
         where rig = ? and run = ? and round ilike 'review %' order by at`,
      rig,
      run,
    )) as Row[];
    const out = new Map<number, UsageRow[]>();
    for (const r of rows) {
      const m = /^review (\d+)$/.exec(String(r.round));
      if (!m) continue;
      const n = Number(m[1]);
      out.set(n, [...(out.get(n) ?? []), usageRowOf(r)]);
    }
    return out;
  }

  /**
   * A pod's spend since control last counted it (goal 075), for the runs its rig is running now
   * (`runs`, as the rig's view says), split evenly when it runs more than one; for no run when it
   * runs none.
   */
  async notePodSpend(rig: string, usd: number, runs: RunningRun[]): Promise<void> {
    if (!(usd > 1e-9)) return;
    const at = new Date().toISOString();
    const insert = "insert into pod_spend (rig, run, campaign, at, usd) values (?, ?, ?, ?, ?)";
    if (!runs.length) await this.q.run(insert, rig, null, null, at, usd);
    for (const r of runs) await this.q.run(insert, rig, r.run, r.campaign, at, usd / runs.length);
  }

  /**
   * GPU cloud pods' spend (goal 075): one run's (on one rig, or on any), one campaign's runs', or
   * every pod's, idle time included, since a time (ISO; null: all).
   */
  async podSpend(scope: UsageScope, since: string | null): Promise<PodSpendRow[]> {
    const where: string[] = [];
    const args: unknown[] = [];
    if (since) {
      where.push("at >= ?");
      args.push(since);
    }
    if (scope.kind === "run") {
      where.push("run = ?");
      args.push(scope.run);
    }
    if (scope.kind === "campaign") {
      where.push("campaign = ?");
      args.push(scope.campaign);
    }
    return (
      (await this.q.all(
        `select rig, run, campaign, at, usd from pod_spend
           ${where.length ? `where ${where.join(" and ")}` : ""} order by id`,
        ...args,
      )) as Row[]
    ).map((r) => ({
      rig: String(r.rig),
      run: r.run === null ? null : String(r.run),
      campaign: r.campaign === null ? null : String(r.campaign),
      at: String(r.at),
      usd: Number(r.usd),
    }));
  }

  /** The prices the owner set for providers' models (goal 075). */
  async prices(): Promise<
    {
      provider: string;
      model: string;
      price: ModelPrice;
      set_by: string;
      set_at: string;
    }[]
  > {
    return ((await this.q.all("select * from model_price order by provider, model")) as Row[]).map(
      (r) => ({
        provider: String(r.provider),
        model: String(r.model),
        price: {
          input: Number(r.input),
          cached_input: r.cached_input === null ? null : Number(r.cached_input),
          cache_write:
            r.cache_write === null || r.cache_write === undefined ? null : Number(r.cache_write),
          output: Number(r.output),
        },
        set_by: String(r.set_by),
        set_at: String(r.set_at),
      }),
    );
  }

  /** Sets (or, with null, removes) the owner's price for a provider's model. */
  async setPrice(
    provider: string,
    model: string,
    price: ModelPrice | null,
    by: string,
  ): Promise<void> {
    if (!price) {
      await this.q.run("delete from model_price where provider = ? and model = ?", provider, model);
      await this.store.auditLog.add(by, "model_price_cleared", { provider, model });
      return;
    }
    await this.q.run(
      `insert into model_price (provider, model, input, cached_input, cache_write, output,
           set_by, set_at)
         values (?, ?, ?, ?, ?, ?, ?, ?)
         on conflict (provider, model) do update set input = excluded.input,
           cached_input = excluded.cached_input, cache_write = excluded.cache_write,
           output = excluded.output, set_by = excluded.set_by, set_at = excluded.set_at`,
      provider,
      model,
      price.input,
      price.cached_input,
      price.cache_write ?? null,
      price.output,
      by,
      new Date().toISOString(),
    );
    await this.store.auditLog.add(by, "model_price_set", { provider, model, ...price });
  }
}
