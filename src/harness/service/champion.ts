import type { z } from "zod";
import { errorText, Refusal } from "../../common/errors.ts";
import type { CommandPayloads } from "../../core/commands.ts";
import { Audits } from "../audits.ts";
import { updateRef } from "../git.ts";
import { portReplaced } from "../judge/index.ts";
import { type Ledger, LedgerError } from "../ledger/index.ts";
import type { HarnessService } from "./index.ts";
import { decidingRun, requireRun } from "./runs.ts";

/**
 * A confirmed win and the champion: whether it waits for the owner, the champion by
 * compare-and-swap with its git ref, the owner's yes and no, and a win screened again when the
 * champion moved meanwhile.
 */

/**
 * Why a confirmed win waits for the owner, or undefined (goal 079). Thermite is hands-off by
 * default: a win waits only where the run (or the rig's default) asks: every win (promotion
 * policy "owner_approval"), a gain above `ask_owner.above_gain`, or declared flaws
 * (`ask_owner.declared_flaws`).
 */
export function ownerAsks(
  svc: HarnessService,
  run: string,
  attempt: Record<string, unknown>,
  delta: number | null,
): string | undefined {
  if (svc.promotionFor(run) === "owner_approval")
    return "you asked to decide every change (promotion: owner approval)";
  const ask = svc.askFor(run);
  const flaws = (JSON.parse(String(attempt.known_flaws ?? "[]")) as unknown[]).length;
  if (ask.declared_flaws && flaws > 0)
    return `you asked to decide changes with declared flaws: this one declares ${flaws}`;
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  if (ask.above_gain !== undefined && delta !== null && delta > ask.above_gain)
    return `you asked to decide gains above ${pct(ask.above_gain)}: this one is ${pct(delta)}`;
  return undefined;
}

/** The change of an attempt's current verdict, if it has one. */
function verdictDelta(ledger: Ledger, attempt: string): number | null {
  const v = ledger.verdicts.current(attempt);
  return (v && ledger.verdicts.get(v.id)?.delta) ?? null;
}

/**
 * A win with nothing left to hold it (an auditor's clear, or no auditor): the owner, where the
 * run asks; else the champion by compare-and-swap, its declared flaws accepted by this step (goal
 * 079: hands-off by default). A champion that moved meanwhile sends it to be screened again.
 */
export async function promoteOrAsk(
  svc: HarnessService,
  attempt: string,
  run: string,
  expectedSeq: number,
  by: string,
  cleared: string,
): Promise<Record<string, unknown>> {
  const a = svc.ledger.attempts.get(attempt) as Record<string, unknown>;
  const ask = svc.ownerAsks(run, a, verdictDelta(svc.ledger, attempt));
  if (ask) {
    svc.ledger.tx(() => {
      svc.ledger.appendEvent(by, "promotion_pending", attempt, {
        run,
        expected_seq: expectedSeq,
        commit: a.commit_sha,
        reason: ask,
      });
      svc.ledger.attempts.setLifecycle(attempt, "awaiting_approval", by);
    });
    return { effect: "waiting for the owner", reason: ask };
  }
  // Declared flaws are accepted by this step, in the promotion's own transaction.
  const acceptFlaws = `${by} (${cleared})`;
  const r = await svc.promoteAttempt({ run, attempt, expectedSeq, by, acceptFlaws });
  if (r.promoted) return { effect: "promoted", seq: r.seq };
  return rescreen(svc.ledger, attempt, r.currentSeq, by) as Record<string, unknown>;
}

/** A promotion as the judge, an audit's clear or the owner's approval asks for it. */
export interface Promotion {
  run: string;
  attempt: string;
  expectedSeq: number;
  by: string;
  acceptFlaws?: string | undefined;
  also?: () => void;
}

/**
 * Moves the champion to a confirmed attempt by compare-and-swap and points the champion ref
 * at it. Returns the current seq instead when the champion moved since the attempt was judged.
 */
/**
 * The champion by compare-and-swap, as the judge promotes (goal 163): the champion, the flaws'
 * acceptance, the lifecycle, a goal run's validation and `also` (what the caller records with
 * it) in one transaction; the champion's git ref follows from the ledger.
 */
export async function promoteAttempt(
  svc: HarnessService,
  input: Promotion,
): Promise<{ promoted: true; seq: number } | { promoted: false; currentSeq: number }> {
  const a = svc.ledger.attempts.get(input.attempt);
  if (!a) throw new LedgerError("not_found", `no attempt ${input.attempt}`);
  const goal = svc.contractFor(input.run).mode === "goal";
  const r = svc.ledger.tx(() => {
    const { run, expectedSeq, attempt, by, acceptFlaws } = input;
    const commitSha = String(a.commit_sha);
    const p = svc.ledger.champions.promote({
      run,
      expectedSeq,
      attempt,
      commitSha,
      by,
      acceptFlaws,
    });
    if (!p.ok) return p;
    // A new goal-campaign champion is validated afresh, so the goal tree reflects it.
    if (goal)
      svc.ledger.jobs.enqueue({
        kind: "validate",
        priority: 60,
        spec: { run: input.run },
        actor: input.by,
      });
    input.also?.();
    return p;
  });
  if (!r.ok) return { promoted: false, currentSeq: r.currentSeq };
  await svc.syncChampionRef(input.run);
  return { promoted: true, seq: r.seq };
}

/**
 * Points the run's champion ref at the effective champion, and queues the port a new champion
 * needs (goal 135). The ledger is the authority; the ref is for git consumers, so a failure here
 * is recorded, never fatal.
 */
export async function syncChampionRef(svc: HarnessService, run: string): Promise<void> {
  const inst = requireRun(svc.ledger, run);
  const champ = svc.ledger.champions.current(run);
  const ref = `refs/thermite/runs/${run}/champion`;
  try {
    await updateRef(svc.mirrorFor(inst.seed_repo), ref, champ.commit_sha);
  } catch (err) {
    svc.ledger.appendEvent("judge", "champion_ref_failed", run, {
      seq: champ.seq,
      error: errorText(err),
    });
  }
  await portReplaced(svc, run);
}

/**
 * The owner approves a promotion: one waiting for approval, or one held or blocked by an audit
 * (the owner is above the auditor). Approving an attempt with declared flaws accepts them.
 * The judge's verdict must still be promotable; the ledger checks that.
 */
export async function approvePromotion(
  svc: HarnessService,
  p: z.infer<(typeof CommandPayloads)["approve_promotion"]>,
  by: string,
): Promise<unknown> {
  decidingRun(svc.ledger, p.run, "approve_promotion");
  const a = svc.ledger.attempts.get(p.attempt);
  if (!a || String(a.run) !== p.run) {
    throw new Refusal(`attempt ${p.attempt} is not in ${p.run}`);
  }
  const lifecycle = String(a.lifecycle);
  let expectedSeq: number;
  if (lifecycle === "awaiting_approval") {
    expectedSeq = Number(svc.ledger.latestEventBody("promotion_pending", p.attempt)?.expected_seq);
  } else if (lifecycle === "awaiting_audit" || lifecycle === "audit_blocked") {
    expectedSeq = Number(new Audits(svc.ledger).get(p.attempt)?.expected_seq);
  } else {
    throw new Refusal(`attempt ${p.attempt} is ${lifecycle}, not awaiting approval`);
  }
  if (!Number.isInteger(expectedSeq)) throw new Refusal(`no pending promotion for ${p.attempt}`);
  // The owner's approval accepts declared flaws, in the promotion's own transaction, and an
  // audit it overrides is recorded there too.
  const r = await svc.promoteAttempt({
    ...p,
    expectedSeq,
    by,
    acceptFlaws: by,
    also: () => {
      if (lifecycle !== "awaiting_approval")
        svc.ledger.appendEvent(by, "audit_overridden", p.attempt, { lifecycle });
    },
  });
  if (r.promoted) return r;
  return rescreen(svc.ledger, p.attempt, r.currentSeq, by);
}

/** The owner's no: the attempt never becomes the champion, and its open audit is over. */
export function declinePromotion(
  ledger: Ledger,
  p: z.infer<(typeof CommandPayloads)["decline_promotion"]>,
  by: string,
): unknown {
  // A closed run's changes stay as they were (goal 087): its record does not change.
  decidingRun(ledger, p.run, "decline_promotion");
  const a = ledger.attempts.get(p.attempt);
  if (!a || String(a.run) !== p.run) throw new Refusal(`attempt ${p.attempt} is not in ${p.run}`);
  const lifecycle = String(a.lifecycle);
  if (!["awaiting_approval", "awaiting_audit", "audit_blocked"].includes(lifecycle))
    throw new Refusal(`attempt ${p.attempt} is ${lifecycle}: there is nothing to decline`);
  ledger.tx(() => {
    ledger.attempts.setLifecycle(p.attempt, "declined", by);
    ledger.appendEvent(by, "promotion_declined", p.attempt, {
      run: p.run,
      was: lifecycle,
      ...(p.note ? { note: p.note } : {}),
    });
  });
  return { attempt: p.attempt, declined: true, was: lifecycle };
}

/** The champion moved after a win was confirmed: it is screened again against the new one. */
function rescreen(ledger: Ledger, attempt: string, currentSeq: number, by: string): unknown {
  // Another path may have promoted it meanwhile (an audit clear and an approval racing).
  if (String(ledger.attempts.get(attempt)?.lifecycle) === "promoted") {
    return { promoted: true, note: "already promoted" };
  }
  ledger.jobs.enqueue({ attempt, kind: "evaluate", actor: by });
  ledger.attempts.setLifecycle(attempt, "queued", by);
  return { promoted: false, rescreen: true, champion_seq: currentSeq };
}
