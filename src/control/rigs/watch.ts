import { log, redact } from "../../common/env.ts";
import { errorText } from "../../common/errors.ts";
import type { ControlStore } from "../store/index.ts";
import { OFFLINE_AFTER_MS } from "../views/index.ts";

/**
 * Control looks where a quiet rig runs (goal 012): when a rig it set up, on a machine or a
 * cluster, stops reporting, control checks its containers once when it turns stale and once more
 * when it turns offline, as the owner's Check again does. What it found is a step in the rig's
 * history, so the rig's page says it ("Control checked its machine 40 s ago: …"). A rig that never
 * reported has its setup's own wait; a refused rig is quiet because control refuses it; a rig
 * control can't reach (joined, compose, RunPod) is not checked.
 */
export async function checkQuietRigs(o: {
  store: ControlStore;
  /** Checks where a rig runs, as rigs/place.ts's checkRigPlace does; null: it can't reach it. */
  check: (rig: string, by: string) => Promise<{ ok: boolean; words: string } | null>;
  staleAfterMs: number;
  offlineAfterMs?: number | undefined;
  now?: number | undefined;
}): Promise<string[]> {
  const now = o.now ?? Date.now();
  const offline = Math.max(o.offlineAfterMs ?? OFFLINE_AFTER_MS, o.staleAfterMs);
  const checked: string[] = [];
  for (const u of o.store.reportedRigs.list()) {
    const seen = Date.parse(u.last_seen);
    if (!(seen > 0) || now - seen <= o.staleAfterMs) continue;
    if (o.store.refusals.get(u.id)) continue;
    const m = o.store.machines.rig(u.id);
    const k = o.store.clusters.rig(u.id);
    const placed = (m && m.status !== "removed") || (k && k.status !== "removed");
    if (!placed) continue;
    // Once since it turned stale, and once more since it turned offline.
    const since = now - seen > offline ? seen + offline : seen + o.staleAfterMs;
    const last = o.store.rigHistory
      .list(u.id)
      .filter((e) => e.step === "check")
      .at(-1);
    if (last && Date.parse(last.at) >= since) continue;
    try {
      if (await o.check(u.id, "control")) checked.push(u.id);
    } catch (err) {
      log(
        "control",
        "a quiet rig's check failed",
        {
          rig: u.id,
          error: redact(errorText(err)),
        },
        "error",
      );
    }
  }
  return checked;
}
