import { errorText } from "../../common/errors.ts";
import { checkClusterRig } from "../clusters/index.ts";
import { checkScript, readCheck, tail } from "../machines/index.ts";
import type { ControlParts } from "../parts.ts";

/** What a check of where a rig runs needs: the store, the secrets, and the ways to reach it. */
export type PlaceParts = Pick<ControlParts, "store" | "secrets" | "machineSsh" | "kube">;

/**
 * Checks where a rig control set up runs (Check again on its page, and control by itself when the
 * rig turns stale and offline: rigs/watch.ts): over SSH on a machine, through the cluster's API on
 * a cluster. What it found is a step in the rig's history. Null when control can't reach it: it
 * set the rig up nowhere it knows (RunPod, a place the owner joined it, compose), or that machine
 * or cluster is no longer in Providers.
 */
export async function checkRigPlace(
  parts: PlaceParts,
  rig: string,
  by: string,
): Promise<{ ok: boolean; words: string } | null> {
  const { store } = parts;
  const r = store.machines.rig(rig);
  const onCluster = store.clusters.rig(rig);
  let found: { ok: boolean; words: string };
  if (r && r.status !== "removed") {
    const m = store.machines.get(r.machine);
    if (!m) return null;
    try {
      const out = await parts.machineSsh.sshScript(
        {
          address: m.address,
          port: m.port,
          user: m.user,
          privateKey: parts.secrets.open(m.key_sealed),
          hostKeys: m.host_keys,
        },
        checkScript(r),
        [],
        60_000,
      );
      found =
        out.code === 0
          ? readCheck(rig, out.stdout)
          : {
              ok: false,
              words: `The check on ${r.machine} failed: ${tail(out.stderr) || `exit ${out.code}`}`,
            };
    } catch (err) {
      found = {
        ok: false,
        words: `Control could not log in to ${r.machine} over SSH: ${errorText(err)}`,
      };
    }
  } else if (onCluster && onCluster.status !== "removed") {
    if (!store.clusters.get(onCluster.cluster)) return null;
    found = await checkClusterRig(parts, rig);
  } else return null;
  store.rigHistory.add(rig, "check", found.ok, found.words);
  store.auditLog.add(by, "rig_check_place", { rig, ok: found.ok });
  return found;
}
