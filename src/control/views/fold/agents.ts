import { frozen } from "../sharing.ts";
import type { Handlers } from "./index.ts";

/**
 * The run's agents: stopped and resumed, their waits for the provider's limit, the planner's
 * rounds and hand-outs, and each lane's trials, started and finished.
 */

/** How many finished trials a run's view keeps, and how many of the planner's hand-outs. */
const KEPT_TRIALS = 100;
const KEPT_HANDOUTS = 50;

export const AGENTS: Handlers = {
  agents_stopped(f, e, b) {
    const v = f.run(String(e.subject));
    v.agents_stopped = {
      kind: String(b.kind ?? ""),
      words: String(b.words ?? ""),
      said: String(b.said ?? b.kind ?? ""),
      by: String(b.by ?? ""),
      since: e.at,
    };
  },
  agents_resumed(f, e) {
    f.run(String(e.subject)).agents_stopped = null;
  },
  agents_wait_for_limit(f, e, b) {
    f.run(String(e.subject)).agents_wait = {
      until: String(b.until ?? ""),
      reason: String(b.reason ?? ""),
      since: e.at,
    };
  },
  agents_wait_ended(f, e) {
    f.run(String(e.subject)).agents_wait = null;
  },
  epoch_started(f, e, b) {
    const v = f.run(String(e.subject));
    v.epoch = {
      // Epochs are numbered from 1; an event without its number is the next one.
      n: Number.isFinite(Number(b.n)) ? Number(b.n) : v.agents.epochs + 1,
      at: e.at,
      source: String(b.source ?? ""),
      assignments: (Array.isArray(b.assignments) ? b.assignments : []).map((x) => {
        const y = (x ?? {}) as Record<string, unknown>;
        return {
          lane: String(y.lane),
          family: String(y.family),
          parent: String(y.parent),
          focus: typeof y.focus === "string" ? y.focus : null,
        };
      }),
    };
    v.round_starts.push(e.at);
    const a = v.agents;
    a.epochs++;
    if (b.planner_valid === true) a.planner_valid++;
    // A research round is planned by the research plan on purpose: not a fallback (goal 079).
    // Nor is a hill climb's setup round, set from the judge's reasons (goal 115).
    if (b.plan === "research") a.research_rounds++;
    else if (b.source === "fallback" && b.plan !== "setup") a.fallbacks++;
    if (Number(b.raw_violations ?? 0) > 0) a.epochs_with_violations++;
  },
  trial_started(f, e, b) {
    const v = f.run(String(e.subject));
    v.at_work[String(b.lane)] = {
      trial: String(b.trial ?? ""),
      family: typeof b.family === "string" ? b.family : null,
      focus: typeof b.focus === "string" ? b.focus : null,
      since: e.at,
    };
  },
  trial_finished(f, e, b) {
    const v = f.run(String(e.subject));
    if (v.at_work[String(b.lane)]?.trial === String(b.trial ?? ""))
      delete v.at_work[String(b.lane)];
    v.trials.push(
      frozen({
        trial: String(b.trial ?? ""),
        lane: (b.lane as string | null) ?? null,
        family: (b.family as string | null) ?? null,
        attempt: (b.attempt as string | null) ?? null,
        stopped: String(b.stopped ?? ""),
        error: (b.error as string | null) ?? null,
        at: e.at,
      }),
    );
    if (v.trials.length > KEPT_TRIALS) v.trials.shift();
    const made = b.attempt ? f.attempts.get(String(b.attempt)) : undefined;
    if (made) {
      made.family = (b.family as string | null) ?? null;
      made.trial = String(b.trial ?? "") || null;
    }
    const a = v.agents;
    a.trials++;
    if (b.attempt) a.submitted++;
    a.tokens_in += Number(b.tokens_in ?? 0);
    a.tokens_out += Number(b.tokens_out ?? 0);
  },
  planner_handout(f, e, b) {
    const v = f.run(String(e.subject));
    v.handouts.push(
      frozen({
        at: e.at,
        round: Number.isFinite(Number(b.round)) ? Number(b.round) : null,
        by: e.actor,
        assignments: (Array.isArray(b.assignments) ? b.assignments : []).map((a) => {
          const x = (a ?? {}) as Record<string, unknown>;
          return {
            lane: String(x.lane ?? ""),
            experiment: typeof x.experiment === "string" ? x.experiment : null,
            why: String(x.why ?? ""),
          };
        }),
        notes: String(b.notes ?? ""),
      }),
    );
    if (v.handouts.length > KEPT_HANDOUTS) v.handouts.shift();
  },
};
