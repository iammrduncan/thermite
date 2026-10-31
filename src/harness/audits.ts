import type { Contract } from "../core/contract.ts";
import { toFraction } from "../core/stats.ts";
import { type Ledger, LedgerError } from "./ledger/index.ts";

/**
 * Audits. The judge flags a promotable result for audit (open known flaws, a gain above the
 * contract's audit trigger, or a goal campaign's adversarial checklist) and holds it while the
 * rig has an auditor. The supervisor's auditor answers clear, block or needs_owner. Its clear is
 * the last step (goal 079, the owner's decision of 2026-10-22: hands-off by default): the win is
 * promoted, even above the trigger or with declared flaws, unless the run asks the owner. Its
 * block stops the win, with its reasons. Without an auditor, the audit is skipped and recorded
 * so. Each confirmation of an attempt gets its own audit, against the champion it was confirmed
 * against.
 */

type Row = Record<string, unknown>;

export type AuditDecision = "clear" | "block" | "needs_owner";
export type AuditTriggerKind = "absolute" | "ratio" | "known_flaws" | "adversarial_checklist";

export interface AuditPackage {
  id: number;
  attempt: string;
  run: string;
  reason: string;
  requested_at: string;
  hypothesis: string | null;
  claim: string | null;
  known_flaws: string[];
  verdict: { verdict: string; delta: number | null; ci_low: number | null; ci_high: number | null };
  contract: {
    title: string;
    mode: string;
    objective: string;
    editable_paths: string[];
    insufficient: string[];
    adversarial_checklist: string[];
  };
  /** What the judge checked before its verdict (goal 137), from its own records. */
  checked: AuditChecks;
}

/** A guard's result as the judge recorded it: changes as fractions, positive meaning better. */
export interface AuditGuard {
  metric: string;
  direction: string;
  max_step_regression: number;
  max_total_regression: number;
  status: string | null;
  change: number | null;
  low: number | null;
  high: number | null;
  vs_start?: { change: number | null; noise: number | null; spent: boolean };
}

export type AuditChecks =
  | {
      said: string;
      cells: string[];
      confirm_blocks: number;
      guards: AuditGuard[];
      hard_constraints: { kind: "min" | "max"; metric: string; value: number }[];
    }
  | { said: string; goals: { goal: string; status: string }[] };

export const HILL_CLIMB_CHECKED =
  "What the judge checked before this verdict, from its own records. It measured the change " +
  "against the champion on these cells and confirmed the gain on fresh blocks. The kit's check " +
  "ran on the outputs of every run of the change: a failed check makes a change invalid, so " +
  "every measured run of this change passed it. Each guard has the judge's result: change is the " +
  "guard metric against the champion (a fraction, positive is better) with its interval, and " +
  "vs_start is against the run's starting point. Any hard constraints held on every cell.";
export const GOAL_CHECKED =
  "What the judge checked before this verdict, from its own records: each goal's status from " +
  "the kit's verifiers or the goal's threshold (met, unmet, inconclusive or not_runnable).";

/** The checks behind a verdict: the contract's guards and constraints, with the verdict's results. */
function checksOf(contract: Contract, recorded: Row[]): AuditChecks {
  if (contract.mode !== "hill_climb") {
    const goals = recorded.flatMap((r) =>
      typeof r.goal === "string" ? [{ goal: r.goal, status: String(r.status) }] : [],
    );
    return { said: GOAL_CHECKED, goals };
  }
  const frac = (x: unknown) => (typeof x === "number" ? toFraction(x) : null);
  return {
    said: HILL_CLIMB_CHECKED,
    cells: contract.cells,
    confirm_blocks: contract.acceptance.confirm_blocks,
    guards: contract.guards.map((g) => {
      const r = recorded.find((x) => x.metric === g.metric);
      const s = r?.vs_start as Row | undefined;
      return {
        ...g,
        status: typeof r?.status === "string" ? r.status : null,
        change: frac(r?.estimate),
        low: frac(r?.low),
        high: frac(r?.high),
        ...(s
          ? { vs_start: { change: frac(s.estimate), noise: frac(s.noise), spent: !!s.spent } }
          : {}),
      };
    }),
    // A named check is not one the judge runs on its own: only the measured limits are listed.
    hard_constraints: contract.hard_constraints.flatMap((h) => (h.kind === "check" ? [] : [h])),
  };
}

/** Why a promotable result needs an audit, or undefined. */
export function auditTrigger(input: {
  contract: Contract;
  knownFlaws: unknown[];
  delta: number | null | undefined;
  priorDeltas: number[];
}): { kind: AuditTriggerKind; reason: string } | undefined {
  const { contract } = input;
  if (input.knownFlaws.length) return { kind: "known_flaws", reason: "declared flaws" };
  if (contract.mode === "goal") {
    return contract.adversarial_checklist.length
      ? { kind: "adversarial_checklist", reason: "the contract's adversarial checklist" }
      : undefined;
  }
  if (contract.mode !== "hill_climb" || typeof input.delta !== "number") return undefined;
  const { ratio_to_median, absolute } = contract.acceptance.audit;
  if (input.delta > absolute)
    return {
      kind: "absolute",
      reason: `gain ${(input.delta * 100).toFixed(1)}% above ${absolute * 100}%`,
    };
  const prior = [...input.priorDeltas].filter((d) => d > 0).sort((a, b) => a - b);
  if (prior.length >= 3) {
    const median = prior[Math.floor(prior.length / 2)] as number;
    if (input.delta > ratio_to_median * median) {
      return {
        kind: "ratio",
        reason: `gain ${(input.delta * 100).toFixed(1)}% above ${ratio_to_median}x the median confirmed gain`,
      };
    }
  }
  return undefined;
}

export class Audits {
  private readonly ledger: Ledger;

  constructor(ledger: Ledger) {
    this.ledger = ledger;
  }

  /** Confirmed gains of earlier wins in the run (for the ratio-to-median trigger). */
  priorDeltas(run: string, except: string): number[] {
    return this.ledger.verdicts.confirmedDeltas(run, except);
  }

  /** Records an audit request; the caller holds the attempt in awaiting_audit (same transaction). */
  request(input: {
    attempt: string;
    /** The confirmation job that held the attempt: one audit per confirmation. */
    job: number;
    run: string;
    trigger: AuditTriggerKind;
    reason: string;
    expectedSeq: number;
    by: string;
  }): number {
    return this.ledger.tx(() => {
      const id = this.ledger.audits.add({
        attempt: input.attempt,
        job: input.job,
        run: input.run,
        trigger: input.trigger,
        reason: input.reason,
        expectedSeq: input.expectedSeq,
        at: new Date().toISOString(),
      });
      this.ledger.appendEvent(input.by, "audit_requested", input.attempt, {
        audit: id,
        run: input.run,
        reason: input.reason,
        expected_seq: input.expectedSeq,
      });
      return id;
    });
  }

  /** The attempt's current audit: the one for its latest confirmation. */
  get(attempt: string): Row | undefined {
    return this.ledger.audits.current(attempt);
  }

  /** Open audits (the current one of each attempt still held for one). */
  pending(): number[] {
    return this.ledger.audits.pending();
  }

  /**
   * What an auditor sees: the claim, the judge's verdict, what the judge checked and the
   * contract's rules. The diff is added by the service (from git). Never held-out results: those
   * stay with promotion code.
   */
  package(id: number, contract: Contract): AuditPackage {
    const au = this.ledger.audits.get(id);
    if (!au) throw new LedgerError("not_found", `no audit ${id}`);
    const a = this.ledger.attempts.get(String(au.attempt)) as Row;
    const current = this.ledger.verdicts.current(String(au.attempt));
    const v = current ? this.ledger.verdicts.get(current.id) : undefined;
    const num = (x: unknown) => (typeof x === "number" ? x : null);
    return {
      id,
      attempt: String(au.attempt),
      run: String(au.run),
      reason: String(au.reason),
      requested_at: String(au.requested_at),
      hypothesis: a.hypothesis === null ? null : String(a.hypothesis),
      claim: a.claim === null ? null : String(a.claim),
      known_flaws: JSON.parse(String(a.known_flaws)) as string[],
      verdict: {
        verdict: String(v?.verdict ?? "none"),
        delta: num(v?.delta),
        ci_low: num(v?.ci_low),
        ci_high: num(v?.ci_high),
      },
      contract: {
        title: contract.title,
        mode: contract.mode,
        objective:
          contract.mode === "hill_climb"
            ? `${contract.objective.primary.direction} ${contract.objective.primary.metric}`
            : contract.mode === "goal"
              ? contract.goals.map((g) => `${g.id}: ${g.description}`).join("; ")
              : contract.topic,
        editable_paths: "editable_paths" in contract ? contract.editable_paths : [],
        insufficient: contract.mode === "goal" ? contract.insufficient : [],
        adversarial_checklist: contract.mode === "goal" ? contract.adversarial_checklist : [],
      },
      checked: checksOf(contract, JSON.parse(String(v?.guards ?? "[]")) as Row[]),
    };
  }

  /** Writes the decision once. Returns the audit row as it was before the decision. */
  decide(input: {
    attempt: string;
    decision: AuditDecision;
    reasons: string;
    citations: string[];
    auditor: string;
  }): Row {
    return this.ledger.tx(() => {
      const au = this.get(input.attempt);
      if (!au) throw new LedgerError("not_found", `no audit for ${input.attempt}`);
      if (au.decision !== null) {
        throw new LedgerError("conflict", `the audit of ${input.attempt} is already decided`);
      }
      this.ledger.audits.decide(
        Number(au.id),
        {
          decision: input.decision,
          reasons: input.reasons.slice(0, 8000),
          citations: input.citations.slice(0, 20),
          auditor: input.auditor,
        },
        new Date().toISOString(),
      );
      this.ledger.appendEvent(input.auditor, "audit_decided", input.attempt, {
        audit: Number(au.id),
        decision: input.decision,
        reasons: input.reasons.slice(0, 1000),
      });
      return au;
    });
  }
}
