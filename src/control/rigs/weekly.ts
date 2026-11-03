import type { ControlStore } from "../store/index.ts";
import type { RigView } from "../views/index.ts";

/**
 * A rig whose subscription's weekly usage limit is full (goal 169; the owner's decisions of
 * 2026-10-27 and 2026-11-01): a trial met a usage limit whose reset is more than a day away, so
 * it ended, its experiment back at the top of its queue, and its run waits for the reset
 * (`agents_wait_for_limit` with `weekly`). Needs you shows it, with two choices: give the rig
 * another model for new trials, or wait for the reset; code never answers the program's own menu
 * and never switches a model by itself. Each choice is a step in the rig's history and an entry
 * in the audit log; after either, the card leaves Needs you, and the rig's page says the wait
 * until the reset.
 */

/** The step the owner's "Wait for the reset" adds to the rig's history. */
export const WEEKLY_WAIT_STEP = "weekly_limit_wait";
/** The step the owner's "Give the rig another model" adds. */
export const WEEKLY_MODEL_STEP = "weekly_limit_model";

/** The rig's weekly limit now, as Needs you, its page, REST and MCP give it. */
interface WeeklyLimit {
  /** When the limit resets: the newest of its runs' waits. */
  until: string;
  /** When its first run met it. */
  since: string;
  /** Each run that waits for it, with the trial that met it and that trial's lane. */
  runs: { run: string; campaign: string | null; trial: string | null; lane: string | null }[];
  /** The provider and model the rig's workers use, as its report says. */
  provider: string | null;
  model: string | null;
  /** The owner's choice since it began: "wait", "model", or null while none. */
  chose: "wait" | "model" | null;
}

/** The rig's weekly limit, while one of its running runs waits for one; undefined otherwise. */
export function weeklyLimit(
  store: ControlStore,
  u: RigView,
  now = Date.now(),
): WeeklyLimit | undefined {
  const waiting = u.runs.flatMap((r) => {
    const w = r.agents_wait;
    return r.status === "running" && w?.weekly && Date.parse(w.until) > now ? [{ r, w }] : [];
  });
  const first = waiting[0];
  if (!first) return undefined;
  const until = waiting.reduce((a, x) => (x.w.until > a ? x.w.until : a), first.w.until);
  const since = waiting.reduce((a, x) => (x.w.since < a ? x.w.since : a), first.w.since);
  const step = store.rigHistory.latest(u.id, [WEEKLY_WAIT_STEP, WEEKLY_MODEL_STEP], 1)[0];
  const chose =
    step && step.at >= since ? (step.step === WEEKLY_MODEL_STEP ? "model" : "wait") : null;
  return {
    until,
    since,
    runs: waiting.map(({ r, w }) => ({
      run: r.id,
      campaign: r.campaign,
      trial: w.trial,
      lane: r.trials.find((t) => t.trial === w.trial)?.lane ?? null,
    })),
    provider: u.model?.name ?? null,
    model: u.model?.model ?? null,
    chose,
  };
}
