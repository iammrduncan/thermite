import { every } from "../../common/health.ts";
import type { ControlParts } from "../parts.ts";
import { rigSettingsOf } from "../views/index.ts";
import { setRigSettings } from "./settings.ts";

/**
 * Add a rig's Workers at a time (goal 206): control keeps the owner's choice (store/workers.ts)
 * and gives it to the new rig once the rig reports its settings, as Edit rig sends it: at once,
 * or in control's round, so a restart of control or a rig whose core comes up late loses nothing.
 */

/** How often control looks for a Workers at a time it has not given its rig yet: a minute. */
const WORKERS_WATCH_MS = 60_000;

/** How many times control gives it to a rig that refuses its command. */
const GIVE_TRIES = 3;

/** Keeps a new rig's Workers at a time, chosen by `by`, and gives it at once if the rig reports. */
export async function chooseWorkers(
  parts: ControlParts,
  rig: string,
  lanes: number,
  by: string,
): Promise<void> {
  await parts.store.rigWorkers.choose(rig, lanes, by);
  await giveWorkers(parts, rig);
}

/**
 * Sends the rig its Workers at a time, if it reports its settings, as the owner who chose it: the
 * rig takes its settings from the owner alone. A rig that has it already, or refuses it in words,
 * has nothing more to take. Its history says how it went.
 */
async function giveWorkers(parts: ControlParts, rig: string): Promise<void> {
  const { store } = parts;
  const w = await store.rigWorkers.get(rig);
  if (!w || !(await rigSettingsOf(store, rig))?.settings) return;
  const tries = (w.given?.tries ?? 0) + 1;
  await store.rigWorkers.setGiven(rig, { at: new Date().toISOString(), tries });
  const out = await setRigSettings(parts, rig, { lanes: w.lanes }, w.chosen_by, true);
  if (out.state === "sent")
    await store.rigWorkers.setGiven(rig, { at: new Date().toISOString(), tries, command: out.id });
  else await store.rigWorkers.done(rig);
  await store.rigHistory.add(
    rig,
    "workers_given",
    out.state !== "refused",
    out.state === "refused" ? out.error : `${w.lanes} at a time: ${out.said}`,
  );
}

/**
 * Control's round of Workers at a time (goal 206): each chosen for a rig that has not taken it is
 * given once the rig reports its settings. One on its way to the rig waits; one the rig took, or
 * the owner withdrew, is done; one the rig never took is given again, up to GIVE_TRIES times. The
 * round is one of control's loops, and never keeps control from exiting.
 */
export function watchWorkers(parts: ControlParts, everyMs = WORKERS_WATCH_MS): void {
  const { store } = parts;
  every(parts.loops, "control", "workers", everyMs, async () => {
    for (const w of await store.rigWorkers.waiting()) {
      const id = w.given?.command;
      if (id && (await store.commands.get(id))?.status === "pending") continue;
      if ((id && !(await store.commands.notTaken(id))) || (w.given?.tries ?? 0) >= GIVE_TRIES)
        await store.rigWorkers.done(w.rig);
      else await giveWorkers(parts, w.rig);
    }
  });
}
