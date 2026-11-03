import { Refusal } from "../../common/errors.ts";
import { type CommandKind, RUN_KINDS } from "../../core/commands.ts";
import { listText } from "../../core/words.ts";
import type { ControlStore } from "../store/index.ts";

/**
 * The rig a command goes to (goal 170). A kind about one run (RUN_KINDS) goes to the rig the run
 * is on, from control's run registry, so its caller may name the run alone; a rig named with it
 * must be one the run's name is used on. Every other kind names its rig. Refused in words for a
 * run control does not know, a rig the run is not on, and an earlier run: one of a retired rig,
 * or from before its rig's full reset, which takes no more commands.
 */
export function commandRig(
  store: ControlStore,
  kind: CommandKind,
  rig: string | undefined,
  payload: unknown,
): string {
  const run = (payload as { run?: unknown } | null)?.run;
  if (!RUN_KINDS.has(kind) || typeof run !== "string") {
    if (!rig) throw new Refusal(`A ${kind} command names its rig: give the rig.`);
    return rig;
  }
  const on = store.runRegistry.rigsOf(run);
  if (rig && on.length && !on.includes(rig))
    throw new Refusal(`Run ${run} is on ${listText(on)}, not on ${rig}.`);
  const to = rig ?? on[0];
  if (!to) throw new Refusal(`Control knows no run ${run}: name a run a rig reported.`);
  if (store.retired.get(to))
    throw new Refusal(`Run ${run} is an earlier run: ${to} is retired, so it takes no commands.`);
  const ledger = store.runRegistry.ledgerOf(run, to);
  const current = store.reportedRigs.reportRow(to)?.ledger_id;
  if (ledger && typeof current === "string" && ledger !== current)
    throw new Refusal(
      `Run ${run} is an earlier run: it ran on ${to} before the rig's full reset, so it takes no commands.`,
    );
  return to;
}
