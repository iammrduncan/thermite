import { CODE_RESEARCH_TOOLS, researchTool } from "../../../agents/tools/index.ts";
import { log } from "../../../common/env.ts";
import { type Ledger, LedgerError } from "../../ledger/index.ts";
import type { TaskYield } from "../../queue.ts";
import { addClaim } from "./claims.ts";
import { clockOf } from "./clock.ts";
import { type ResearchContext, researchContext } from "./context.ts";
import { addFinding } from "./findings.ts";
import {
  hypothesesBrief,
  proposeHypothesis,
  reviseHypothesis,
  setHypothesisStatus,
} from "./hypotheses.ts";
import { addNote } from "./notes.ts";
import { report, updateSection } from "./report.ts";
import { fetchSource, frontier, readSource, searchCorpus } from "./sources.ts";
import { statsOf } from "./stats.ts";
import { trialYield } from "./yield.ts";

/** The research service's operations a hill-climb or goal run takes (its code trials' tools). */
const CODE_OPS = new Set(CODE_RESEARCH_TOOLS.map((n) => researchTool(n)?.op ?? n));

/**
 * Research mode's integrity rules, enforced by code (the research form of "agents never judge"):
 *
 * - a claim is verified only when every quote appears verbatim in the archived text of a source
 *   the harness itself fetched, and every number in the claim appears in its quotes; anything
 *   else stays a draft;
 * - a verified claim is corroborated when its quotes come from at least the contract's number of
 *   independent domains: registrable domains, so docs.example.com and blog.example.com are one;
 * - a finding is a worker's conclusion with a summary and why it matters; it is reported as a
 *   finding only when every claim it cites is verified and every number in it appears in those
 *   claims; anything else stays a draft finding;
 * - sources are deduplicated by URL and by content hash, claims by their text;
 * - reports show worker-written sections as notes, never as findings, and flag numbers in them
 *   that no verified claim supports;
 * - the harness owns the clock (running time only): workers cannot end a campaign.
 *
 * The class holds the service's state and is its interface. The bodies of its operations are in
 * research/, a module for each part: sources.ts (fetch, read and search the archive, and the
 * links to follow), claims.ts, notes.ts, findings.ts, hypotheses.ts (with the brief's list and
 * the free functions the harness's service calls), yield.ts (what a trial added), clock.ts,
 * stats.ts and report.ts. context.ts holds what they share.
 */

export { normalizeQuote } from "../checks.ts";
export { ClaimInput } from "./claims.ts";
export { FindingInput } from "./findings.ts";
export {
  HYPOTHESIS_STATUS,
  HYPOTHESIS_STATUS_CHANGES,
  HypothesisInput,
  HypothesisRevision,
  type HypothesisStatusChange,
  HypothesisStatusInput,
  setHypothesisStatus,
  startingHypotheses,
} from "./hypotheses.ts";
export { NOTE_REPEATS } from "./notes.ts";
export { archiveUrl } from "./sources.ts";

export class Research {
  /** What the research service's parts share (research/context.ts). */
  private readonly ctx: ResearchContext;
  /** Told after each change to a run's research (the research folder follows it). */
  onChange: ((run: string) => void) | undefined;

  constructor(
    ledger: Ledger,
    stateDir: string,
    opts: {
      allowPrivate?: boolean;
      maxCorpusBytes?: number;
      onChange?: ((run: string) => void) | undefined;
    } = {},
  ) {
    this.ctx = researchContext(ledger, stateDir, opts, (run) => this.changed(run));
    this.onChange = opts.onChange;
  }

  /** A change is recorded: the folder follows; a failure there never fails the change. */
  private changed(run: string): void {
    try {
      this.onChange?.(run);
    } catch (err) {
      log("harness", "research folder not updated", { run, error: String(err) });
    }
  }

  /**
   * Workers may act only on a running run. A research run takes every operation; a hill-climb or
   * goal run records sources, claims and notes (goal 065), and the rest belongs to research runs.
   */
  requireRunning(run: string, op?: string | undefined): void {
    const inst = this.ctx.ledger.runs.get(run);
    if (!inst) throw new LedgerError("not_found", `no run ${run}`);
    if (inst.status !== "running") throw new LedgerError("invalid", `run ${run} is ${inst.status}`);
    if (inst.mode !== "research" && (op === undefined || !CODE_OPS.has(op)))
      throw new LedgerError(
        "invalid",
        `a ${inst.mode.replace(/_/g, "-")} run records sources, claims and notes only (${CODE_RESEARCH_TOOLS.join(", ")}); the rest belongs to research runs`,
      );
  }

  /** A page fetched and archived for the run, as its worker sees it: research/sources.ts. */
  fetch(run: string, lane: string | null, url: string) {
    return fetchSource(this.ctx, run, lane, url);
  }

  /** Part of an archived source's text, from an offset: research/sources.ts. */
  read(run: string, source: string, offset?: number, length?: number) {
    return readSource(this.ctx, run, source, offset, length);
  }

  /** Plain-text search over the archived texts, a page at a time: research/sources.ts. */
  searchCorpus(run: string, text: string, skip?: number) {
    return searchCorpus(this.ctx, run, text, skip);
  }

  /** A worker's claim, verified or kept as a draft: research/claims.ts. */
  addClaim(run: string, lane: string | null, input: unknown) {
    return addClaim(this.ctx, run, lane, input);
  }

  /** A research note, with the sources it relies on: research/notes.ts. */
  addNote(
    run: string,
    lane: string | null,
    text: string,
    sources?: string[],
    trial?: string | undefined,
  ) {
    return addNote(this.ctx, run, lane, text, sources, trial);
  }

  /** A worker's hypothesis for the run's pool: research/hypotheses.ts. */
  proposeHypothesis(run: string, lane: string | null, input: unknown) {
    return proposeHypothesis(this.ctx, run, lane, input);
  }

  /** A worker changes a pool hypothesis: research/hypotheses.ts. */
  reviseHypothesis(run: string, lane: string | null, input: unknown) {
    return reviseHypothesis(this.ctx, run, lane, input);
  }

  /**
   * Promotes, returns or retires a hypothesis (goal 117), as setHypothesisStatus does; the folder
   * follows. The planner's promotions and retirements come here, as the owner's command does.
   */
  hypothesisStatus(run: string, input: unknown, by: string) {
    const r = setHypothesisStatus(this.ctx.ledger, run, input, by);
    if (r.changed) this.changed(run);
    return r;
  }

  /** A finding, citing verified claims, checked by code: research/findings.ts. */
  addFinding(run: string, lane: string | null, input: unknown) {
    return addFinding(this.ctx, run, lane, input);
  }

  /** The hypotheses as a research worker's brief shows them: research/hypotheses.ts. */
  hypothesesBrief(run: string): string {
    return hypothesesBrief(this.ctx, run);
  }

  /** What a research trial added: research/yield.ts. */
  trialYield(run: string, trial: string, until?: string): TaskYield | undefined {
    return trialYield(this.ctx, run, trial, until);
  }

  /** A worker's section of the run's report: research/report.ts. */
  updateSection(run: string, by: string | null, name: string, body: string) {
    return updateSection(this.ctx, run, by, name, body);
  }

  /** The run's clock; with `now`, as it stood then: research/clock.ts. */
  clock(run: string, now?: number) {
    return clockOf(this.ctx, run, now);
  }

  /** The run's figures: research/stats.ts. */
  stats(run: string) {
    return statsOf(this.ctx, run);
  }

  /** A report version from the ledger, digest or final: research/report.ts. */
  report(run: string, kind: "digest" | "final", opts?: { noPaper?: string | undefined }) {
    return report(this.ctx, run, kind, opts);
  }

  lastReportAt(run: string): string | undefined {
    return this.ctx.ledger.reports.newest(run)?.created_at;
  }

  /** Links from archived sources that are not archived yet: research/sources.ts. */
  frontier(run: string, limit?: number): string[] {
    return frontier(this.ctx, run, limit);
  }
}
