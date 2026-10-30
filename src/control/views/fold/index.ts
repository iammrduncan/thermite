import { EVENT_ACTOR_MAX, whyUnreadable } from "../../../core/events/schemas.ts";
import { frozen } from "../sharing.ts";
import type { AttemptView, JudgeJob, RunView, StoredEvent } from "../types.ts";
import { AGENTS } from "./agents.ts";
import { ATTEMPTS } from "./attempts.ts";
import { CHAMPIONS } from "./champions.ts";
import { CHECKS, type RigCheckView } from "./checks.ts";
import { GOALS } from "./goals.ts";
import { JOBS } from "./jobs.ts";
import { MESSAGES } from "./messages.ts";
import { QUEUE } from "./queue.ts";
import { RESEARCH } from "./research.ts";
import { RULES } from "./rules.ts";
import { emptyRun, RUNS } from "./runs.ts";

export type { RigCheckView } from "./checks.ts";
export type { GoalChecks, GoalValues } from "./goals.ts";

/**
 * A rig's events folded into what its view shows, one event at a time: its runs with their
 * attempts, the judge's jobs, the rig's checks and its newest events. What it holds depends only
 * on the events applied, in order. readRig (views/rig.ts) reads it with what else a rig's view
 * shows, and never changes it. Each area of events has its own module of handlers here. A record
 * the fold never changes once made is frozen (views/sharing.ts), so the views share it.
 */

/** Folds one event of its kind into the rig's state; `b` is the event's body. */
export type Handler = (f: RigFold, e: StoredEvent, b: Record<string, unknown>) => void;
/** Each kind's handler, as an area of the fold gives them. */
export type Handlers = Record<string, Handler>;

/** How many of the rig's newest events the fold keeps, and how many of each run's. */
const KEPT_RECENT = 50;
const KEPT_TIMELINE = 400;

/** Every kind's handler, by kind. A kind with no handler is only an event of the timeline. */
const HANDLERS = new Map<string, Handler>();
const AREAS = [
  CHECKS,
  RUNS,
  ATTEMPTS,
  CHAMPIONS,
  AGENTS,
  GOALS,
  RESEARCH,
  RULES,
  QUEUE,
  MESSAGES,
  JOBS,
];
for (const area of AREAS)
  for (const [kind, h] of Object.entries(area)) {
    // Two areas that fold one kind are a mistake in this code: control does not start.
    if (HANDLERS.has(kind)) throw new Error(`control's views: two handlers for the kind ${kind}`);
    HANDLERS.set(kind, h);
  }

/** What the fold holds, to read: the reader never changes it. */
export interface FoldedRig {
  /** The runs, in the order their first event came. */
  runs: RunView[];
  /** The judge's jobs, in the order each was first queued. */
  jobs: JudgeJob[];
  /** Each check's newest run. */
  checks: Record<string, RigCheckView>;
  /** The newest events, oldest first (at most KEPT_RECENT). */
  recent: StoredEvent[];
}

/**
 * One rig's fold. Its fields are what the handlers of this folder read and change; code outside
 * the fold calls apply, and reads state.
 */
export class RigFold {
  readonly runs = new Map<string, RunView>();
  readonly attempts = new Map<string, AttemptView>();
  readonly jobs = new Map<string, JudgeJob>();
  /** Keyed by a name the rig's events give: no prototype, so no name reaches Object's own. */
  readonly checks: Record<string, RigCheckView> = Object.create(null);
  /** Each attempt's step gain from its confirming verdict, for its promotion. */
  readonly confirmDelta = new Map<string, number>();
  /** The run that was running when a job without an attempt (validate, calibrate) was queued. */
  running: string | null = null;
  private readonly recent: StoredEvent[] = [];

  /** A run's view, made when an event first names it. */
  run(id: string): RunView {
    let v = this.runs.get(id);
    if (!v) {
      v = emptyRun(id);
      this.runs.set(id, v);
    }
    return v;
  }

  /**
   * Folds one event, the next of the rig's ledger. The fold never changes an event: frozen. An
   * event its views can't read (core/events/schemas.ts) is folded no further: the timeline and
   * the newest events keep it with why (`unreadable`), an empty body and its actor cut to its
   * limit. Gives why, or undefined for an event it folded.
   */
  apply(e: StoredEvent): string | undefined {
    frozen(e);
    const why = whyUnreadable(e);
    if (why === undefined) HANDLERS.get(e.kind)?.(this, e, e.body ?? {});
    const kept =
      why === undefined
        ? e
        : frozen({ ...e, actor: e.actor.slice(0, EVENT_ACTOR_MAX), body: {}, unreadable: why });
    const run = this.runOf(e);
    // The agents' notes are kept in the journal: the timeline tells what happened.
    if (run && this.runs.has(run) && e.kind !== "journal_note" && e.kind !== "research_note") {
      const t = (this.runs.get(run) as RunView).timeline;
      t.push(kept);
      if (t.length > KEPT_TIMELINE) t.shift();
    }
    this.recent.push(kept);
    if (this.recent.length > KEPT_RECENT) this.recent.shift();
    return why;
  }

  /** What the fold holds now, to read. */
  state(): FoldedRig {
    return {
      runs: [...this.runs.values()],
      jobs: [...this.jobs.values()],
      checks: this.checks,
      recent: [...this.recent],
    };
  }

  /** Which run an event belongs to, for the run's timeline. */
  private runOf(e: StoredEvent): string | null {
    const b = e.body ?? {};
    // A change to the rig's settings (Edit rig) is in the History of the run at work then.
    if (e.kind === "rig_settings_changed") return this.running;
    if (e.subject && this.runs.has(e.subject)) return e.subject;
    if (typeof b.run === "string" && b.run) return b.run;
    if (e.subject && this.attempts.has(e.subject)) return this.attempts.get(e.subject)?.run ?? null;
    if (e.kind.startsWith("job_") && e.subject) return this.jobs.get(e.subject)?.run ?? null;
    return null;
  }
}
