import type { JobRow } from "../ledger/index.ts";
import { readThrottle, throttledFraction } from "../targets/index.ts";
import { InfraError, type JudgeContext } from "./context.ts";
import type { Block } from "./decide.ts";
import { type Arm, type MeasureContext, runArm } from "./measure.ts";
import { rng } from "./rng.ts";

/**
 * How the judge measures: in interleaved blocks, every cell with both arms in random order (or one
 * arm alone, for a baseline), each block's values recorded only when the harness was not
 * throttled meanwhile. Evaluate, confirm, the baseline and the A/A calibration all measure so.
 */

/**
 * A block is discarded and re-run when the harness was CPU-throttled for more than this fraction
 * of the block, or of any single run in it, or when the target reports a problem afterwards.
 */
const MAX_THROTTLED = 0.02;
const MAX_RUN_THROTTLED = 0.02;
const MAX_BLOCK_TRIES = 3;

async function ready(judge: JudgeContext): Promise<Record<string, unknown>> {
  for (let i = 0; ; i++) {
    const r = await judge.o.driver.readyForTiming();
    if (r.ready) return r.details;
    if (i >= judge.o.readyRetries) {
      throw new InfraError(`target not ready for timing: ${r.reasons.join("; ")}`);
    }
    await new Promise((res) => setTimeout(res, judge.o.readyDelayMs));
  }
}

/**
 * Runs `count` interleaved blocks over `cells` and records every value as a measurement.
 * Each block re-checks the target's readiness and renews the lease. With one arm (a baseline),
 * each block runs that arm alone: its values are the block's `candidate` side.
 */
export async function runBlocks(
  judge: JudgeContext,
  input: {
    job: JobRow;
    ctx: MeasureContext;
    arms: [Arm, Arm] | [Arm];
    cells: readonly string[];
    count: number;
    startAt?: number;
    runsPerCell?: number;
    onBlock?: (blocks: Block[]) => boolean;
  },
): Promise<Block[]> {
  const { job, ctx, arms, cells } = input;
  const [a, b] = arms;
  const target = await judge.o.driver.identify();
  const out: Block[] = [];
  for (let i = 0; i < input.count; i++) {
    const n = (input.startAt ?? 0) + i + 1;
    for (let attempt = 1; ; attempt++) {
      const done = await runBlock(judge, {
        job,
        ctx,
        a,
        b,
        cells,
        n,
        attempt,
        target,
        runsPerCell: input.runsPerCell ?? 1,
      });
      if (done) {
        out.push(done);
        break;
      }
      if (attempt >= MAX_BLOCK_TRIES) {
        throw new InfraError(
          `block ${n} throttled on ${attempt} tries: the CPU quota is too tight`,
        );
      }
    }
    if (input.onBlock?.(out)) break;
  }
  return out;
}

/**
 * One block: every cell, both arms in random order. Its values are recorded only if the
 * harness was not CPU-throttled for more than MAX_THROTTLED of the block; otherwise the block
 * is discarded (its receipt says why) and run again.
 */
async function runBlock(
  judge: JudgeContext,
  x: {
    job: JobRow;
    ctx: MeasureContext;
    a: Arm;
    b: Arm | undefined;
    cells: readonly string[];
    n: number;
    attempt: number;
    target: unknown;
    runsPerCell: number;
  },
): Promise<Block | undefined> {
  const { job, ctx, a, b, n } = x;
  judge.ledger.jobs.heartbeat(job.id, job.fence, judge.o.leaseMs);
  const readiness = await ready(judge);
  const block: Block = { candidate: {}, reference: {} };
  const values: { arm: string; metric: string; cell: string; value: number }[] = [];
  const runs: unknown[] = [];
  const order = rng(job.id * 7919 + n * 31 + x.attempt);
  let worstRunThrottle = 0;
  const throttleBefore = readThrottle();
  const started = Date.now();
  // Raw values per arm, metric and cell; the block takes their median (runs_per_cell).
  const raw: Record<string, Record<string, Record<string, number[]>>> = {};
  for (const cell of x.cells) {
    for (let k = 0; k < x.runsPerCell; k++) {
      const pair = !b ? [a] : order() < 0.5 ? [a, b] : [b, a];
      for (const arm of pair) {
        const t0 = readThrottle();
        const r = await runArm(ctx, arm, cell);
        const runThrottle = throttledFraction(t0, readThrottle(), r.outcome.wallMs) ?? 0;
        worstRunThrottle = Math.max(worstRunThrottle, runThrottle);
        runs.push({
          arm: arm.name,
          cell,
          run: k + 1,
          kind: r.kind,
          wall_ms: r.outcome.wallMs,
          peak_rss: r.outcome.peakRssBytes,
          cpu_throttled_fraction: runThrottle,
          // Processes left running after the benchmark exited (killed) and files it left in
          // shared places (removed): flagged, never silently ignored.
          leftovers: r.outcome.leftovers,
          swept: r.outcome.swept.length,
          ...(r.kind === "ok" ? { check: r.check.details } : { reason: r.reason }),
        });
        judge.judgeRun(arm, r, cell);
        if (r.kind !== "ok") continue;
        for (const [metric, value] of Object.entries(r.metrics)) {
          const byMetric = raw[arm.name] ?? {};
          const byCell = byMetric[metric] ?? {};
          byCell[cell] = [...(byCell[cell] ?? []), value];
          byMetric[metric] = byCell;
          raw[arm.name] = byMetric;
        }
      }
    }
  }
  const median = (xs: number[]) => {
    const v = [...xs].sort((p, q) => p - q);
    const m = Math.floor(v.length / 2);
    return v.length % 2 ? (v[m] as number) : ((v[m - 1] as number) + (v[m] as number)) / 2;
  };
  for (const arm of b ? [a, b] : [a]) {
    const side = arm === a ? "candidate" : "reference";
    for (const [metric, byCell] of Object.entries(raw[arm.name] ?? {})) {
      for (const [cell, xs] of Object.entries(byCell)) {
        const value = median(xs);
        values.push({ arm: arm.name, metric, cell, value });
        block[side][metric] ??= {};
        (block[side][metric] as Record<string, number>)[cell] = value;
      }
    }
  }
  const throttled = throttledFraction(throttleBefore, readThrottle(), Date.now() - started);
  const afterBlock = await judge.o.driver.afterBlock();
  const accepted =
    worstRunThrottle <= MAX_RUN_THROTTLED &&
    (throttled === undefined || throttled <= MAX_THROTTLED) &&
    afterBlock.length === 0;
  judge.ledger.jobs.recordReceipt(job.id, job.fence, {
    job: job.id,
    attempt: job.attempt,
    block: n,
    try: x.attempt,
    accepted,
    separated: judge.o.runner.separated,
    cpu_throttled_fraction: throttled ?? null,
    worst_run_throttled_fraction: worstRunThrottle,
    after_block: afterBlock,
    target: x.target,
    readiness,
    env: await judge.o.driver.envSnapshot(),
    builds: { a: a.manifest.key, ...(b ? { b: b.manifest.key } : {}) },
    runs,
  });
  if (!accepted) return undefined;
  for (const v of values) {
    judge.ledger.measurements.record(job.id, job.fence, {
      ...v,
      rep: n,
      unit: ctx.kit.metrics[v.metric]?.unit ?? "",
    });
  }
  return block;
}
