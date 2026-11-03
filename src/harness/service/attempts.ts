import { join } from "node:path";
import { SubmitRequest } from "../../core/api/harness/proposer.ts";
import { sha256Hex } from "../../core/canonical.ts";
import { newAttemptId } from "../../core/ids.ts";
import { Registry } from "../agents/index.ts";
import { createAttemptCommit, GitError, hasCommit } from "../git.ts";
import { BASELINE_PRIORITY, baselineState, heldOutWords } from "../judge/index.ts";
import { type Ledger, LedgerError } from "../ledger/index.ts";
import { checkV0, violationsOf } from "../v0.ts";
import type { HarnessService } from "./index.ts";
import { requireRun } from "./runs.ts";

/**
 * Submitted changes: each preserved as an attempt (a commit and its ref) before anything checks
 * it, a trial's one submission, and what a proposer may see of an attempt.
 */

export interface SubmitResult {
  attempt: string;
  /** `judged`: built on an attempt the owner withdrew for good, it is withdrawn with it (goal 174). */
  lifecycle: "queued" | "rejected_v0" | "duplicate" | "judged";
  commit: string;
  violations: string[];
  duplicate_of?: string;
}

/** What a worker submits: its trial decides the run, the lane and the parent. */
export type TrialPatch = Pick<
  SubmitRequest,
  "patch_base64" | "hypothesis" | "claim" | "known_flaws"
>;

/**
 * Preserves a submitted change as an attempt ref first, then applies V0 and duplicate checks.
 * Rejected and duplicate attempts are still recorded: nothing submitted is destroyed.
 */
export async function submitAttempt(
  svc: HarnessService,
  req: SubmitRequest,
  actor: string,
): Promise<SubmitResult> {
  const inst = requireRun(svc.ledger, req.run);
  if (inst.status !== "running")
    throw new LedgerError("invalid", `run ${req.run} is ${inst.status}`);
  const contract = svc.contractFor(req.run);
  if (contract.mode === "research")
    throw new LedgerError("invalid", "research campaigns take claims, not patches");
  const champion = svc.ledger.champions.current(req.run);
  const parent = req.parent ?? champion.commit_sha;
  const mirror = svc.mirrorFor(inst.seed_repo);
  if (!(await hasCommit(mirror, parent)))
    throw new LedgerError("invalid", `unknown parent ${parent}`);
  const id = newAttemptId();
  let made: Awaited<ReturnType<typeof createAttemptCommit>>;
  try {
    made = await createAttemptCommit({
      mirror,
      scratchDir: join(svc.paths.scratchDir, "attempts"),
      parent,
      patch: Buffer.from(req.patch_base64, "base64"),
      id,
      message: `thermite attempt ${id}\n\n${req.hypothesis}`,
    });
  } catch (err) {
    if (err instanceof GitError) {
      // Nothing to preserve (the patch did not apply), but the submission is still counted.
      svc.ledger.appendEvent(actor, "submission_refused", req.run, {
        lane: req.lane ?? null,
        parent,
        diff_sha: sha256Hex(Buffer.from(req.patch_base64, "base64")),
        reason: err.message,
      });
      throw new LedgerError("invalid", err.message);
    }
    throw err;
  }
  const v0 = checkV0(
    contract,
    made.changedFiles,
    made.addedLines,
    made.binaryFiles,
    made.specialFiles,
  );
  const duplicateOf = svc.ledger.attempts.findDuplicate(req.run, made.normalizedDiffSha);
  const lifecycle = !v0.ok ? "rejected_v0" : duplicateOf ? "duplicate" : "queued";
  // Lineage: the attempt this one was built on, whether or not it is the champion.
  const parentAttempt =
    parent === champion.commit_sha && champion.attempt
      ? champion.attempt
      : svc.ledger.attempts.byCommit(req.run, parent);
  const parentRef = parentAttempt ? `refs/thermite/attempts/${parentAttempt}` : `commit:${parent}`;
  svc.ledger.attempts.record(
    {
      id,
      run: req.run,
      lane: req.lane,
      parentRef,
      parentCommit: parent,
      parentAttempt,
      baselineChampionSeq: champion.seq,
      commitSha: made.commit,
      ref: made.ref,
      diffSha: made.diffSha,
      normalizedDiffSha: made.normalizedDiffSha,
      lifecycle,
      hypothesis: req.hypothesis,
      claim: req.claim,
      knownFlaws: req.known_flaws,
      v0,
      files: made.stat,
    },
    actor,
  );
  // Built on an attempt the owner withdrew for good (goal 174): withdrawn with it, never judged.
  const withdrawn =
    lifecycle === "queued" &&
    parentAttempt !== undefined &&
    svc.ledger.tx(() => {
      if (!svc.ledger.verdicts.inherit(id, parentAttempt, actor)) return false;
      svc.ledger.attempts.setLifecycle(id, "judged", actor);
      return true;
    });
  if (lifecycle === "queued" && !withdrawn) queueJudging(svc, req.run, id, actor);
  return {
    attempt: id,
    lifecycle: withdrawn ? "judged" : lifecycle,
    commit: made.commit,
    violations: v0.violations,
    ...(duplicateOf ? { duplicate_of: duplicateOf } : {}),
  };
}

/**
 * Queues the judge's job for a change. A hill climb in setup (goal 115): its starting point can't
 * be measured yet, so a change is judged by the baseline job, which makes the first one it can
 * measure the starting point. Otherwise the change is screened against the champion.
 */
export function queueJudging(svc: HarnessService, run: string, attempt: string, actor: string) {
  const setup = baselineState(svc.ledger, run)?.state === "setup";
  return svc.ledger.jobs.enqueue({
    attempt,
    kind: setup ? "baseline" : "evaluate",
    ...(setup ? { priority: BASELINE_PRIORITY } : {}),
    spec: { run, ...(setup ? { setup: true } : {}) },
    actor,
  });
}

/**
 * A worker's submission. The trial (found by its token) decides the run, lane and parent;
 * the request cannot. A trial submits at most once, and never after it has ended, so a worker
 * that outlives its trial cannot add attempts. `submitting`: the trials whose submission is
 * being recorded right now (the service's).
 */
export async function submitForTrial(
  svc: HarnessService,
  submitting: Set<string>,
  token: string,
  req: TrialPatch,
): Promise<SubmitResult> {
  const registry = new Registry(svc.ledger);
  const t = registry.openTrial(token);
  if (t.attempt || submitting.has(t.id)) {
    throw new LedgerError("conflict", `trial ${t.id} has already submitted`);
  }
  submitting.add(t.id);
  try {
    const r = await svc.submitAttempt(
      SubmitRequest.parse({
        run: t.run,
        lane: t.lane,
        parent: t.parent,
        patch_base64: req.patch_base64,
        hypothesis: req.hypothesis,
        claim: req.claim,
        known_flaws: req.known_flaws ?? [],
      }),
      `trial:${t.id}`,
    );
    registry.linkAttempt(t.id, r.attempt);
    return r;
  } finally {
    submitting.delete(t.id);
  }
}

/** A trial's submission, once it has one: its attempt and where the attempt stands. */
export function trialSubmission(
  ledger: Ledger,
  trialId: string,
): { attempt: string; lifecycle: string } | undefined {
  const t = ledger.trials.get(trialId);
  if (!t?.attempt) return undefined;
  const a = ledger.attempts.get(t.attempt);
  return { attempt: t.attempt, lifecycle: String(a?.lifecycle ?? "recorded") };
}

/**
 * What a proposer may see about an attempt: lifecycle, verdict and V0 findings, with the
 * violations of a refused change at the top (`violations`, all of them).
 */
export function attemptStatus(ledger: Ledger, id: string): unknown {
  const a = ledger.attempts.get(id);
  if (!a) throw new LedgerError("not_found", `no attempt ${id}`);
  const verdict = ledger.verdicts.current(id);
  const heldOut = ledger.heldOut.failure(id);
  return {
    attempt: id,
    run: a.run,
    lane: a.lane ?? null,
    lifecycle: a.lifecycle,
    commit: a.commit_sha,
    v0: a.v0 ? JSON.parse(String(a.v0)) : null,
    violations: violationsOf(a.v0),
    verdict: verdict ? { verdict: verdict.verdict } : null,
    // Only that a held-out check failed, and how (goal 082): never which cell, or why.
    held_out: heldOut ? heldOutWords(heldOut) : null,
  };
}
