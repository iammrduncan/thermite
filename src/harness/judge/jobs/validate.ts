import type { GoalContract } from "../../../core/contract.ts";
import type { Kit } from "../../../core/kit.ts";
import type { JobRow } from "../../ledger/index.ts";
import type { Finish, JudgeContext } from "../context.ts";
import type { GoalStatus } from "../decide.ts";
import { type GoalResult, heldOutGoals, recordGoals, verifyGoals } from "../goals.ts";
import {
  type HeldOutCell,
  type HeldOutResult,
  heldOutEvent,
  heldOutKinds,
  heldOutWords,
} from "../held-out.ts";

/**
 * The validate job: a goal campaign's champion checked on every goal, which sets the goal tree's
 * state. When every required goal is met, a second validation must agree, on the held-out cells of
 * the goals met too, before the run closes (goal 086).
 */

/**
 * The held-out cells one goal's check ran: a threshold goal's own, or those of a code goal's
 * verifier and of the gates it requires.
 */
function heldOutCellsOf(
  goal: GoalContract["goals"][number] | undefined,
  kit: Kit,
  cells: readonly HeldOutCell[],
): HeldOutCell[] {
  if (!goal) return [];
  if (goal.verify.type !== "code") return cells.filter((c) => c.goal === goal.id);
  const verifiers = new Set<string>();
  const add = (name: string) => {
    if (verifiers.has(name)) return;
    verifiers.add(name);
    for (const gate of kit.verifiers[name]?.requires ?? []) add(gate);
  };
  add(goal.verify.verifier);
  return cells.filter((c) => c.verifier !== undefined && verifiers.has(c.verifier));
}

function successHolds(
  contract: GoalContract,
  results: { required: boolean; status: GoalStatus }[],
): boolean {
  const met = results.filter((r) => r.status === "met");
  if (contract.success.policy === "k_of_n")
    return met.length >= (contract.success.k ?? results.length);
  const required = results.filter((r) => r.required);
  return required.length > 0 && required.every((r) => r.status === "met");
}

/** Measures every goal on the champion: the judge-only validation and the goal tree's state. */
export async function validate(judge: JudgeContext, job: JobRow): Promise<Finish> {
  const run = String(judge.spec(job).run);
  const contract = judge.goalContract(run);
  const champion = judge.ledger.champions.current(run);
  const k = await judge.kitFor(contract);
  const arm = await judge.armFor("champion", run, champion.commit_sha, k);
  const ctx = judge.context(k, job);
  const results = await verifyGoals(judge, job, contract, ctx, arm, {
    champion: { run, attempt: champion.attempt, commit: champion.commit_sha },
  });
  recordGoals(judge, job, run, null, champion.commit_sha, results, true);
  const done = successHolds(contract, results);
  // Completion is final, so one validation is not enough: a second, independent validation
  // of the same champion must agree before the campaign closes. A confirmation queued for an
  // earlier champion (a promotion came first) is a first validation of this one (goal 086).
  const spec = judge.spec(job);
  const confirming =
    spec.confirm === true &&
    (spec.champion_seq === undefined || Number(spec.champion_seq) === champion.seq);
  // The second validation also runs the held-out cells of each goal the champion meets (goal
  // 086, the owner's decision of 2026-10-22): an attempt's confirmation runs them only for the
  // goals it newly met, so without this a goal met long before was never checked on them. The
  // run closes only if every one passes. Subjective goals have no cells.
  let ho: (HeldOutResult & { failed: string[] }) | undefined;
  if (confirming && done && contract.held_out_cells.length) {
    const met = results
      .filter(
        (r) =>
          r.status === "met" &&
          contract.goals.find((g) => g.id === r.goal)?.verify.type !== "review",
      )
      .map((r) => r.goal);
    if (met.length) ho = await heldOutGoals(judge, job, contract, ctx, arm, met);
    // No held-out cell ran (none of these goals has one): there was nothing to check.
    if (ho?.pass && !ho.cells.length) ho = undefined;
    if (ho)
      judge.ledger.heldOut.recordChampion(job.id, job.fence, run, champion.seq, ho.pass, {
        pass: ho.pass,
        cells: ho.cells,
      });
  }
  // A goal whose held-out check failed is not met: the goal tree says so, so a change that
  // meets it again is progress, and its own confirmation runs that goal's held-out cells. The
  // report says why by kind alone (goal 082), never which cell, its values or its texts; the
  // owner's detail is in the held_out record and its event.
  const unconfirmed = new Set(ho && !ho.pass ? ho.failed : []);
  const shown: GoalResult[] = results.map((r) =>
    unconfirmed.has(r.goal)
      ? {
          ...r,
          status: "unmet",
          reasons: `not confirmed: ${heldOutWords(
            heldOutKinds(
              heldOutCellsOf(
                contract.goals.find((g) => g.id === r.goal),
                k.kit,
                ho?.cells ?? [],
              ),
            ),
          )}; on the measured cells: ${r.reasons}`,
        }
      : r,
  );
  if (unconfirmed.size)
    recordGoals(
      judge,
      job,
      run,
      null,
      champion.commit_sha,
      shown.filter((r) => unconfirmed.has(r.goal)),
      true,
    );
  const complete = done && !unconfirmed.size;
  const summary = {
    run,
    champion_seq: champion.seq,
    // Each goal's description too, so a reader of the report needs no copy of the contract;
    // a code goal's values on each public cell (goal 086).
    goals: shown.map((r) => ({
      goal: r.goal,
      description: contract.goals.find((g) => g.id === r.goal)?.description ?? null,
      status: r.status,
      reasons: r.reasons,
      ...(r.values ? { values: r.values } : {}),
    })),
    complete,
    ...(done && !confirming ? { confirming: true } : {}),
    // The champion was not confirmed: its held-out check failed, said by kind alone.
    ...(ho && !ho.pass ? { not_confirmed: heldOutWords(heldOutKinds(ho.cells)) } : {}),
  };
  if (done && !confirming) {
    return {
      result: summary,
      events: [{ kind: "goal_report" as const, subject: run, body: summary }],
      enqueue: {
        kind: "validate",
        priority: 40,
        spec: { run, champion_seq: champion.seq, confirm: true },
        actor: judge.o.owner,
      },
    };
  }
  return {
    result: summary,
    events: [
      // The owner's record of the champion's held-out check, before the report it decided.
      ...(ho ? [heldOutEvent(job.id, run, run, ho, champion.seq)] : []),
      { kind: "goal_report" as const, subject: run, body: summary },
      ...(complete
        ? [{ kind: "goal_complete" as const, subject: run, body: { champion_seq: champion.seq } }]
        : []),
    ],
    ...(complete ? { close: { run, reason: "every required goal is met" } } : {}),
  };
}
