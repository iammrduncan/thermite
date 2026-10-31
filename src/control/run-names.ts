import type { ControlStore } from "./store/index.ts";

/**
 * Run names on control (goal 170): a run's name is used once, across every rig and every ledger
 * control has heard of, retired rigs and runs from before a full reset included. Control mints
 * the readable `<campaign>-<n>` numbered across all of them, and refuses an assignment whose name
 * was used, on every path that starts a run.
 */

/** The rig a run name was used on, or undefined while it is free, from control's run registry. */
export const runNameUsed = (store: ControlStore, run: string): string | undefined =>
  store.runRegistry.rigOfName(run);

/** A name for a campaign's next run: the campaign's name and the next number used nowhere. */
export function nextRunName(store: ControlStore, campaign: string): string {
  const base = campaign.slice(0, 58);
  const taken = store.runRegistry.usedNames(`${base}-`);
  for (let n = 1; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

/** Why an assignment's run name can't be used, in words; empty when it can. */
export function usedRunRefusal(
  store: ControlStore,
  payload: { run: string; contract?: { campaign?: string } },
): string {
  const on = runNameUsed(store, payload.run);
  if (!on) return "";
  const next = nextRunName(store, payload.contract?.campaign ?? payload.run);
  return `run ${payload.run} was used already, on ${on}: a run's name is used once on control, on every rig. Choose another, such as ${next}`;
}
