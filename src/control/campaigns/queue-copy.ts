import type { ControlStore } from "../store/index.ts";
import { findRun, type RunOnRig, type RunView } from "../views/index.ts";
import type { QueueSeed } from "./new.ts";

/**
 * Copying a past run's untried experiments into a new run's queue (goals 064 and 067): what
 * Start a run copies, and where the words come from. Start a run, MCP, REST and `thermite assign
 * --queue-from` share these.
 */

/** A run's untried experiments, in queue order then its lanes' ideas: a new run's first queue. */
export function untriedOf(r: RunView): QueueSeed[] {
  return [
    ...r.queue
      .filter((e) => e.state === "queued")
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0)),
    ...r.queue.filter((e) => e.state === "proposed"),
  ].map((e) => ({
    title: e.title,
    ...(e.details ? { details: e.details } : {}),
    ...(e.family ? { family: e.family } : {}),
    ...(e.why ? { why: e.why } : {}),
    by: e.by,
    state: e.state === "proposed" ? "proposed" : "queued",
    from: { run: r.id, id: e.id },
  }));
}

/**
 * Copied experiments (assign_campaign.queue) as control's records of the rigs' signed events
 * hold them: each one's author and words come from the experiment it was copied from, in its
 * run's view wherever the run ran, never from the caller, and only from a run of a campaign that
 * `campaign` (the new run's) may read. Any other keeps the caller's words, as "copied".
 */
export async function copiedFromRecords(
  store: ControlStore,
  campaign: string,
  queue: unknown[],
): Promise<unknown[]> {
  const kb = store.kb();
  const readable = new Set([campaign, ...(campaign ? kb.reads(campaign) : [])]);
  // Each run copied from is read once, however many of its experiments are copied.
  const runs = new Map<string, RunOnRig | undefined>();
  for (const x of queue) {
    const run = (x as { from?: { run?: unknown } } | null)?.from?.run;
    if (typeof run === "string" && !runs.has(run)) runs.set(run, await findRun(store, run));
  }
  return queue.map((x) => {
    if (!x || typeof x !== "object") return x;
    const { from } = x as { from?: { run?: unknown; id?: unknown } };
    const run = from?.run;
    const id = from?.id;
    const at = typeof run === "string" && typeof id === "string" ? runs.get(run) : undefined;
    const found = at?.run.queue.find((e) => e.id === id);
    // Only from a run of a campaign the new run's campaign may read (its own, or granted).
    const source = at && found ? kb.runCampaign(at.rig.id, at.run.id) : undefined;
    const rec = found && source && readable.has(source) ? found : undefined;
    if (!rec || !at || !source || typeof run !== "string" || typeof id !== "string")
      return { ...x, by: "copied" };
    // What became of it in that run, as Start a run says (queueSeedOf), when the folder has it.
    const item = kb.byOrigin({
      campaign: source,
      rig: at.rig.id,
      run,
      kind: "experiment",
      ref: id,
    });
    const result = item ? kb.resultOf(item) : null;
    const details = [rec.details, result ? `In ${run} (${source}) it was ${result}.` : ""]
      .filter(Boolean)
      .join("\n");
    const { title: _t, details: _d, family: _f, why: _w, ...rest } = x as Record<string, unknown>;
    return {
      ...rest,
      title: rec.title,
      ...(details
        ? { details: details.length > 4000 ? `${details.slice(0, 3999)}…` : details }
        : {}),
      ...(rec.family ? { family: rec.family } : {}),
      ...(rec.why ? { why: rec.why } : {}),
      by: rec.by,
    };
  });
}

/**
 * A run's copied experiments (assign_campaign.queue) are taken from the rigs' signed events, as
 * copiedFromRecords says: never the caller's words, unless control has no record it may use.
 */
export async function queueFromRecords(store: ControlStore, payload: unknown): Promise<unknown> {
  const p = payload as { queue?: unknown; contract?: { campaign?: unknown } };
  if (!p || typeof p !== "object" || !Array.isArray(p.queue)) return payload;
  const target = typeof p.contract?.campaign === "string" ? p.contract.campaign : "";
  return { ...p, queue: await copiedFromRecords(store, target, p.queue) };
}
