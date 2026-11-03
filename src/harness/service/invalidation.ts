import { Refusal } from "../../common/errors.ts";
import { canonicalSha } from "../../core/canonical.ts";
import {
  type InvalidateEvidence,
  type InvalidationReach,
  REACH_LISTED,
  type ReachedAttempt,
  reachWords,
  withdrawsEvidence,
} from "../../core/invalidation.ts";
import { type Ledger, LedgerError } from "../ledger/index.ts";
import { queueJudging } from "./attempts.ts";
import type { HarnessService } from "./index.ts";
import { requireRun } from "./runs.ts";

/**
 * The owner withdraws bad evidence (goal 174): `invalidate_evidence`, owner only. A preview works
 * out what it reaches and changes nothing; the confirmation names the preview's sha and does
 * exactly that, in one transaction: the ledger's invalidation (verdicts superseded, champions
 * reopened, attempts built on a withdrawn one withdrawn with it), the judge's open jobs for them
 * cancelled, what may be judged again queued, the rest settled, and the run's champion moved back
 * with a recorded step. Then the champion's git ref follows. Nothing is deleted.
 */

/** An attempt still on its way through the judge, or waiting for a decision. */
const WAITING = new Set([
  "queued",
  "building",
  "gating",
  "screening",
  "verifying",
  "confirming",
  "awaiting_audit",
  "awaiting_approval",
  "audit_blocked",
]);

/** Changes the judge never measures: they can't be judged again. */
const NEVER_JUDGED = new Set(["rejected_v0", "duplicate"]);

/** What an invalidation reaches, whole, and the sha the owner's confirmation names. */
export interface InvalidationPlan {
  reach: InvalidationReach & { attempts_all: ReachedAttempt[] };
  cancel: { id: number; kind: string; attempt: string; state: string }[];
  sha: string;
}

/** The subject of a command, checked against its run: refused in words when it is not one. */
function subjectOf(ledger: Ledger, p: InvalidateEvidence): { kind: "attempt" | "job"; id: string } {
  requireRun(ledger, p.run);
  if (p.attempt !== undefined) {
    const a = ledger.attempts.get(p.attempt);
    if (!a || String(a.run) !== p.run) throw new Refusal(`attempt ${p.attempt} is not in ${p.run}`);
    if (a.invalidated_by !== null)
      throw new LedgerError(
        "conflict",
        `attempt ${p.attempt} was withdrawn already, for good: there is nothing more to withdraw`,
      );
    return { kind: "attempt", id: p.attempt };
  }
  const id = Number(p.job);
  const job = ledger.jobs.get(id);
  const run = job?.attempt
    ? String(ledger.attempts.get(job.attempt)?.run ?? "")
    : String((JSON.parse(job?.spec ?? "{}") as { run?: unknown }).run ?? "");
  if (!job || run !== p.run) throw new Refusal(`job ${id} is not in ${p.run}`);
  if (job.state !== "done" && job.state !== "failed")
    throw new Refusal(`job ${id} is ${job.state}: it has no measurements to withdraw yet`);
  return { kind: "job", id: String(id) };
}

/** What withdrawing `p`'s subject would reach now, with nothing changed. */
export function planInvalidation(ledger: Ledger, p: InvalidateEvidence): InvalidationPlan {
  const subject = subjectOf(ledger, p);
  const walk = ledger.verdicts.walk(subject);
  if (subject.kind === "job" && !walk.attempts.length)
    throw new Refusal(
      `no verdict rests on job ${subject.id}'s measurements now: there is nothing to withdraw`,
    );
  const forGood = subject.kind === "attempt";
  const closed = requireRun(ledger, p.run).status === "closed";
  const attempts: ReachedAttempt[] = walk.attempts.map((w) => {
    const row = ledger.attempts.get(w.attempt);
    const lifecycle = String(row?.lifecycle ?? "");
    // One withdrawn for good before, by another withdrawal, is never judged again either.
    const then = forGood
      ? "withdrawn"
      : closed || NEVER_JUDGED.has(lifecycle) || row?.invalidated_by !== null
        ? "stays_withdrawn"
        : "judged_again";
    return {
      attempt: w.attempt,
      why: w.why,
      parent: w.parent,
      lifecycle,
      verdict: w.current ?? null,
      then,
    };
  });
  const cancel = ledger.jobs.openOf(attempts.map((a) => a.attempt));
  const reopened = walk.champions.filter((c) => c.run === p.run);
  const before = ledger.champions.current(p.run);
  const after = ledger.champions.currentWithout(
    p.run,
    reopened.map((c) => c.seq),
  );
  const published = (seq: number) =>
    !!ledger.events.newest("champion_published", { subject: p.run, body: { seq } });
  const reach: InvalidationPlan["reach"] = {
    run: p.run,
    subject,
    for_good: forGood,
    attempts: attempts.slice(0, REACH_LISTED),
    attempts_all: attempts,
    attempts_total: attempts.length,
    superseded: attempts.filter((a) => a.verdict && a.verdict.verdict !== "invalidated").length,
    jobs: {
      cancelled: cancel
        .slice(0, REACH_LISTED)
        .map(({ id, kind, attempt }) => ({ id, kind, attempt })),
      cancelled_total: cancel.length,
      queued: attempts.filter((a) => a.then === "judged_again").length,
    },
    champions: reopened.map((c) => ({
      seq: c.seq,
      attempt: c.attempt,
      published: published(c.seq),
    })),
    champion:
      after.seq === before.seq
        ? null
        : {
            from: before.seq,
            to: after.seq,
            to_attempt: after.attempt,
            validate: !closed && ledger.runs.get(p.run)?.mode === "goal",
          },
  };
  // What the owner decides, whole: each attempt and what becomes of it, the verdicts superseded,
  // the champions reopened and where the champion moves. The jobs follow from the attempts.
  const sha = canonicalSha({
    subject,
    attempts: attempts.map((a) => [a.attempt, a.then, a.verdict?.id ?? null]),
    champions: reopened.map((c) => c.seq),
    champion: reach.champion?.to ?? null,
  });
  return { reach, cancel, sha };
}

/** A plan's reach as the owner reads it: its first attempts, and its words. */
function answer(plan: InvalidationPlan) {
  const { attempts_all: _all, ...reach } = plan.reach;
  return { sha: plan.sha, reach, words: reachWords(reach) };
}

/**
 * Applies an `invalidate_evidence` command: a preview's answer, or the invalidation itself when
 * its `reach` is the sha of what it reaches now. `issuedBy` is the envelope's issuer: the owner
 * alone may withdraw evidence (an operator, too, is refused). `by` is the actor recorded.
 */
export async function invalidateEvidence(
  svc: HarnessService,
  p: InvalidateEvidence,
  issuedBy: string,
  by: string,
): Promise<unknown> {
  if (!withdrawsEvidence(issuedBy))
    throw new Refusal(`invalidate_evidence is the owner's own to issue, not ${issuedBy}'s`);
  const ledger = svc.ledger;
  if (p.preview) return { preview: true, ...answer(planInvalidation(ledger, p)) };
  const done = ledger.tx(() => {
    const plan = planInvalidation(ledger, p);
    if (plan.sha !== p.reach)
      throw new LedgerError(
        "conflict",
        "what it reaches changed since the preview: preview it again, and confirm what it reaches now",
      );
    const subject = plan.reach.subject;
    const r = ledger.verdicts.invalidate({
      subjectKind: subject.kind,
      subjectId: subject.id,
      reason: p.reason,
      actor: by,
    });
    // The ledger reached what the plan said, or nothing is recorded: the preview is what it does.
    const planned = plan.reach.attempts_all.map((a) => a.attempt);
    if (canonicalSha(r.attempts) !== canonicalSha(planned))
      throw new Error("the invalidation reached other attempts than its plan: nothing was changed");
    const why = {
      run: p.run,
      reason: `its evidence was withdrawn: ${p.reason}`,
      invalidation: r.id,
    };
    for (const j of plan.cancel) ledger.jobs.cancel(j.id, by, why);
    for (const a of plan.reach.attempts_all) {
      if (a.then === "judged_again") {
        ledger.attempts.setLifecycle(a.attempt, "queued", by);
        queueJudging(svc, p.run, a.attempt, by);
      } else if (WAITING.has(a.lifecycle)) ledger.attempts.setLifecycle(a.attempt, "judged", by);
    }
    const moved = plan.reach.champion;
    if (moved) {
      const now = ledger.champions.current(p.run);
      ledger.appendEvent(by, "champion_moved_back", p.run, {
        from: moved.from,
        to: now.seq,
        attempt: now.attempt,
        commit: now.commit_sha,
        invalidation: r.id,
        reason: p.reason,
      });
      // A goal run's champion is checked afresh, as after a promotion.
      if (moved.validate)
        ledger.jobs.enqueue({ kind: "validate", priority: 60, spec: { run: p.run }, actor: by });
    }
    return { invalidation: r.id, ...answer(plan) };
  });
  if (done.reach.champion) await svc.syncChampionRef(p.run);
  return done;
}
