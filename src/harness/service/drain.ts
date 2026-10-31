import { MAX_LANES } from "../../core/contract.ts";
import { type Ledger, LedgerError } from "../ledger/index.ts";
import type { TrialFacts } from "./watch.ts";

/**
 * The rig's drain before its images change (goal 079): no new trial, plan or judge job starts,
 * and those running end as they would. The harness keeps it in memory only, and the restart it
 * prepares ends it. The ledger keeps each change as `rig_drain`, and the harness records the end
 * of a drain that a restart ended when it starts again (goal 136), so a research run's clock can
 * leave the drain out. The rig's report lists each open trial, and the owner can stop one
 * (`stop_trial`): while it drains, those are the trials it waits for.
 */

export interface Draining {
  since: string;
  reason: string;
  by: string;
  /**
   * When it stops waiting by itself (goal 173): its command's `deadline_minutes` after `since`,
   * else the rig's THERMITE_DRAIN_MINUTES.
   */
  deadline: string;
  /** When its deadline passed; absent before. The rig then waits for the owner's choice. */
  deadline_reached?: string | undefined;
}

/** The reason recorded for the end of a drain that a restart ended. */
export const RESTARTED = "the harness started again";

/**
 * The drain after a `drain_rig` command: a drain under way stays as it began, its deadline too. A
 * new one waits `deadline_minutes`, or the rig's `minutes`, before its deadline.
 */
export function drainAfter(
  now: Draining | undefined,
  p: { drain: boolean; reason?: string | undefined; deadline_minutes?: number | undefined },
  by: string,
  at: Date,
  minutes: number,
): Draining | undefined {
  if (!p.drain) return undefined;
  if (now) return now;
  const wait = (p.deadline_minutes ?? minutes) * 60_000;
  return {
    since: at.toISOString(),
    reason: p.reason ?? "its images are about to change",
    by,
    deadline: new Date(at.getTime() + wait).toISOString(),
  };
}

/**
 * A drain at its deadline (goal 173) stops waiting by itself: the ledger records the step once
 * (`rig_drain` with `deadline_reached`), with what still runs. The rig goes on starting nothing new
 * until the owner chooses, on its page or under Needs you: the change now, which stops what still
 * runs, or the end of the drain. Nothing is chosen for the owner. True when it recorded the step.
 */
export function drainDeadline(
  svc: { ledger: Ledger; draining: Draining | undefined },
  at: Date,
): boolean {
  const d = svc.draining;
  if (!d || d.deadline_reached || at.getTime() < Date.parse(d.deadline)) return false;
  d.deadline_reached = at.toISOString();
  const { open: _open, ...w } = workNow(svc.ledger, at, d);
  svc.ledger.appendEvent("harness", "rig_drain", null, {
    drain: true,
    reason: d.reason,
    deadline: d.deadline,
    deadline_reached: true,
    ...w,
  });
  return true;
}

/** At start: a drain the ledger leaves open was ended by the restart. Records its end. */
export function endDrainAtStart(ledger: Ledger, by: string): boolean {
  if (ledger.events.newest("rig_drain")?.body.drain !== true) return false;
  ledger.appendEvent(by, "rig_drain", null, { drain: false, reason: RESTARTED });
  return true;
}

/**
 * When the rig drained, oldest first: from each `rig_drain` that starts a drain to the one that
 * ends it, or to the first trial started after it. A draining rig starts no trial, so a trial's
 * start shows the drain had ended: a harness older than goal 136 recorded no end at its restart.
 * A drain still under way runs to `now`.
 */
export function drainSpans(ledger: Ledger, now: number): [number, number][] {
  const first = ledger.events.list("rig_drain")[0];
  if (!first) return [];
  const spans: [number, number][] = [];
  let since: number | null = null;
  for (const e of ledger.events.list(["rig_drain", "trial_started"], { after: first.id - 1 })) {
    const at = Date.parse(e.at);
    // Asked again while it drains: the same drain.
    if (e.kind === "rig_drain" && "drain" in e.body && e.body.drain === true) since ??= at;
    else if (since !== null) {
      spans.push([since, at]);
      since = null;
    }
  }
  if (since !== null) spans.push([since, now]);
  return spans;
}

/**
 * An open trial, as the rig's report gives it (goal 136, item 3): while the rig drains, one it
 * waits for. With what it is doing (goal 143): when it last sent a line, its open model call and
 * a streak of the same calls.
 */
export interface OpenTrial extends TrialFacts {
  trial: string;
  run: string;
  lane: string;
  started_at: string;
  /** Its experiment's title, and a research task's question (from 0). */
  task: string | null;
  question: number | null;
  /** What its worker last reported. */
  turns: number;
  tool_calls: number;
  tokens_in: number;
  /** The verified claims it recorded, for a research trial; null for a code trial. */
  claims: number | null;
  /**
   * Its newest ask for a page the run refused before for a reason that lasts (a `fetch_refused`
   * with `asked`): the URL, why, how many times the run asked for it, when, and how many such
   * asks this trial made. Null when it made none.
   */
  refused_again: { url: string; reason: string; asked: number; at: string; times: number } | null;
}

/** What still runs, for the rig's report (goal 079), with each open trial (goal 143). */
export interface Work {
  trials: number;
  judge_jobs: number;
  draining: Draining | null;
  open?: OpenTrial[];
  /**
   * The calls outside a trial that run in their own terminal now (goal 169): a planner's, by the
   * id its console and screens take. Control's Live shows each one's terminal.
   */
  terminals?: { id: string; run: string; role: string }[];
}

/** What the harness's watch knows of a trial; none outside the service (a drain's own event). */
type FactsOf = (trial: string) => TrialFacts;
const NO_FACTS: FactsOf = () => ({ last_line_at: null, reply: null, repeating: null });

/**
 * The open trials a report lists: a rig runs one trial on each lane, and at most `MAX_LANES`
 * lanes. More, which only a ledger left inconsistent could hold, are counted in `trials` only.
 */
const OPEN_MAX = MAX_LANES;

/**
 * What still runs: open trials and the judge's jobs under a lease still in force. A lease that
 * ran out is no work: its holder is gone, the judge takes it back (while draining too), and a
 * drain never waits on it. The report lists the open trials too, with what each is doing.
 */
export function workNow(
  ledger: Ledger,
  at: Date,
  draining: Draining | undefined,
  facts: FactsOf = NO_FACTS,
): Work {
  return {
    trials: ledger.trials.countOpen(),
    judge_jobs: ledger.jobs.leasedAt(at),
    draining: draining ? { ...draining } : null,
    open: openTrials(ledger, facts),
  };
}

/**
 * Each open trial, oldest first, with its task, its counters, a refused request it repeats, and
 * what the harness's watch knows of it.
 */
export function openTrials(ledger: Ledger, facts: FactsOf = NO_FACTS): OpenTrial[] {
  return ledger.trials.openWithTasks(OPEN_MAX).map((t) => ({
    trial: t.id,
    run: t.run,
    lane: t.lane,
    started_at: t.started_at,
    task: t.title,
    question: t.question,
    turns: t.turns ?? 0,
    tool_calls: t.tool_calls ?? 0,
    tokens_in: t.tokens_in ?? 0,
    claims:
      t.mode === "research" ? ledger.claims.countVerifiedOfLane(t.run, t.lane, t.started_at) : null,
    refused_again: refusedAgain(ledger, t),
    ...facts(t.id),
  }));
}

/** The trial's newest ask for a URL refused before for a lasting reason (refusals.ts). */
function refusedAgain(
  ledger: Ledger,
  t: { run: string; lane: string; started_at: string },
): OpenTrial["refused_again"] {
  // Refusals to the trial's lane since it started, of a URL asked for more than once.
  const again = { subject: t.run, actor: t.lane, since: t.started_at, above: { asked: 1 } };
  const e = ledger.events.newest("fetch_refused", again);
  if (!e) return null;
  return {
    url: e.body.url,
    reason: e.body.reason,
    asked: e.body.asked ?? 0,
    at: e.at,
    times: ledger.events.count("fetch_refused", again),
  };
}

/**
 * drain_rig (goal 079): the drain begins, goes on or ends, and the ledger records it, with its
 * deadline (goal 173). `drainMinutes`: the rig's wait when the command gives none.
 */
export function drainCommand(
  svc: { ledger: Ledger; draining: Draining | undefined; drainMinutes: number },
  p: { drain: boolean; reason?: string | undefined; deadline_minutes?: number | undefined },
  by: string,
  at: Date,
): Omit<Work, "open"> {
  svc.draining = drainAfter(svc.draining, p, by, at, svc.drainMinutes);
  const { open: _open, ...w } = workNow(svc.ledger, at, svc.draining);
  svc.ledger.appendEvent(by, "rig_drain", null, {
    drain: p.drain,
    ...(p.reason ? { reason: p.reason } : {}),
    ...(svc.draining ? { deadline: svc.draining.deadline } : {}),
    ...w,
  });
  return w;
}

/**
 * stop_trial (goal 136): the trial must still run, in that run. The ledger records the ask
 * (`trial_stop_asked`), and the scheduler stops the trial within a second (`scheduler/stops.ts`),
 * as a restart would: it ends as interrupted, and its experiment goes back to the top of the
 * run's queue. A trial that ends meanwhile is left as it ended.
 */
export function askStop(
  ledger: Ledger,
  p: { run: string; trial: string; reason?: string | undefined },
  by: string,
): { run: string; trial: string; lane: string; stopping: true } {
  const t = ledger.trials.get(p.trial);
  if (!t || t.run !== p.run)
    throw new LedgerError("not_found", `run ${p.run} has no trial ${p.trial}`);
  if (t.ended_at) throw new LedgerError("conflict", `trial ${p.trial} has ended already`);
  ledger.appendEvent(by, "trial_stop_asked", p.run, {
    trial: p.trial,
    lane: t.lane,
    ...(p.reason ? { reason: p.reason } : {}),
  });
  return { run: p.run, trial: p.trial, lane: t.lane, stopping: true };
}
