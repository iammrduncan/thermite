import type { HillClimbContract } from "../../../core/contract.ts";
import type { Kit } from "../../../core/kit.ts";
import type { JobRow } from "../../ledger/index.ts";
import {
  BASELINE_BLOCKS,
  type Baseline,
  type BaselineFailure,
  baselineState,
  baselineValue,
  keepBaselineDir,
  prepareBaselineDir,
  removeBaselineDir,
  sealBaselineDir,
} from "../baseline.ts";
import { runBlocks } from "../blocks.ts";
import { type Finish, InfraError, type JudgeContext, Stop } from "../context.ts";
import type { Block } from "../decide.ts";
import { clipReason, REASONS_CHARS } from "../reasons.ts";

/**
 * The baseline job (goal 115): a hill climb's starting point, or a setup change, measured alone in
 * blocks on every measured cell, and the record of its values that the run is held against.
 */

/**
 * The baseline job (goal 115). It builds the starting point, or a setup change, and runs it
 * alone in blocks on every measured cell (never a held-out one), each block running each cell
 * `runs_per_cell` times. The kit's check may write meanwhile to a folder the job hands the
 * card's checker; the folder is then sealed, each file hashed, and kept in the judge's state. Whatever would give a candidate `invalid` or
 * `crash_candidate` means the build can't be measured: for the starting point, a
 * `baseline_failed` event with the reasons (the run is in setup); for a setup change, its
 * verdict. A setup change that measures becomes the starting point (finish), and its values
 * the baseline.
 */
export async function baseline(judge: JudgeContext, job: JobRow): Promise<Finish> {
  const spec = judge.spec(job);
  const run = String(spec.run);
  const contract = judge.hillClimb(run);
  const s = baselineState(judge.ledger, run);
  if (!s) throw new InfraError(`${run} has no baseline to measure`);
  const setup = job.attempt ?? undefined;
  let commit: string;
  if (setup) {
    // The run is no longer in setup: the change is judged as any change is, against the champion.
    if (s.state !== "setup")
      return {
        result: { setup_over: true },
        enqueue: { attempt: setup, kind: "evaluate", actor: judge.o.owner },
        lifecycle: "queued",
      };
    const attempt = judge.ledger.attempts.get(setup);
    if (!attempt) throw new InfraError(`no attempt ${setup}`);
    commit = String(attempt.commit_sha);
  } else {
    if (s.state === "measured" || Number(spec.champion_seq) !== s.start.seq)
      return { result: { skipped: "the starting point has its baseline, or has changed" } };
    commit = s.start.commit;
  }
  const step = (l: string) => {
    judge.ledger.jobs.heartbeat(job.id, job.fence, judge.o.leaseMs);
    if (setup) judge.ledger.attempts.setLifecycle(setup, l, judge.o.owner);
  };
  const expectedSeq = judge.ledger.champions.current(run).seq;
  const dir = prepareBaselineDir(judge.o.service.paths.stateDir, run, job.id);
  const written = await judge.baselineWork(job);
  try {
    const k = await judge.kitFor(contract);
    step("building");
    const arm = await judge.armFor("baseline", run, commit, k);
    const ctx = judge.context(k, job, written);
    step("screening");
    const count = Math.max(2, judge.o.baselineBlocks ?? BASELINE_BLOCKS);
    const blocks = await runBlocks(judge, {
      job,
      ctx,
      arms: [arm],
      cells: contract.cells,
      count,
      runsPerCell: contract.acceptance.runs_per_cell,
    });
    await judge.o.runner.reclaim(written);
    const sealed = sealBaselineDir(written);
    if (!sealed.ok) throw new Stop("invalid", sealed.reason);
    keepBaselineDir(written, dir);
    const body = baselineBody({
      job,
      run,
      contract,
      kit: k.kit,
      commit,
      attempt: setup ?? null,
      blocks,
      files: sealed.files,
      bytes: sealed.bytes,
    });
    if (setup)
      return {
        result: { baseline: true, summary: body.summary },
        start: { run, expectedSeq, attempt: setup, commitSha: commit, baseline: body },
      };
    return {
      result: { baseline: true, champion_seq: s.start.seq, summary: body.summary },
      events: [{ kind: "baseline", subject: run, body: { ...body, champion_seq: s.start.seq } }],
    };
  } catch (err) {
    removeBaselineDir(dir);
    if (!(err instanceof Stop)) throw err;
    if (setup)
      return judge.stopped(
        job,
        new Stop(
          err.verdict,
          `the judge could not measure this setup change, so the run is still in setup: ${err.reason}`,
        ),
      );
    const reasons = clipReason(err.reason, REASONS_CHARS);
    const failure: BaselineFailure = {
      run,
      job: job.id,
      champion_seq: s.start.seq,
      commit,
      reasons,
      summary: `the judge could not measure champion #${s.start.seq} (${commit.slice(0, 8)}): ${clipReason(reasons.split("\n")[0] ?? "", 300)}`,
    };
    return {
      result: { baseline_failed: true, champion_seq: s.start.seq },
      events: [{ kind: "baseline_failed" as const, subject: run, body: failure }],
    };
  } finally {
    // The kept copy is in the state; the checks' folder goes, whoever owns its files.
    await judge.o.runner.remove(written);
  }
}

/** A baseline's record from its blocks: every kit metric on every cell, and the folder. */
function baselineBody(x: {
  job: JobRow;
  run: string;
  contract: HillClimbContract;
  kit: Kit;
  commit: string;
  attempt: string | null;
  blocks: Block[];
  files: Baseline["files"];
  bytes: number;
}): Omit<Baseline, "champion_seq"> {
  const { contract, kit } = x;
  const cells: Baseline["cells"] = {};
  for (const cell of contract.cells) {
    const byMetric: Baseline["cells"][string] = {};
    for (const metric of Object.keys(kit.metrics)) {
      const xs = x.blocks
        .map((b) => b.candidate[metric]?.[cell])
        .filter((v): v is number => v !== undefined && Number.isFinite(v));
      if (xs.length) byMetric[metric] = baselineValue(xs);
    }
    cells[cell] = byMetric;
  }
  const { metric, direction } = contract.objective.primary;
  const fig = (v: number) =>
    Math.abs(v) >= 1e5 ? v.toExponential(3) : String(Number(v.toPrecision(4)));
  const summary = `${metric} ${contract.cells
    .map((c) => {
      const v = cells[c]?.[metric];
      return v
        ? `${c} ${fig(v.median)} ±${((100 * v.mad) / Math.abs(v.median || 1)).toFixed(2)}%`
        : `${c} none`;
    })
    .join(
      ", ",
    )} (median of ${x.blocks.length} blocks${x.files.length ? `; the check kept ${x.files.length} file${x.files.length === 1 ? "" : "s"}` : ""})`;
  return {
    run: x.run,
    job: x.job.id,
    commit: x.commit,
    attempt: x.attempt,
    blocks: x.blocks.length,
    runs_per_cell: contract.acceptance.runs_per_cell,
    primary: { metric, direction },
    guards: contract.guards.map((g) => ({
      metric: g.metric,
      direction: g.direction,
      max_total_regression: g.max_total_regression,
    })),
    units: Object.fromEntries(Object.entries(kit.metrics).map(([n, m]) => [n, m.unit ?? ""])),
    cells,
    files: x.files,
    bytes: x.bytes,
    summary: clipReason(summary, 1000),
  };
}
