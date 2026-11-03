import type { GoalContract } from "../../core/contract.ts";
import { GOAL_VALUES_CELLS, type GoalCellValues } from "../../core/goal/index.ts";
import { meanInterval } from "../../core/stats.ts";
import { patchBetween } from "../git.ts";
import type { JobRow } from "../ledger/index.ts";
import { Reviews } from "../reviews.ts";
import type { JudgeContext } from "./context.ts";
import { decideThresholdGoal, type GoalStatus } from "./decide.ts";
import { runValues, valuesText } from "./goal-values.ts";
import {
  type HeldOutCell,
  type HeldOutResult,
  heldOutKindOf,
  heldOutResult,
  meetsThreshold,
} from "./held-out.ts";
import { type Arm, type MeasureContext, runArm } from "./measure.ts";
import { clipReason } from "./reasons.ts";

/**
 * A goal campaign's goals checked on one build, as its evaluate, confirm and validate jobs check
 * them (jobs/): every goal on its public cells, or on its held-out cells in a held-out pass, and
 * the checks recorded.
 */

/** One goal's check on one build: its status, its reasons and, for a code goal, its values. */
export interface GoalResult {
  goal: string;
  required: boolean;
  status: GoalStatus;
  reasons: string;
  /** A code verifier's goal: each public cell's values (goal 086); never a held-out cell's. */
  values?: GoalCellValues[];
}

/**
 * Checks every goal on one build: metric thresholds from repeated runs (per-cell intervals),
 * code verifiers from the kit's named cell sets, subjective reviews not runnable here (M5).
 */
export async function verifyGoals(
  judge: JudgeContext,
  job: JobRow,
  contract: GoalContract,
  ctx: MeasureContext,
  arm: Arm,
  opts: {
    heldOut?: boolean;
    goals?: string[];
    /** Validating the champion: review goals take the panel and owner's word for this commit. */
    champion?: { run: string; attempt: string | null; commit: string };
    /**
     * In the held-out pass, each held-out cell's result goes here (goal 082): its name, its kind
     * of failure, and a threshold goal's value against its threshold. Never its texts.
     */
    heldOutCells?: HeldOutCell[];
  } = {},
): Promise<GoalResult[]> {
  const out: GoalResult[] = [];
  // Held-out cells run only at confirmation: an attempt's, or a champion's second validation
  // (goal 086). Their results go to the judge's decision and, by name and kind alone, to the
  // held_out record: never into measurements, goal checks or reports.
  const held = new Set(contract.held_out_cells);
  const heldCell = (c: HeldOutCell) => {
    if (opts.heldOut) opts.heldOutCells?.push(c);
  };
  const pick = (cells: string[]) =>
    cells.filter((c) => (opts.heldOut ? held.has(c) : !held.has(c)));
  // Priority gates: each code verifier is evaluated once per pass, its gates (`requires`)
  // first. One whose gate did not pass runs none of its cells. A gate with no cells in this
  // pass (all held out, or none held out) does not block.
  type VerifierResult = {
    ok: boolean;
    runnable: boolean;
    reasons: string;
    values?: GoalCellValues[];
  };
  const verified = new Map<string, VerifierResult>();
  const evaluate = async (name: string): Promise<VerifierResult> => {
    const known = verified.get(name);
    if (known) return known;
    const ver = ctx.kit.verifiers[name];
    let result: VerifierResult;
    if (!ver) {
      result = { ok: false, runnable: false, reasons: `the kit has no verifier ${name}` };
    } else {
      const blocked: string[] = [];
      for (const gate of ver.requires) {
        const g = await evaluate(gate);
        if (g.runnable && !g.ok) blocked.push(gate);
      }
      const cells = pick(ver.cells);
      if (blocked.length) {
        result = {
          ok: false,
          runnable: true,
          reasons: `not run: it requires ${blocked.join(", ")}, which did not pass`,
        };
      } else if (!cells.length) {
        result = {
          ok: false,
          runnable: false,
          reasons: opts.heldOut ? "no held-out cells" : "every cell of this verifier is held out",
        };
      } else {
        judge.ledger.jobs.heartbeat(job.id, job.fence, judge.o.leaseMs);
        const failures: string[] = [];
        // Each public cell's values (goal 086). The held-out pass keeps none: names and kinds
        // only, never a held-out cell's values.
        const values: GoalCellValues[] = [];
        for (const cell of cells) {
          if (!ctx.kit.cells[cell]) {
            failures.push(`no cell ${cell}`);
            heldCell({ cell, verifier: name, ok: false, kind: "no_cell" });
            continue;
          }
          const r = await runArm(ctx, arm, cell);
          if (r.kind !== "ok") failures.push(`${cell}: ${r.kind}: ${clipReason(r.reason)}`);
          if (!opts.heldOut) {
            const metrics = runValues(ctx.kit, r);
            if (Object.keys(metrics).length) values.push({ cell, ok: r.kind === "ok", metrics });
          }
          heldCell(
            r.kind === "ok"
              ? { cell, verifier: name, ok: true }
              : { cell, verifier: name, ok: false, kind: heldOutKindOf(r) },
          );
        }
        // In words as a threshold goal gives its values: "cell: metric value; …".
        const said = values.length ? valuesText(values) : "";
        result = {
          ok: !failures.length,
          runnable: true,
          reasons: failures.length
            ? `${failures.join("; ")}${said ? `; measured: ${said}` : ""}`
            : `verifier ${name} passed on ${cells.join(", ")}${said ? `: ${said}` : ""}`,
          ...(values.length ? { values: values.slice(0, GOAL_VALUES_CELLS) } : {}),
        };
      }
    }
    verified.set(name, result);
    return result;
  };
  // Goals run in their verifiers' priority order (others keep the contract's order) and are
  // reported in the contract's order.
  const rank = (g: GoalContract["goals"][number]) =>
    g.verify.type === "code" ? (ctx.kit.verifiers[g.verify.verifier]?.priority ?? 100) : 100;
  for (const g of [...contract.goals].sort((a, b) => rank(a) - rank(b))) {
    if (opts.goals && !opts.goals.includes(g.id)) continue;
    judge.ledger.jobs.heartbeat(job.id, job.fence, judge.o.leaseMs);
    const v = g.verify;
    if (v.type === "review") {
      if (!opts.champion || opts.heldOut) {
        out.push({
          goal: g.id,
          required: g.required,
          status: "not_runnable",
          reasons: "subjective goals are reviewed for champions only",
        });
        continue;
      }
      const reviews = new Reviews(judge.ledger);
      const { run, attempt, commit } = opts.champion;
      if (!reviews.get(run, g.id, commit)) {
        const inst = judge.ledger.runs.get(run);
        const diff = inst
          ? await patchBetween(judge.o.service.mirrorFor(inst.seed_repo), inst.seed_commit, commit)
          : "";
        reviews.request({
          run,
          goal: g.id,
          attempt,
          commit,
          contract,
          diff,
          by: judge.o.owner,
        });
      }
      const r = reviews.status(run, g.id, commit);
      out.push({ goal: g.id, required: g.required, status: r.status, reasons: r.reasons });
      continue;
    }
    if (v.type === "code") {
      const r = await evaluate(v.verifier);
      out.push({
        goal: g.id,
        required: g.required,
        status: !r.runnable ? "not_runnable" : r.ok ? "met" : "unmet",
        reasons: r.reasons,
        ...(r.values ? { values: r.values } : {}),
      });
      continue;
    }
    // metric_threshold: threshold_reps runs per cell; the value is a kit metric or a number the kit's
    // check reports (for example memory headroom measured by the judge's client).
    const cells = pick(v.cells ?? Object.keys(ctx.kit.cells));
    if (!cells.length) {
      out.push({
        goal: g.id,
        required: g.required,
        status: "not_runnable",
        reasons: opts.heldOut ? "no held-out cells" : "every cell of this goal is held out",
      });
      continue;
    }
    const values: Record<string, number[]> = {};
    const failures: string[] = [];
    // The held-out cells that failed before a threshold could be checked, and how.
    const failedHeld = new Set<string>();
    for (const cell of cells) {
      if (!ctx.kit.cells[cell]) {
        failures.push(`no cell ${cell}`);
        heldCell({ cell, goal: g.id, ok: false, kind: "no_cell" });
        failedHeld.add(cell);
        continue;
      }
      for (let rep = 1; rep <= contract.threshold_reps; rep++) {
        const r = await runArm(ctx, arm, cell);
        if (r.kind !== "ok") {
          failures.push(`${cell}: ${r.kind}: ${clipReason(r.reason)}`);
          heldCell({ cell, goal: g.id, ok: false, kind: heldOutKindOf(r) });
          failedHeld.add(cell);
          break;
        }
        const value = r.metrics[v.metric] ?? r.check.details[v.metric];
        if (typeof value !== "number" || !Number.isFinite(value)) {
          failures.push(`${cell}: no ${v.metric}`);
          heldCell({ cell, goal: g.id, ok: false, kind: "non_finite", measure: v.metric });
          failedHeld.add(cell);
          break;
        }
        values[cell] = [...(values[cell] ?? []), value];
        if (opts.heldOut) continue;
        judge.ledger.measurements.record(job.id, job.fence, {
          arm: arm.name,
          metric: v.metric,
          cell,
          rep,
          value,
          unit: ctx.kit.metrics[v.metric]?.unit ?? "",
        });
      }
    }
    if (failures.length && !Object.keys(values).length) {
      out.push({
        goal: g.id,
        required: g.required,
        status: "not_runnable",
        reasons: failures.join("; "),
      });
      continue;
    }
    // Decided on this pass's cells only: a goal whose cells mix measured and held-out ones is
    // screened on the measured ones and confirmed on the held-out ones (goal 082), never
    // "not runnable" for lack of a value that this pass does not measure.
    const d = decideThresholdGoal(v.cells ? { ...g, verify: { ...v, cells } } : g, values, 0.05);
    // Each held-out cell that ran: its mean and interval against the threshold. It passes only
    // when its whole interval is on the passing side, as the goal's own decision rule says (one
    // value gives no interval, and does not pass).
    for (const cell of cells) {
      const xs = values[cell];
      if (!opts.heldOut || failedHeld.has(cell) || !xs?.length) continue;
      const i = xs.length >= 2 ? meanInterval(xs, 0.05) : undefined;
      const ok =
        !!i && meetsThreshold(i.low, v.op, v.value) && meetsThreshold(i.high, v.op, v.value);
      heldCell({
        cell,
        goal: g.id,
        ok,
        ...(ok ? {} : { kind: "threshold_missed" as const }),
        value: i ? i.estimate : (xs[0] as number),
        ...(i ? { low: i.low, high: i.high } : {}),
        threshold: v.value,
        op: v.op,
        measure: v.metric,
        unit: ctx.kit.metrics[v.metric]?.unit ?? "",
      });
    }
    const status: GoalStatus = failures.length && d.status === "met" ? "unmet" : d.status;
    out.push({
      goal: g.id,
      required: g.required,
      status,
      reasons: failures.length ? `${d.reasons}; ${failures.join("; ")}` : d.reasons,
    });
  }
  // Reported in the contract's order, whatever order they ran in.
  const order = new Map(contract.goals.map((g, i) => [g.id, i]));
  return out.sort((a, b) => (order.get(a.goal) ?? 0) - (order.get(b.goal) ?? 0));
}

export function recordGoals(
  judge: JudgeContext,
  job: JobRow,
  run: string,
  attempt: string | null,
  commit: string,
  results: { goal: string; status: GoalStatus; reasons: string }[],
  updateStatus: boolean,
): void {
  judge.ledger.tx(() => {
    judge.ledger.jobs.assertLease(job.id, job.fence);
    for (const r of results)
      judge.ledger.goals.recordCheck(
        { run, goal: r.goal, attempt, job: job.id, commit },
        r,
        updateStatus,
      );
  });
}

/**
 * A goal campaign's held-out pass on one build (goal 082): the held-out cells of these goals,
 * an attempt's newly met goals at its confirmation or, at the confirming validation, each goal
 * the champion meets (goal 086). Each cell's name and kind go into the result, for the owner's
 * record; `failed` names the goals whose held-out check did not pass. Never a cell's values or
 * texts, and its errors reach the agents in fixed words only (heldOutPass).
 */
export async function heldOutGoals(
  judge: JudgeContext,
  job: JobRow,
  contract: GoalContract,
  ctx: MeasureContext,
  arm: Arm,
  goals: string[],
): Promise<HeldOutResult & { failed: string[] }> {
  const cells: HeldOutCell[] = [];
  const checked = await judge.heldOutPass(job, () =>
    verifyGoals(judge, job, contract, ctx, arm, { heldOut: true, goals, heldOutCells: cells }),
  );
  // A goal with no held-out cell has nothing to fail here.
  const failed = checked
    .filter((r) => r.status !== "met" && r.reasons !== "no held-out cells")
    .map((r) => r.goal);
  return { pass: !failed.length, cells: heldOutResult(cells).cells, failed };
}
