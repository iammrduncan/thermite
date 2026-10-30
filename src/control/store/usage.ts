import type { SQLInputValue } from "node:sqlite";
import type { z } from "zod";
import type {
  ModelCallBody,
  ModelPrice,
  PodSpendRow,
  UsageRow,
  UsageScope,
} from "../../core/usage.ts";
import { type Row, StorePart } from "./part.ts";

/**
 * Model usage and spend (goal 075; goal 125, T6): each model call's tokens, GPU cloud pods' spend
 * and the prices the owner set.
 */

/** A run a rig is running now, with its campaign (null: none): what its pod's spend goes to. */
export interface RunningRun {
  run: string;
  campaign: string | null;
}

/** A model_call row as the usage sums read it (goal 075). */
function usageRowOf(r: Row): UsageRow {
  const num = (x: SQLInputValue | undefined) => (x === null || x === undefined ? null : Number(x));
  return {
    rig: String(r.rig),
    run: String(r.run),
    campaign: r.campaign === null ? null : String(r.campaign),
    trial: r.trial === null || r.trial === undefined ? null : String(r.trial),
    agent: String(r.agent),
    harness: String(r.harness),
    provider: r.provider === null ? null : String(r.provider),
    model: String(r.model),
    calls: num(r.calls),
    at: String(r.at),
    tokens_in: Number(r.tokens_in),
    cached_in: num(r.cached_in),
    tokens_out: Number(r.tokens_out),
    reasoning: num(r.reasoning),
    first_token_ms: num(r.first_token_ms),
    call_ms: num(r.call_ms),
  };
}

export class UsageRecords extends StorePart {
  /**
   * The model usage records the sums read (goal 075): one run's (on one rig, or on any), one
   * campaign's runs' on every rig, or every record, since a time (ISO; null: all). A rig's records
   * stay after it leaves a ledger, or is retired: the calls were made.
   */
  rows(scope: UsageScope, since: string | null): UsageRow[] {
    const where: string[] = [];
    const args: SQLInputValue[] = [];
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
    const rows = this.db
      .prepare(
        `select rig, run, campaign, trial, agent, harness, provider, model, calls, at, tokens_in,
           cached_in, tokens_out, reasoning, first_token_ms, call_ms from model_call
         ${where.length ? `where ${where.join(" and ")}` : ""} order by at`,
      )
      .all(...args) as Row[];
    return rows.map(usageRowOf);
  }

  /**
   * A model call's usage (goal 075) from a rig's report, as columns the sums read, with the
   * campaign of the run the rig created (control's run registry). A call recorded already is
   * ignored.
   */
  recordCall(
    rig: string,
    ledgerId: string,
    eventId: number,
    run: string,
    u: z.infer<typeof ModelCallBody>,
  ): void {
    this.db
      .prepare(
        `insert or ignore into model_call (rig, ledger_id, event_id, run, campaign, trial, round,
           agent, harness, provider, model, calls, at, tokens_in, cached_in, tokens_out, reasoning,
           first_token_ms, call_ms)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        rig,
        ledgerId,
        eventId,
        run,
        this.store.runRegistry.campaignOf(run, rig) ?? null,
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
        u.tokens_out,
        u.reasoning,
        u.first_token_ms,
        u.call_ms,
      );
  }

  /**
   * The program (harness) an agent of a run on a rig made its newest model call in; undefined
   * when control has no call of it.
   */
  programOf(rig: string, run: string, agent: string): string | undefined {
    const r = this.db
      .prepare(
        "select harness from model_call where rig = ? and run = ? and agent = ? order by at desc limit 1",
      )
      .get(rig, run, agent) as Row | undefined;
    return r ? String(r.harness) : undefined;
  }

  /**
   * A run's model calls in its reviews (goal 116), by the review's number: the review panel's
   * records, whose round the supervisor names "review N".
   */
  reviewRows(rig: string, run: string): Map<number, UsageRow[]> {
    const rows = this.db
      .prepare(
        `select rig, run, campaign, trial, round, agent, harness, provider, model, calls, at,
           tokens_in, cached_in, tokens_out, reasoning, first_token_ms, call_ms from model_call
         where rig = ? and run = ? and round like 'review %' order by at`,
      )
      .all(rig, run) as Row[];
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
  notePodSpend(rig: string, usd: number, runs: RunningRun[]): void {
    if (!(usd > 1e-9)) return;
    const at = new Date().toISOString();
    const insert = this.db.prepare(
      "insert into pod_spend (rig, run, campaign, at, usd) values (?, ?, ?, ?, ?)",
    );
    if (!runs.length) insert.run(rig, null, null, at, usd);
    for (const r of runs) insert.run(rig, r.run, r.campaign, at, usd / runs.length);
  }

  /**
   * GPU cloud pods' spend (goal 075): one run's (on one rig, or on any), one campaign's runs', or
   * every pod's, idle time included, since a time (ISO; null: all).
   */
  podSpend(scope: UsageScope, since: string | null): PodSpendRow[] {
    const where: string[] = [];
    const args: SQLInputValue[] = [];
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
      this.db
        .prepare(
          `select rig, run, campaign, at, usd from pod_spend
           ${where.length ? `where ${where.join(" and ")}` : ""} order by id`,
        )
        .all(...args) as Row[]
    ).map((r) => ({
      rig: String(r.rig),
      run: r.run === null ? null : String(r.run),
      campaign: r.campaign === null ? null : String(r.campaign),
      at: String(r.at),
      usd: Number(r.usd),
    }));
  }

  /** The prices the owner set for providers' models (goal 075). */
  prices(): {
    provider: string;
    model: string;
    price: ModelPrice;
    set_by: string;
    set_at: string;
  }[] {
    return (
      this.db.prepare("select * from model_price order by provider, model").all() as Row[]
    ).map((r) => ({
      provider: String(r.provider),
      model: String(r.model),
      price: {
        input: Number(r.input),
        cached_input: r.cached_input === null ? null : Number(r.cached_input),
        output: Number(r.output),
      },
      set_by: String(r.set_by),
      set_at: String(r.set_at),
    }));
  }

  /** Sets (or, with null, removes) the owner's price for a provider's model. */
  setPrice(provider: string, model: string, price: ModelPrice | null, by: string): void {
    if (!price) {
      this.db
        .prepare("delete from model_price where provider = ? and model = ?")
        .run(provider, model);
      this.store.auditLog.add(by, "model_price_cleared", { provider, model });
      return;
    }
    this.db
      .prepare(
        `insert into model_price (provider, model, input, cached_input, output, set_by, set_at)
         values (?, ?, ?, ?, ?, ?, ?)
         on conflict (provider, model) do update set input = excluded.input,
           cached_input = excluded.cached_input, output = excluded.output,
           set_by = excluded.set_by, set_at = excluded.set_at`,
      )
      .run(
        provider,
        model,
        price.input,
        price.cached_input,
        price.output,
        by,
        new Date().toISOString(),
      );
    this.store.auditLog.add(by, "model_price_set", { provider, model, ...price });
  }
}
