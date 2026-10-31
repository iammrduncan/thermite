import { issueCommand } from "../issue/index.ts";
import type { ControlStore } from "../store/index.ts";
import type { RigView } from "../views/index.ts";

/**
 * The GPU split a campaign's deployment asks for on its rig (a rig is a set of GPUs; what is
 * deployed on it decides how they are used): undefined when it asks for none or the rig has it
 * already, the number to send, or why it can't be.
 */
export function splitFor(rig: RigView, raw: string): number | string | undefined {
  if (!raw.trim()) return undefined;
  const judge = Number(raw);
  const g = rig.gpu_split;
  if (!g || g.set < 2)
    return `${rig.id} has no GPU set to split: its GPUs are set where it is deployed.`;
  const top = Math.min(8, g.set - 1);
  if (!Number.isInteger(judge) || judge < 1 || judge > top || g.set - judge > 8)
    return `With ${g.set} GPUs the judge takes 1 to ${top} of them, and the agents at most 8.`;
  return judge === g.judge ? undefined : judge;
}

/** Sends the rig its new GPU split, signed for the owner; the rig restarts its harness to apply it. */
export const sendSplit = (
  store: ControlStore,
  privateKeyPem: string,
  rig: string,
  judge: number,
  by = "owner:ui",
) =>
  issueCommand(store, privateKeyPem, {
    rig,
    kind: "rig_settings",
    payload: { judge_gpus: judge },
    issuedBy: by,
  });
