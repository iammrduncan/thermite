import { heldOutWords } from "../judge/index.ts";
import { type EpochSource, type FamilyStatus, type Ledger, LedgerError } from "../ledger/index.ts";
import { shownViolations, violationsOf } from "../v0.ts";

/**
 * Agent state in the ledger: the direction registry (approach families and how they fared),
 * planner epochs, worker trials and each lane's retained best. The judge never reads any of it;
 * verdicts stay the judge's alone.
 */

type Row = Record<string, unknown>;

export interface FamilyView {
  id: string;
  description: string;
  status: FamilyStatus;
  attempts: number;
  verdicts: Record<string, number>;
  best_delta: number | null;
}

export interface Assignment {
  lane: string;
  family: string;
  focus: string;
  parent: "champion" | "lane_best";
  /** The MANDATE or TRY directive this assignment follows, when it follows one. */
  directive?: number | undefined;
  /** The experiment from the run's queue the lane's next trial takes, and why it got it. */
  experiment?: string | undefined;
  why?: string | undefined;
}

export interface EpochRecord {
  n: number;
  source: EpochSource;
  assignments: Assignment[];
  /** Directive ids in force when the epoch was planned. */
  directives: number[];
  started_at: string;
  ended_at: string | null;
}

export interface Evidence {
  attempt: string;
  lane: string | null;
  family: string | null;
  hypothesis: string | null;
  lifecycle: string;
  verdict: string | null;
  delta: number | null;
  /**
   * A change the static checks refused before building: why, bounded (the first 5), and how
   * many violations there were in all (goal 082). Left out when it was not refused.
   */
  refused?: { violations: string[]; total: number } | undefined;
  /**
   * When its confirmation failed on held-out cells: that a held-out check failed, and how, in
   * fixed words (goal 082). Never which cell, its values or its texts.
   */
  held_out?: string | undefined;
}

/** How many of a refused change's violations the planner's and the teachers' evidence shows. */
const EVIDENCE_VIOLATIONS = 5;

/**
 * One attempt's evidence, from its row (id, lane, family, hypothesis, lifecycle and v0): the one
 * shape the planner's evidence, the teachers' brief and their read_evidence tool share (goals 081
 * and 082).
 */
export function evidenceOf(ledger: Ledger, r: Row): Evidence {
  const v = ledger.verdicts.current(String(r.id));
  const d = v ? ledger.verdicts.get(v.id)?.delta : null;
  const refused = violationsOf(r.v0);
  const heldOut = ledger.heldOut.failure(String(r.id));
  return {
    attempt: String(r.id),
    lane: r.lane === null || r.lane === undefined ? null : String(r.lane),
    family: r.family === null || r.family === undefined ? null : String(r.family),
    hypothesis:
      r.hypothesis === null || r.hypothesis === undefined
        ? null
        : String(r.hypothesis).slice(0, 300),
    lifecycle: String(r.lifecycle),
    verdict: v?.verdict ?? null,
    delta: typeof d === "number" ? d : null,
    ...(refused.length ? { refused: shownViolations(refused, EVIDENCE_VIOLATIONS) } : {}),
    ...(heldOut ? { held_out: heldOutWords(heldOut) } : {}),
  };
}

export class Registry {
  private readonly ledger: Ledger;

  constructor(ledger: Ledger) {
    this.ledger = ledger;
  }

  /**
   * A new direction for the run. `forRules`: the rules in force that named it before the run had
   * it, when the planner designed it for them (goal 066); its event says so.
   */
  addFamily(run: string, id: string, description: string, by: string, forRules?: number[]): void {
    this.ledger.tx(() => {
      if (this.ledger.trials.addFamily(run, id, description, by))
        this.ledger.appendEvent(by, "family_added", run, {
          family: id,
          description,
          ...(forRules?.length ? { for_rules: forRules } : {}),
        });
    });
  }

  families(run: string): FamilyView[] {
    return this.ledger.trials.families(run).map((f) => {
      const attempts = this.ledger.attempts.ofFamily(run, f.id);
      const verdicts: Record<string, number> = {};
      let best: number | null = null;
      for (const a of attempts) {
        const v = this.ledger.verdicts.current(a);
        const key = v?.verdict ?? String(this.ledger.attempts.get(a)?.lifecycle);
        verdicts[key] = (verdicts[key] ?? 0) + 1;
        const d = v ? this.ledger.verdicts.get(v.id)?.delta : null;
        if (typeof d === "number" && (best === null || d > best)) best = d;
      }
      return {
        id: f.id,
        description: f.description,
        status: f.status,
        attempts: attempts.length,
        verdicts,
        best_delta: best,
      };
    });
  }

  tagAttempt(attempt: string, family: string): void {
    this.ledger.attempts.setFamily(attempt, family);
  }

  /** The newest judged evidence, for the planner and for briefs. */
  evidence(run: string, limit = 30, lane?: string): Evidence[] {
    return this.ledger.attempts.newest(run, limit, lane).map((r) => evidenceOf(this.ledger, r));
  }

  currentEpoch(run: string): EpochRecord | undefined {
    const r = this.ledger.trials.newestEpochs(run, 1)[0];
    return r
      ? {
          n: Number(r.n),
          source: String(r.source) as EpochRecord["source"],
          assignments: JSON.parse(String(r.assignments)) as Assignment[],
          directives: JSON.parse(String(r.directives ?? "[]")) as number[],
          started_at: String(r.started_at),
          ended_at: r.ended_at === null ? null : String(r.ended_at),
        }
      : undefined;
  }

  startEpoch(input: {
    run: string;
    n: number;
    source: EpochSource;
    tries: number;
    valid: boolean;
    rawViolations: string[];
    assignments: Assignment[];
    directives?: number[] | undefined;
    notes?: string | undefined;
    /**
     * "research": planned by the research plan in code on purpose (the planner is off), not a
     * refused plan.
     * "setup": a hill climb's setup round (goal 115), from the judge's reasons, not by a model.
     */
    plan?: "research" | "setup" | undefined;
    /** Why each of the model's tries gave no usable plan (goal 079). */
    causes?: { try: number; cause: string; detail: string }[] | undefined;
    by: string;
  }): void {
    this.ledger.tx(() => {
      this.ledger.trials.startEpoch(input);
      this.ledger.appendEvent(input.by, "epoch_started", input.run, {
        n: input.n,
        source: input.source,
        // A research run's rounds and a hill climb's setup rounds are planned by a fixed method on
        // purpose: say so, so a reader does not take their "fallback" source for a refused plan.
        ...(input.plan ? { plan: input.plan } : {}),
        ...(input.notes ? { notes: input.notes.slice(0, 500) } : {}),
        planner_tries: input.tries,
        planner_valid: input.valid,
        raw_violations: input.rawViolations.length,
        // Why the model's plans were refused (the first few, shortened), so a fallback says why.
        ...(input.rawViolations.length
          ? { refused: input.rawViolations.slice(0, 4).map((v) => v.slice(0, 300)) }
          : {}),
        // The real cause of each try that gave no plan: timeout, text only, cut off, the
        // provider's error, cancelled, or refused with which rules (goal 079).
        ...(input.causes?.length
          ? {
              causes: input.causes
                .slice(0, 4)
                .map((c) => ({ try: c.try, cause: c.cause, detail: c.detail.slice(0, 300) })),
            }
          : {}),
        directives: input.directives ?? [],
        assignments: input.assignments.map((a) => ({
          lane: a.lane,
          family: a.family,
          // What the lane is asked to do, for control's "at work now" (the brief has it all).
          focus: a.focus.slice(0, 300),
          parent: a.parent,
          ...(a.directive === undefined ? {} : { directive: a.directive }),
          ...(a.experiment ? { experiment: a.experiment } : {}),
        })),
      });
    });
  }

  endEpoch(run: string, n: number, by: string): void {
    this.ledger.tx(() => {
      this.ledger.trials.endEpoch(run, n);
      this.ledger.appendEvent(by, "epoch_ended", run, { n });
    });
  }

  /**
   * Starts a trial with its own token (only its hash is stored). The worker presents the token
   * to the API; the harness binds every call to this trial's run and lane, and the token
   * stops working when the trial ends.
   */
  startTrial(t: {
    id: string;
    run: string;
    lane: string;
    epoch: number;
    family: string;
    parent: string;
    token?: string | undefined;
    /** The lane's focus for this trial, as the planner gave it. */
    focus?: string | undefined;
  }): void {
    this.ledger.tx(() => {
      this.ledger.trials.startTrial(t);
      // Control learns that a lane is at work, and on what, from the record, not the live view.
      this.ledger.appendEvent("scheduler", "trial_started", t.run, {
        trial: t.id,
        lane: t.lane,
        epoch: t.epoch,
        family: t.family,
        ...(t.focus ? { focus: t.focus.slice(0, 300) } : {}),
      });
    });
  }

  /** The open trial a token belongs to; throws when the token is unknown or the trial ended. */
  openTrial(token: string): {
    id: string;
    run: string;
    lane: string;
    family: string | null;
    parent: string;
    attempt: string | null;
  } {
    const r = token ? this.ledger.trials.byToken(token) : undefined;
    if (!r) throw new LedgerError("not_found", "unknown trial");
    if (r.ended_at !== null) throw new LedgerError("stale", `trial ${r.id} has ended`);
    return {
      id: r.id,
      run: r.run,
      lane: r.lane,
      family: r.family,
      parent: r.parent_commit,
      attempt: r.attempt,
    };
  }

  /** Links a submission to its trial as it is recorded (one per trial). */
  linkAttempt(trial: string, attempt: string): void {
    this.ledger.tx(() => {
      if (!this.ledger.trials.linkAttempt(trial, attempt))
        throw new LedgerError("conflict", `trial ${trial} already has an attempt`);
      const t = this.ledger.trials.get(trial);
      if (t?.family) this.tagAttempt(attempt, t.family);
    });
  }

  /** The attempt linked to a trial as it submitted, if any. */
  attemptOf(trial: string): string | undefined {
    return this.ledger.trials.get(trial)?.attempt || undefined;
  }

  /** The lane's newest finished trials, newest first (for backoff). */
  recentTrials(
    run: string,
    lane: string | null,
    n: number,
  ): { stopped: string; attempt: string | null; ended_at: string; error: string | null }[] {
    return this.ledger.trials.recent(run, lane, n);
  }

  /** Tokens the run's agents have used (trials; the planner's calls are not counted yet). */
  tokensUsed(run: string): { in: number; out: number } {
    return this.ledger.trials.tokens(run);
  }

  finishTrial(
    id: string,
    r: {
      attempt?: string | undefined;
      stopped: string;
      turns: number;
      toolCalls: number;
      tokensIn: number;
      tokensOut: number;
      /** How many times its conversation was compacted (goal 070): in the event only. */
      compactions?: number | undefined;
      /** Model calls whose usage its worker could not hand over (goal 075): in the event only. */
      usageUnrecorded?: number | undefined;
      error?: string | undefined;
    },
    by: string,
  ): void {
    this.ledger.tx(() => {
      this.ledger.trials.finishTrial(id, r);
      const t = this.ledger.trials.get(id);
      this.ledger.appendEvent(by, "trial_finished", String(t?.run ?? ""), {
        trial: id,
        lane: t?.lane ?? null,
        epoch: t?.epoch ?? null,
        family: t?.family ?? null,
        attempt: t?.attempt ?? null,
        stopped: r.stopped,
        turns: r.turns,
        tokens_in: r.tokensIn,
        tokens_out: r.tokensOut,
        ...(r.compactions ? { compactions: r.compactions } : {}),
        ...(r.usageUnrecorded ? { usage_unrecorded: r.usageUnrecorded } : {}),
        // Why a trial failed reaches control too (the ledger keeps the longer text).
        error: r.error?.slice(0, 300) ?? null,
      });
    });
  }

  /**
   * Trials a dead controller left unfinished. Their worker processes died with it; the trials
   * are closed as interrupted (any submission they made stands), so their lanes can go on. Each
   * keeps the counters its worker last reported (goal 079): the work it did still counts.
   */
  interruptUnfinished(by: string): string[] {
    const open = this.ledger.trials.open();
    for (const t of open) {
      this.finishTrial(
        t.id,
        {
          stopped: "interrupted",
          turns: t.turns ?? 0,
          toolCalls: t.tool_calls ?? 0,
          tokensIn: t.tokens_in ?? 0,
          tokensOut: t.tokens_out ?? 0,
          error: "the harness restarted while this trial ran",
        },
        by,
      );
    }
    return open.map((t) => t.id);
  }

  /** Trials of a lane in an epoch (finished or running). */
  trials(
    run: string,
    lane: string,
    epoch: number,
  ): { id: string; attempt: string | null; ended: boolean }[] {
    return this.ledger.trials.ofLane(run, lane, epoch);
  }

  laneBest(run: string, lane: string): string | null {
    return this.ledger.trials.laneBest(run, lane);
  }

  clearLaneBest(run: string, lane: string, by: string, reason: string): void {
    this.ledger.tx(() => {
      if (this.ledger.trials.clearLaneBest(run, lane))
        this.ledger.appendEvent(by, "lane_best", run, { lane, attempt: null, reason });
    });
  }

  setLaneBest(run: string, lane: string, attempt: string, by: string): void {
    this.ledger.tx(() => {
      this.ledger.trials.setLaneBest(run, lane, attempt);
      this.ledger.appendEvent(by, "lane_best", run, { lane, attempt });
    });
  }

  /** Duplicate rate: attempts recorded as duplicates over all recorded attempts. */
  duplicateRate(run: string): { duplicates: number; attempts: number } {
    const counts = this.ledger.attempts.lifecycles(run);
    const attempts = Object.values(counts).reduce((a, b) => a + b, 0);
    return { duplicates: counts.duplicate ?? 0, attempts };
  }
}
