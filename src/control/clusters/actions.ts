import { inBackground } from "../background.ts";
import type { ControlParts } from "../parts.ts";
import { STEP_WORDS } from "../rigs/index.ts";
import type { ClusterRig } from "../store/index.ts";
import { kubeError } from "./kubectl.ts";
import { awaitNewPods, clusterTarget } from "./rigs.ts";

/** What a cluster rig's page can do to it. */
export type ClusterRigAction = "stop" | "start" | "restart" | "remove";

/**
 * The kubectl calls of one action on a rig control set up on a cluster: stop and start scale its
 * deployments; remove deletes its namespace, or in a pre-made slot its own objects, then its
 * resource claim templates (a cluster without DRA has none, so that last call may fail).
 */
export function clusterActionCalls(r: ClusterRig, action: ClusterRigAction): string[][] {
  const sel = ["-n", r.namespace, "-l", `app.kubernetes.io/instance=${r.rig}`];
  if (action === "stop" || action === "start")
    return [["scale", "deployment", ...sel, `--replicas=${action === "stop" ? 0 : 1}`]];
  if (action === "restart") return [["rollout", "restart", "deployment", ...sel]];
  if (r.placement === "created")
    return [["delete", "namespace", r.namespace, "--wait=false", "--ignore-not-found"]];
  return [
    ["delete", "deployment,service,persistentvolumeclaim,secret", ...sel, "--ignore-not-found"],
    ["delete", "resourceclaimtemplates", ...sel, "--ignore-not-found"],
  ];
}

/**
 * Stop, start or restart a rig control set up on a cluster, as on its page (MCP's cluster_rig).
 */
export async function clusterRigAction(
  parts: ControlParts,
  rig: string,
  action: "stop" | "start" | "restart",
  by: string,
): Promise<{ ok: string } | { error: string }> {
  const r = parts.store.clusters.rig(rig);
  if (!r || r.status === "removed") return { error: `Control didn't set ${rig} up on a cluster.` };
  return actOnClusterRig(parts, r, action, by);
}

/**
 * Stop, start, restart or remove a rig control set up on a cluster (its page, or MCP); `said`
 * goes in the audit log with it.
 */
export async function actOnClusterRig(
  parts: ControlParts,
  r: ClusterRig,
  action: ClusterRigAction,
  by: string,
  said: Record<string, unknown> = {},
): Promise<{ ok: string } | { error: string }> {
  const { store } = parts;
  if (
    // Stop and remove always work; a start or restart waits for the change under way.
    (action === "start" || action === "restart") &&
    (r.status === "updating" || r.status === "starting" || r.status === "deploying")
  )
    return { error: `${r.rig} is ${r.status}: wait until its page shows it running, or failed.` };
  const k = store.clusters.get(r.cluster);
  if (!k) return { error: `The cluster ${r.cluster} is no longer in Providers.` };
  const runs = clusterActionCalls(r, action);
  for (const [i, args] of runs.entries()) {
    const out = await parts.kube.kubectl(clusterTarget(parts, k), args, undefined, 120_000);
    // A cluster without DRA has no resourceclaimtemplates: that last delete may fail harmlessly.
    if (out.code !== 0 && !(action === "remove" && i === 1)) {
      store.rigHistory.add(
        r.rig,
        action === "remove" ? "remove_cluster" : action,
        false,
        kubeError(out),
      );
      return { error: kubeError(out) };
    }
  }
  const step = action === "remove" ? "remove_cluster" : action;
  store.rigHistory.add(r.rig, step, true);
  if (action === "start" || action === "restart") {
    // Running once its pods are and it has reported, as after an update.
    store.clusters.setRigStatus(r.rig, "starting");
    void inBackground(store, "cluster", r.rig, "pods_running", awaitNewPods(parts, r, k, "start"));
  } else store.clusters.setRigStatus(r.rig, action === "stop" ? "stopped" : "removed");
  if (action === "remove") store.enrollments.retire(r.rig, by);
  store.auditLog.add(by, `cluster_rig_${action}`, { rig: r.rig, cluster: r.cluster, ...said });
  return { ok: `${STEP_WORDS[step]}.` };
}
