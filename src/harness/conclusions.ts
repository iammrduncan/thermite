import type { GoalContract } from "../core/contract.ts";
import { PROMOTABLE_VERDICTS, SCREENED_VERDICTS } from "../core/verdicts.ts";
import { type Ledger, LedgerError } from "./ledger/index.ts";

/**
 * "Not possible" endings for goal campaigns. The harness proposes one only where the contract
 * allows it, and only from evidence in the ledger: at least `min_refuted_approaches` approach
 * families, each with several judged attempts and no progress at all. Hands-off by default
 * (goal 079): the proposal is taken and the campaign ends, unless its run asks the owner
 * (`ask_owner.not_possible`); then the owner accepts or rejects it, and until then the campaign
 * goes on. No agent can end a campaign.
 */

type Row = Record<string, unknown>;

/** Judged attempts a family needs, with no progress, before it counts as refuted. */
export const REFUTE_ATTEMPTS = 3;

/** Verdicts that show an approach is getting somewhere (so it is not refuted). */
const PROMISING = new Set([...PROMOTABLE_VERDICTS, ...SCREENED_VERDICTS]);
/**
 * Verdicts that refute an approach: a working change, judged, that did not help. Broken changes
 * (invalid, crashed) say more about the attempt than the approach, and infrastructure failures
 * say nothing.
 */
const REFUTING = new Set([
  "no_progress",
  "regress",
  "neutral",
  "not_confirmed",
  "inconclusive",
  "tradeoff",
  "infeasible",
]);

export interface RefutedApproach {
  family: string;
  description: string;
  attempts: { attempt: string; verdict: string; verdict_id: number; reasons: string }[];
}

export class Conclusions {
  private readonly ledger: Ledger;

  constructor(ledger: Ledger) {
    this.ledger = ledger;
  }

  /** Approach families with enough judged attempts and no progress, with their receipts. */
  refuted(run: string): RefutedApproach[] {
    const out: RefutedApproach[] = [];
    for (const f of this.ledger.trials.familyDescriptions(run)) {
      const attempts: RefutedApproach["attempts"] = [];
      let promising = false;
      for (const id of this.ledger.attempts.ofFamily(run, f.id)) {
        const v = this.ledger.verdicts.current(id);
        if (!v) continue;
        if (PROMISING.has(v.verdict)) promising = true;
        if (!REFUTING.has(v.verdict)) continue;
        const reasons = String(this.ledger.verdicts.get(v.id)?.reasons);
        attempts.push({
          attempt: id,
          verdict: v.verdict,
          verdict_id: v.id,
          reasons: reasons.slice(0, 500),
        });
      }
      if (!promising && attempts.length >= REFUTE_ATTEMPTS) {
        out.push({ family: f.id, description: f.description, attempts });
      }
    }
    return out;
  }

  open(run: string): Row | undefined {
    return this.ledger.conclusions.open(run);
  }

  /**
   * Proposes "not possible" when the contract allows it and the evidence is there, unless a
   * proposal is open, or the owner rejected one and there is no new refuted approach since.
   */
  maybePropose(run: string, contract: GoalContract, by: string): number | undefined {
    if (!contract.infeasibility.allowed) return undefined;
    if (this.open(run)) return undefined;
    const refuted = this.refuted(run);
    const need = contract.infeasibility.min_refuted_approaches ?? Number.POSITIVE_INFINITY;
    if (refuted.length < need) return undefined;
    const last = this.ledger.conclusions.rejectedEvidence(run);
    if (last !== undefined) {
      const before = (JSON.parse(last) as { approaches: RefutedApproach[] }).approaches.length;
      if (refuted.length <= before) return undefined;
    }
    const goals = this.ledger.goals.statuses(run);
    const evidence = {
      approaches: refuted,
      goals: [...goals].map(([goal, status]) => ({ goal, status })),
      rule: `at least ${need} approach families, each with ${REFUTE_ATTEMPTS} or more judged attempts and no progress`,
    };
    return this.ledger.tx(() => {
      const id = this.ledger.conclusions.add(run, evidence, new Date().toISOString());
      for (const a of refuted) {
        if (this.ledger.trials.setFamilyStatus(run, a.family, "exhausted", "live")) {
          this.ledger.appendEvent(by, "family_status", run, {
            family: a.family,
            status: "exhausted",
            reason: `refuted: evidence for "not possible" proposal ${id}`,
          });
        }
      }
      this.ledger.appendEvent(by, "conclusion_proposed", run, {
        proposal: id,
        kind: "not_possible",
        approaches: refuted.map((a) => ({ family: a.family, attempts: a.attempts.length })),
      });
      return id;
    });
  }

  /**
   * The decision: the owner's, or the harness's where the run does not ask (goal 079). Accepting
   * closes the run; rejecting lets the campaign go on.
   */
  decide(
    run: string,
    proposal: number,
    accept: boolean,
    note: string | undefined,
    by: string,
    closeReason = "not possible: the owner accepted the evidence",
  ) {
    return this.ledger.tx(() => {
      const row = this.ledger.conclusions.get(run, proposal);
      if (!row) throw new LedgerError("not_found", `no proposal ${proposal} in ${run}`);
      if (row.decision !== null)
        throw new LedgerError("conflict", `proposal ${proposal} is decided`);
      const decision = accept ? "accepted" : "rejected";
      this.ledger.conclusions.decide(
        proposal,
        decision,
        note?.slice(0, 2000) ?? null,
        new Date().toISOString(),
      );
      this.ledger.appendEvent(by, accept ? "conclusion_accepted" : "conclusion_rejected", run, {
        proposal,
        kind: String(row.kind),
      });
      if (accept) {
        this.ledger.runs.setStatus(run, "closed", closeReason, by);
      } else {
        // The owner wants the campaign to go on: the families this proposal exhausted reopen.
        const families = (JSON.parse(String(row.evidence)) as { approaches: { family: string }[] })
          .approaches;
        for (const f of families) {
          if (this.ledger.trials.setFamilyStatus(run, f.family, "live", "exhausted")) {
            this.ledger.appendEvent(by, "family_status", run, {
              family: f.family,
              status: "live",
              reason: `the owner rejected "not possible" proposal ${proposal}`,
            });
          }
        }
      }
      return { proposal, decision };
    });
  }
}
