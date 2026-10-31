import { type BriefData, briefData } from "../../core/brief.ts";
import { questionName } from "../../core/research-check.ts";
import { type AuditDecision, type AuditPackage, Audits } from "../audits.ts";
import { Conclusions } from "../conclusions.ts";
import { patchBetween } from "../git.ts";
import { briefingData, pastResearchLine } from "../knowledge.ts";
import { LedgerError } from "../ledger/index.ts";
import type { AdvisorRole, OwnerMessages } from "../messages.ts";
import {
  checkResearchPanel,
  decisionWords,
  RESEARCH_REVIEW,
  type ResearchPackage,
  type ResearchVerdicts,
  reviewerGaps,
} from "../research/index.ts";
import {
  type ResearchReviewPackage,
  type ReviewKind,
  type ReviewPackage,
  Reviews,
} from "../reviews.ts";
import { promoteOrAsk } from "./champion.ts";
import type { HarnessService } from "./index.ts";
import { decidingRun, requireRun } from "./runs.ts";

/**
 * The supervisor's advisors and what they decide: which advisors it has, the auditor's packages
 * and decisions, the review panel's packages and results, and a "not possible" proposal taken
 * hands-off.
 */

/** One reviewer's result, as the supervisor posts the review panel's. */
export interface PanelResult {
  reviewer: string;
  pass: boolean;
  reasons: string;
  research?: ResearchVerdicts | undefined;
}

/** The auditor's decision on an attempt, as the supervisor posts it. */
export interface AuditorDecision {
  attempt: string;
  decision: AuditDecision;
  reasons: string;
  citations: string[];
  auditor: string;
}

/**
 * The supervisor says which advisors it has (goal 079). Without an auditor, the audits held for
 * one go on by the run's rules: promoted, or to the owner where the run asks.
 */
export async function setAdvisors(
  svc: HarnessService,
  a: { auditor: boolean; review_panel: number; writer?: boolean | undefined },
  by: string,
): Promise<string[]> {
  svc.advisors = {
    auditor: a.auditor,
    review_panel: a.review_panel,
    writer: a.writer === true,
    at: svc.clock().toISOString(),
  };
  return a.auditor ? [] : svc.releaseHeldAudits(by);
}

/** A failed try of a review (goal 116): a `review_try_failed` event on the review's run. */
export function recordReviewTry(
  svc: HarnessService,
  id: number,
  attempt: number,
  error: string,
  by: string,
): { recorded: true } {
  const row = new Reviews(svc.ledger).byId(id);
  if (!row) throw new LedgerError("not_found", `no review ${id}`);
  svc.ledger.appendEvent(by, "review_try_failed", String(row.run), {
    review: id,
    try: attempt,
    error: error.slice(0, 2000),
  });
  return { recorded: true };
}

/**
 * A review panel's results (goal 079). A pass is accepted with no owner step, unless the run
 * asks the owner (`ask_owner.reviews`); the goal tree is checked again. A research review's
 * results (goal 112) are checked by code first (recordResearchPanel).
 */
export function recordReviewPanel(
  svc: HarnessService,
  id: number,
  results: PanelResult[],
  by: string,
): { result: "review_passed" | "review_failed"; accepted?: true } {
  const reviews = new Reviews(svc.ledger);
  const asked = reviews.byId(id);
  if (asked?.goal === RESEARCH_REVIEW) return recordResearchPanel(svc, reviews, asked, results, by);
  const result = reviews.recordPanel(id, results, by);
  const row = svc.ledger.reviews.get(id);
  const run = row ? String(row.run) : undefined;
  if (result !== "review_passed" || !run || svc.askFor(run).reviews) return { result };
  reviews.ownerDecision(
    id,
    run,
    true,
    "hands-off: the review panel passed it, and the run does not ask the owner",
    "harness (hands-off)",
  );
  svc.ledger.jobs.enqueue({ kind: "validate", priority: 40, spec: { run }, actor: by });
  return { result, accepted: true };
}

/**
 * A research review's results (goals 112 and 117): each reviewer's answers to the items it was
 * asked to decide, checked by code against the package it was given (research/review.ts), and
 * recorded with each failed check's reason; each item's decision is the panel's majority
 * (reviews.ts). The decisions go in the run's journal, and, when items stay open, what each
 * reviewer found open. A pass (every question has an end, every required hypothesis a verdict)
 * is accepted hands-off, unless the run asks the owner about reviews; once accepted, the
 * scheduler asks for the run's paper and ends the run when its running trials end.
 */
function recordResearchPanel(
  svc: HarnessService,
  reviews: Reviews,
  row: Record<string, unknown>,
  results: PanelResult[],
  by: string,
): { result: "review_passed" | "review_failed"; accepted?: true } {
  const id = Number(row.id);
  const run = String(row.run);
  const pkg = JSON.parse(String(row.package)) as ResearchPackage;
  const checked = checkResearchPanel(svc.ledger, run, pkg, results);
  const { result, decided, open } = reviews.recordResearchPanel(id, checked, by);
  const name = (d: { kind: string; key: string }) =>
    d.kind === "question" ? questionName(Number(d.key)) : `Hypothesis ${d.key}`;
  svc.journal.writeAll(
    run,
    [
      {
        kind: "decision",
        text: `Review ${id} decided ${decided.length} ${decided.length === 1 ? "item" : "items"} by the majority of ${checked.length} reviewers: ${decided
          .map(
            (d) =>
              `${name(d)} ${decisionWords(d)}${d.why ? ` (${d.why})` : ` (${d.majority.length} of ${checked.length})`}${d.dissent.length ? `, ${d.dissent.length} dissenting` : ""}`,
          )
          .join(
            "; ",
          )}.${open.questions.length ? ` Still open: ${open.questions.map(questionName).join(", ")}.` : ""}`.slice(
          0,
          2000,
        ),
      },
    ],
    { by: "harness", actor: by, source: "supervisor" },
  );
  if (result === "review_failed") {
    // One note for each reviewer that found an item open or gave an answer that failed the check.
    for (const r of checked) {
      const gaps = reviewerGaps(r);
      if (!gaps.length) continue;
      svc.journal.writeAll(
        run,
        [{ kind: "observation", text: `Review ${id}: ${gaps.join(". ")}.`.slice(0, 2000) }],
        { by: `review_panel:${r.reviewer}`, actor: by, source: "supervisor" },
      );
    }
    return { result };
  }
  if (svc.askFor(run).reviews) return { result };
  const words = "hands-off: the review panel passed it, and the run does not ask the owner";
  reviews.ownerDecision(id, run, true, words, "harness (hands-off)");
  svc.journal.writeAll(
    run,
    [
      {
        kind: "decision",
        text: `Review ${id}: ${words}. Every question has an end and every required hypothesis a verdict: the run writes its paper and final report, and ends once its running trials end.`,
      },
    ],
    { by: "harness", actor: "harness (hands-off)", source: "supervisor" },
  );
  return { result, accepted: true };
}

/**
 * A "not possible" proposal (goal 079): taken, closing the run, unless the run asks the owner
 * (`ask_owner.not_possible`). True when it was taken.
 */
export function takeConclusion(svc: HarnessService, run: string, proposal: number): boolean {
  if (svc.askFor(run).not_possible) return false;
  new Conclusions(svc.ledger).decide(
    run,
    proposal,
    true,
    "hands-off: the run does not ask the owner",
    "harness (hands-off)",
    "not possible: the evidence holds, and the run does not ask the owner",
  );
  return true;
}

/** The audits held while no auditor decides them (goal 079), released by the run's rules. */
export async function releaseHeldAudits(svc: HarnessService, by: string): Promise<string[]> {
  const audits = new Audits(svc.ledger);
  const out: string[] = [];
  for (const id of audits.pending()) {
    const au = svc.ledger.audits.get(id);
    if (!au) continue;
    const attempt = String(au.attempt);
    if (String(svc.ledger.attempts.get(attempt)?.lifecycle) !== "awaiting_audit") continue;
    // A closed run's audit stays held (goal 087): none of its changes becomes the champion.
    if (svc.ledger.runs.get(String(au.run))?.status === "closed") continue;
    svc.ledger.appendEvent(by, "audit_skipped", attempt, {
      audit: id,
      run: String(au.run),
      reason: String(au.reason),
      why: "this rig has no auditor",
    });
    await promoteOrAsk(svc, attempt, String(au.run), Number(au.expected_seq), by, "no auditor");
    out.push(attempt);
  }
  return out;
}

/** What the supervisor's auditor sees for each open audit: the package and the diff. */
export async function auditPackages(svc: HarnessService): Promise<
  (AuditPackage & {
    campaign_brief?: BriefData;
    diff: string;
    owner_messages: { id: number; at: string; text: string }[];
  })[]
> {
  const audits = new Audits(svc.ledger);
  const out: (AuditPackage & {
    campaign_brief?: BriefData;
    diff: string;
    owner_messages: { id: number; at: string; text: string }[];
  })[] = [];
  for (const id of audits.pending()) {
    const row = svc.ledger.audits.get(id) as Record<string, unknown>;
    const run = String(row.run);
    const inst = requireRun(svc.ledger, run);
    // A closed run's audits are not the auditor's to decide (goal 087): nothing in it changes.
    if (inst.status === "closed") continue;
    const pkg = audits.package(id, svc.contractFor(run));
    const a = svc.ledger.attempts.get(String(row.attempt)) as Record<string, unknown>;
    const diff = await patchBetween(
      svc.mirrorFor(inst.seed_repo),
      String(a.parent_commit),
      String(a.commit_sha),
    );
    // The campaign's brief from its author, whole, before the diff (goal 078): a package too
    // long for the auditor's window is cut at its end.
    const brief = briefData(svc.contractFor(run));
    out.push({
      ...pkg,
      ...(brief ? { campaign_brief: brief } : {}),
      diff: diff.slice(0, 200_000),
      // The owner's messages the auditor has not read (to it, or to all the advisors).
      owner_messages: ownerMessagesFor(svc.messages, run, "auditor"),
      ...backgroundFor(svc, run),
    });
  }
  return out;
}

/**
 * Reviews waiting for the panel, each with the owner's messages the panel has not read: goal
 * reviews, and research reviews (goal 112) only for a supervisor that asks for them.
 */
export function reviewPackages(
  svc: HarnessService,
  kinds: readonly ReviewKind[],
): ((ReviewPackage | ResearchReviewPackage) & {
  campaign_brief?: BriefData;
  owner_messages: { id: number; at: string; text: string }[];
})[] {
  return new Reviews(svc.ledger).pending(kinds).map((pkg) => {
    // The campaign's brief from its author, whole, before the diff or the evidence (goal 078).
    const brief = briefData(svc.contractFor(pkg.run));
    const extra = {
      ...(brief ? { campaign_brief: brief } : {}),
      owner_messages: ownerMessagesFor(svc.messages, pkg.run, "review_panel"),
      ...backgroundFor(svc, pkg.run),
    };
    if (!("diff" in pkg)) return { ...pkg, ...extra };
    const { diff, ...r } = pkg;
    return {
      ...r,
      ...(brief ? { campaign_brief: brief } : {}),
      diff,
      owner_messages: extra.owner_messages,
      ...backgroundFor(svc, pkg.run),
    };
  });
}

/** A run's background from past research, for an advisor's brief or package (when it has one). */
/**
 * What an advisor's brief or package carries from past research: the background the owner
 * picked, and what the run's knowledge/ holds with how to search it (the supervisor gives the
 * advisors the search, read only). Both are data, never instructions.
 */
export function backgroundFor(
  svc: HarnessService,
  run: string,
): {
  background?: ReturnType<typeof briefingData>;
  past_research?: string;
} {
  const items = svc.ledger.runs.briefing(run);
  const knowledge = svc.knowledge.summary(run);
  return {
    ...(items.length ? { background: briefingData(items) } : {}),
    ...(knowledge ? { past_research: pastResearchLine(knowledge, "tool") } : {}),
  };
}

function ownerMessagesFor(messages: OwnerMessages, run: string, role: AdvisorRole) {
  return messages.waitingForAdvisor(run, role).map((m) => ({ id: m.id, at: m.at, text: m.text }));
}

/**
 * The auditor's decision. Block holds the attempt for good (only the owner can override), with
 * the auditor's reasons; needs_owner sends it to the owner. Clear is the last step (goal 079,
 * the owner's decision of 2026-10-22): the win is promoted, even above the audit trigger or with
 * declared flaws, unless the run asks the owner.
 */
export async function decideAudit(svc: HarnessService, input: AuditorDecision): Promise<unknown> {
  // A run closed after the auditor took its package (goal 087): its decision is not recorded.
  const held = svc.ledger.attempts.get(input.attempt);
  if (held) decidingRun(svc.ledger, String(held.run), "approve_promotion");
  const audit = new Audits(svc.ledger).decide(input);
  const a = svc.ledger.attempts.get(input.attempt) as Record<string, unknown>;
  const run = String(a.run);
  const expectedSeq = Number(audit.expected_seq);
  if (String(a.lifecycle) !== "awaiting_audit") {
    return { decision: input.decision, effect: `none: the attempt is ${a.lifecycle}` };
  }
  const toOwner = (why: string) => {
    svc.ledger.tx(() => {
      svc.ledger.appendEvent(input.auditor, "promotion_pending", input.attempt, {
        run,
        expected_seq: expectedSeq,
        commit: a.commit_sha,
        reason: why,
      });
      svc.ledger.attempts.setLifecycle(input.attempt, "awaiting_approval", input.auditor);
    });
    return { decision: input.decision, effect: "waiting for the owner" };
  };
  if (input.decision === "block") {
    svc.ledger.tx(() => {
      svc.ledger.appendEvent(input.auditor, "promotion_blocked", input.attempt, {
        reason: `blocked by the audit: ${input.reasons.slice(0, 1000)}`,
      });
      svc.ledger.attempts.setLifecycle(input.attempt, "audit_blocked", input.auditor);
    });
    return { decision: "block", effect: "blocked" };
  }
  if (input.decision === "needs_owner")
    return toOwner(`the auditor asked for the owner: ${input.reasons.slice(0, 600)}`);
  // The auditor's clear is the last step: the run's own rules decide (goal 079).
  return {
    decision: "clear",
    ...(await promoteOrAsk(
      svc,
      input.attempt,
      run,
      expectedSeq,
      input.auditor,
      "the auditor's clear",
    )),
  };
}
