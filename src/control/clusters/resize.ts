import { errorText } from "../../common/errors.ts";
import { inBackground } from "../background.ts";
import { issueCommand } from "../issue/index.ts";
import type { ControlParts } from "../parts.ts";
import { controlAddress, NO_RIG_BUS } from "../rigs/index.ts";
import type { Cluster, ClusterRig, ClusterRigResize, ClusterRigSize } from "../store/index.ts";
import { rigSettingsOf } from "../views/index.ts";
import { type ClusterFacts, type SlotQuota, slotQuota } from "./facts.ts";
import { kubeError } from "./kubectl.ts";
import { asList, clusterNames, clusterRigResized } from "./manifests.ts";
import {
  asksNothing,
  type ClusterResourcesRequest,
  planClusterResize,
  type ResizeRefusal,
  sizeChangeWords,
  sizeOf,
  sizeWords,
} from "./resources.ts";
import {
  awaitNewPods,
  clusterPlan,
  clusterTarget,
  RESIZE_REASON,
  rigWork,
  undrain,
  workWords,
} from "./rigs.ts";

type Resize = { ok: string } | ResizeRefusal;

/** What a slot's quota allows now, read again; the last check's when control can't read it. */
async function slotQuotaNow(
  parts: ControlParts,
  r: ClusterRig,
  k: Cluster & { kubeconfig_sealed: string },
): Promise<SlotQuota | undefined> {
  if (r.placement !== "slot") return undefined;
  const out = await parts.kube.kubectl(
    clusterTarget(parts, k),
    ["get", "resourcequota", "-n", r.namespace, "-o", "json"],
    undefined,
    30_000,
  );
  if (out.code === 0) return slotQuota(out.stdout);
  return (k.facts as ClusterFacts | null)?.slots.find((x) => x.namespace === r.namespace)?.quota;
}

/**
 * Checks a change to the GPUs, CPUs or memory of a rig control set up on a cluster (goal 118),
 * with the slot's quota read again, and says what it would do: a refusal in words, words with
 * nothing to do, or `go`, which drains the rig first while it works, else applies the change.
 * Edit rig checks everything before it saves anything, so the check and the change are apart.
 */
export async function prepareResize(
  parts: ControlParts,
  rig: string,
  want: ClusterResourcesRequest,
  by: string,
  o: { wait?: boolean | undefined; owner: boolean; drainMinutes?: number | undefined },
): Promise<Resize | { go: () => Promise<Resize> }> {
  const { store } = parts;
  const r = store.clusters.rig(rig);
  if (!r || r.status === "removed")
    return { error: `Control didn't set ${rig} up on a cluster.`, status: 404 };
  if (r.status === "deploying") return { error: `${rig} is still being set up.`, status: 409 };
  // The supervisor's CONTROL_URL comes from here, as in an image update.
  if (!parts.publicUrl)
    return {
      error:
        "Control's address for rigs is not set (THERMITE_CONTROL_PUBLIC_URL): the rig would no longer know where to report.",
      status: 409,
    };
  if (!parts.rigBus) return { error: NO_RIG_BUS, status: 409 };
  const k = store.clusters.get(r.cluster);
  if (!k) return { error: `The cluster ${r.cluster} is no longer in Providers.`, status: 409 };
  if (r.status === "updating" || r.status === "starting")
    return {
      error: `${rig} is ${r.status === "updating" ? "being updated" : "starting"}: wait until its page shows it running, or failed.`,
      status: 409,
    };
  if (r.status === "draining" && !r.pending)
    return {
      error: `${rig} is draining for an image update: wait until its page shows it running, or call the update off first.`,
      status: 409,
    };
  const pending = r.status === "draining" ? r.pending : undefined;
  // During its own drain, a call that names nothing goes on with the change it waits for.
  if (pending && asksNothing(want))
    return o.wait === false
      ? { go: () => applyResize(parts, rig, pending, by) }
      : {
          ok: `${rig} is draining: its pods restart with ${sizeWords(pending)} once its trials and the judge's job end. Change now skips the wait.`,
        };
  const plan = planClusterResize(r, want, {
    owner: o.owner,
    facts: k.facts as ClusterFacts | null,
    quota: await slotQuotaNow(parts, r, k),
  });
  if ("error" in plan) return plan;
  if ("same" in plan)
    return { ok: `Nothing changed: ${rig} has these GPUs, CPUs and memory already.` };
  const next: ClusterRigResize = { ...plan.size, by };
  return {
    go: async () => {
      const now = store.clusters.rig(rig);
      if (!now || now.status === "removed")
        return { error: `Control didn't set ${rig} up on a cluster.`, status: 404 };
      const work = rigWork(parts, rig);
      if (
        o.wait === false ||
        now.status === "stopped" ||
        (now.status !== "draining" && !(work && (work.trials > 0 || work.judge_jobs > 0)))
      )
        return applyResize(parts, rig, next, by);
      // Drain first (goal 079): the rig starts nothing new, and the drain watch (drain.ts)
      // applies the change once nothing runs. A drain under way takes the new size instead.
      store.clusters.setRigPending(rig, next);
      if (now.status === "draining" || !work) {
        store.rigHistory.add(rig, "drain", true, `now for ${sizeChangeWords(sizeOf(now), next)}`);
        return {
          ok: `${rig} is draining: its pods restart with ${sizeWords(next)} once its trials and the judge's job end. Change now skips the wait.`,
        };
      }
      issueCommand(store, parts.privateKeyPem, {
        rig,
        kind: "drain_rig",
        payload: {
          drain: true,
          reason: RESIZE_REASON,
          ...(o.drainMinutes ? { deadline_minutes: o.drainMinutes } : {}),
        },
        issuedBy: by,
      });
      store.clusters.setRigStatus(rig, "draining");
      store.rigHistory.add(rig, "drain", true, `waiting for ${workWords(work)} to finish`);
      store.auditLog.add(by, "cluster_rig_drain", { rig, to: sizeChangeWords(sizeOf(now), next) });
      return {
        ok: `${rig} drains first: it starts nothing new, and its pods restart with ${sizeWords(next)} once ${workWords(work)} ${work.trials + work.judge_jobs === 1 ? "finishes" : "finish"}. Change now, on its page or with set_cluster_rig_resources and wait false, skips the wait.`,
      };
    },
  };
}

/**
 * Applies a new size to a rig control set up on a cluster: its two deployments again, on the
 * images it runs (for DRA, with a new claim template: a template can't change, so the old one is
 * deleted first). Its secret (so its tokens), volume claim, service and network rules stay. A
 * stopped rig stays stopped. Then, in the background, waits for its new pods and a report.
 */
export async function applyResize(
  parts: ControlParts,
  rig: string,
  size: ClusterRigResize,
  by: string,
): Promise<Resize> {
  const { store } = parts;
  const r = store.clusters.rig(rig);
  if (!r || r.status === "removed")
    return { error: `Control didn't set ${rig} up on a cluster.`, status: 404 };
  const k = store.clusters.get(r.cluster);
  if (!k) return { error: `The cluster ${r.cluster} is no longer in Providers.`, status: 409 };
  const from = sizeOf(r);
  const to: ClusterRigSize = {
    gpus: size.gpus,
    judgeGpus: size.judgeGpus,
    resources: size.resources,
  };
  const stopped = r.status === "stopped";
  const draining = r.status === "draining";
  const target = clusterTarget(parts, k);
  const failed = (why: string): ResizeRefusal => {
    store.rigHistory.add(rig, "resources", false, why);
    // A rig that drained for it goes back to work: the change did not happen.
    if (draining) {
      undrain(parts, rig, by);
      store.clusters.setRigStatus(rig, "failed");
    }
    return { error: why, status: 409 };
  };
  const newClaim = r.spec.gpuMode === "dra" && to.gpus > 0 && to.gpus !== from.gpus;
  let objects: string;
  try {
    objects = asList(
      clusterRigResized(clusterPlan(parts, { ...r, spec: { ...r.spec, ...to } }), stopped),
    );
  } catch (err) {
    return failed(errorText(err));
  }
  if (newClaim) {
    const del = await parts.kube.kubectl(
      target,
      [
        "delete",
        "resourceclaimtemplate",
        clusterNames(rig).gpus,
        "-n",
        r.namespace,
        "--ignore-not-found",
      ],
      undefined,
      60_000,
    );
    if (del.code !== 0) return failed(kubeError(del));
  }
  const out = await parts.kube.kubectl(target, ["apply", "-f", "-"], objects, 120_000);
  if (out.code !== 0) {
    // The old claim template back, so that its pods start as before.
    if (newClaim) {
      const back = await parts.kube.kubectl(
        target,
        ["apply", "-f", "-"],
        asList(
          clusterRigResized(clusterPlan(parts, r), stopped).filter(
            (x) => x.kind === "ResourceClaimTemplate",
          ),
        ),
        60_000,
      );
      if (back.code !== 0)
        return failed(
          `${kubeError(out)}; its old claim template could not be put back either: ${kubeError(back)}`,
        );
    }
    return failed(kubeError(out));
  }
  store.clusters.setRigSize(rig, to, controlAddress(parts));
  let words = sizeChangeWords(from, to);
  // The judge's share a rig keeps from Edit rig comes before its deployment's, so it follows the
  // new size. Its harness takes it only from an owner: issuer: the one who asked.
  const kept = rigSettingsOf(store, rig)?.settings?.judge_gpus;
  if (
    to.gpus >= 2 &&
    to.gpus !== from.gpus &&
    to.judgeGpus !== undefined &&
    typeof kept === "number" &&
    kept !== to.judgeGpus
  ) {
    try {
      issueCommand(store, parts.privateKeyPem, {
        rig,
        kind: "rig_settings",
        payload: { judge_gpus: to.judgeGpus },
        issuedBy: size.by,
      });
      words += `; the judge's share it kept, ${kept}, → ${to.judgeGpus}`;
    } catch (err) {
      words += `; the judge's share it keeps, ${kept}, did not change: ${errorText(err)}`;
    }
  }
  store.rigHistory.add(rig, "resources", true, stopped ? `${words}; at its next start` : words);
  store.auditLog.add(by, "cluster_rig_resources", { rig, from, to });
  if (stopped) return { ok: `${rig} has ${sizeWords(to)} when it starts again.` };
  store.clusters.setRigStatus(rig, "updating");
  void inBackground(
    store,
    "cluster",
    r.rig,
    "resources_running",
    awaitNewPods(parts, r, k, "resources"),
  );
  return { ok: `${rig}'s pods restart with ${sizeWords(to)}.` };
}

/**
 * Checks and makes a change to the GPUs, CPUs or memory of a rig control set up on a cluster,
 * keeping its volume and tokens (Edit rig, REST's POST /v1/rigs/<rig>/cluster/resources, MCP's
 * set_cluster_rig_resources; goal 118), as an image update moves it: it drains first unless
 * `wait: false`. `owner`: whether the owner's token asks, which alone may give the judge's share.
 */
export async function setClusterRigResources(
  parts: ControlParts,
  rig: string,
  want: ClusterResourcesRequest,
  by: string,
  o: { wait?: boolean | undefined; owner: boolean; drainMinutes?: number | undefined },
): Promise<Resize> {
  const p = await prepareResize(parts, rig, want, by, o);
  return "go" in p ? p.go() : p;
}
