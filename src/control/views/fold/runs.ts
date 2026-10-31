import type { RunView } from "../types.ts";
import type { Handler, Handlers } from "./index.ts";

/** A run and its lifecycle: made, running, paused or closed, calibrated, and its conclusions. */

/** A run's view before any of its events. */
export function emptyRun(id: string): RunView {
  return {
    id,
    campaign: null,
    mode: null,
    seed_repo: null,
    promotion: null,
    ask_owner: {},
    status: "unknown",
    pause_reason: null,
    champion: [],
    invalidations: [],
    attempts: [],
    verdicts: {},
    pending_promotions: [],
    calibration: null,
    baseline: null,
    setup: null,
    baseline_waiting: false,
    agents: {
      epochs: 0,
      planner_valid: 0,
      fallbacks: 0,
      research_rounds: 0,
      epochs_with_violations: 0,
      trials: 0,
      submitted: 0,
      tokens_in: 0,
      tokens_out: 0,
      duplicates: 0,
      attempts: 0,
    },
    agents_stopped: null,
    agents_wait: null,
    research: null,
    cards: [],
    card_refusals: [],
    hypotheses: [],
    decisions: [],
    standing: [],
    progress: null,
    goals: [],
    goals_at: null,
    goals_seq: null,
    goals_confirming: false,
    goals_complete: false,
    champion_held_out: null,
    goal_checks: null,
    audits: [],
    promotion_waits: Object.create(null),
    reviews: [],
    paper: null,
    conclusions: [],
    published: null,
    published_trees: {},
    published_patches: [],
    propagations: [],
    directives: 0,
    created_at: null,
    epoch: null,
    round_starts: [],
    trials: [],
    // Keyed by the lane its events name: no prototype, so no name reaches Object's own.
    at_work: Object.create(null),
    timeline: [],
    has_agents: true,
    rules: [],
    directions: [],
    families: [],
    queue: [],
    handouts: [],
    messages: [],
    journal: [],
  };
}

/** The owner's decision on a "not possible" proposal. */
const concluded: Handler = (f, e, b) => {
  const c = f.run(String(e.subject)).conclusions.find((x) => x.proposal === Number(b.proposal));
  if (c) c.decision = e.kind === "conclusion_accepted" ? "accepted" : "rejected";
};

export const RUNS: Handlers = {
  run_created(f, e, b) {
    const v = f.run(String(e.subject));
    v.campaign = String(b.campaign ?? "");
    v.mode = String(b.mode ?? "");
    v.created_at = e.at;
    v.has_agents = b.agents !== false;
    f.running = v.id;
    v.seed_repo = ((b.seed as { repo?: string } | undefined)?.repo as string | undefined) ?? null;
    const seed = (b.seed ?? {}) as { folder?: unknown; source_commit?: unknown };
    v.seed_folder =
      typeof seed.folder === "string" && typeof seed.source_commit === "string"
        ? { folder: seed.folder, commit: seed.source_commit }
        : undefined;
    v.promotion = b.promotion === "auto" || b.promotion === "owner_approval" ? b.promotion : null;
    const ask = (b.ask_owner ?? {}) as Record<string, unknown>;
    v.ask_owner = {
      ...(typeof ask.above_gain === "number" ? { above_gain: ask.above_gain } : {}),
      ...(ask.declared_flaws === true ? { declared_flaws: true } : {}),
      ...(ask.reviews === true ? { reviews: true } : {}),
      ...(ask.not_possible === true ? { not_possible: true } : {}),
    };
    v.status = "running";
    v.champion.push({
      seq: 1,
      attempt: null,
      commit: String((b.seed as { commit?: string } | undefined)?.commit ?? ""),
      at: e.at,
      delta: null,
      cumulative: 1,
      reopened: false,
    });
  },
  run_status(f, e, b) {
    const v = f.run(String(e.subject));
    v.status = String(b.status);
    v.pause_reason = (b.reason as string | null) ?? null;
    if (v.status === "running") f.running = v.id;
    else if (f.running === v.id) f.running = null;
  },
  calibration(f, e, b) {
    const v = f.run(String(e.subject));
    v.calibration = { at: e.at, sigma: Number(b.sigma), summary: String(b.summary ?? "") };
  },
  conclusion_proposed(f, e, b) {
    const families = (Array.isArray(b.approaches) ? b.approaches : []).map((x) => {
      const y = (x ?? {}) as Record<string, unknown>;
      return { family: String(y.family ?? ""), attempts: Number(y.attempts ?? 0) };
    });
    f.run(String(e.subject)).conclusions.push({
      proposal: Number(b.proposal),
      decision: null,
      approaches: families.length,
      at: e.at,
      families,
    });
  },
  conclusion_accepted: concluded,
  conclusion_rejected: concluded,
};
