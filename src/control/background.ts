import { log } from "../common/env.ts";
import { errorText } from "../common/errors.ts";
import type { ControlStore } from "./store/index.ts";

/** Where control set a rig up: each keeps its rig's state in a table of its own. */
export type Placement = "machine" | "cluster" | "joined";

/** The states that last only while control's work on the rig goes on. */
const UNDER_WAY = ["deploying", "starting", "updating", "draining", "joining"];

/**
 * Work a request starts and doesn't wait for: setting a rig up, moving it onto new images or a
 * new size, waiting for its pods or its first report. A failure is never dropped (goal 161): it is
 * logged with the rig, recorded as a failed step in the rig's history, and a state that only
 * lasts while the work goes on becomes `failed`, so a rig never stays "updating" for good. A state
 * something else set meanwhile (stopped, removed, running) is left as it is.
 */
export function inBackground(
  store: ControlStore,
  placement: Placement,
  rig: string,
  step: string,
  work: Promise<unknown>,
): Promise<void> {
  return work.then(
    () => undefined,
    async (err: unknown) => {
      const why = errorText(err);
      log("control", "background work failed", { rig, placement, step, error: why }, "error");
      await store.rigHistory.add(rig, step, false, why);
      // The status is read and set in one transaction: a stop, a removal or the rig's first
      // report between the two is not written over with "failed".
      await store.tx(async () => {
        const now =
          placement === "machine"
            ? (await store.machines.rig(rig))?.status
            : placement === "cluster"
              ? (await store.clusters.rig(rig))?.status
              : (await store.joinedRigs.get(rig))?.status;
        if (now === undefined || !UNDER_WAY.includes(now)) return;
        if (placement === "machine") await store.machines.setRigStatus(rig, "failed");
        else if (placement === "cluster") await store.clusters.setRigStatus(rig, "failed");
        else await store.joinedRigs.set(rig, { status: "failed" });
      });
    },
  );
}
