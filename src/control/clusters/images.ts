import { errorText } from "../../common/errors.ts";
import { inBackground } from "../background.ts";
import { issueCommand } from "../issue/index.ts";
import type { ControlParts } from "../parts.ts";
import { controlAddress, controlImages, NO_RIG_BUS } from "../rigs/index.ts";
import { programModeOf } from "../views/index.ts";
import { deploymentEnv } from "./deployment.ts";
import { kubeError } from "./kubectl.ts";
import { asList, clusterNames, clusterRigDeployments, rigResources } from "./manifests.ts";
import { resourcesWords } from "./resources.ts";
import {
  awaitNewPods,
  clusterPlan,
  clusterTarget,
  IMAGES_REASON,
  rigWork,
  undrain,
  workWords,
} from "./rigs.ts";

/**
 * Moves a rig control set up on a cluster onto control's current images (its page, or MCP's
 * update_rig_images): its two deployments are applied again, and its secret (so its tokens),
 * volume claim, service and network rules stay. Then, in the background, waits for its new pods
 * and a report from them. It drains the rig first (goal 079): running trials and the judge's job
 * under way finish, then its pods restart. `wait: false` restarts them now, also while a drain is
 * under way. Its supervisor's share of its CPUs and memory follows how its agent programs run now,
 * as its report says (goal 169), so a rig too small for that share is refused before it drains.
 */
export async function updateRigImages(
  parts: ControlParts,
  rig: string,
  by: string,
  o: {
    wait?: boolean | undefined;
    /** How long its drain waits before it asks the owner (goal 173); none: the rig's own. */
    drainMinutes?: number | undefined;
  } = {},
): Promise<{ ok: string } | { error: string }> {
  const { store } = parts;
  const r = store.clusters.rig(rig);
  if (!r || r.status === "removed") return { error: `Control didn't set ${rig} up on a cluster.` };
  if (r.status === "deploying") return { error: `${rig} is still being set up.` };
  // The supervisor's CONTROL_URL comes from here: without it the rig would lose its way back.
  if (!parts.publicUrl)
    return {
      error:
        "Control's address for rigs is not set (THERMITE_CONTROL_PUBLIC_URL): the rig would no longer know where to report.",
    };
  if (!parts.rigBus) return { error: NO_RIG_BUS };
  const images = controlImages(parts, r.spec.gpus);
  if (typeof images === "string") return { error: images };
  const old = r.spec.images;
  const k = store.clusters.get(r.cluster);
  if (!k) return { error: `The cluster ${r.cluster} is no longer in Providers.` };
  // A drain for a change to its GPUs, CPUs or memory (goal 118) is that change's.
  if (r.status === "draining" && r.pending)
    return {
      error: `${rig} is draining for a change to its GPUs, CPUs or memory: wait until its page shows it running, or call the change off first.`,
    };
  // A drain under way (goal 079): asked again, it goes on waiting; asked not to wait, the
  // update goes ahead now.
  if (r.status === "draining" && o.wait !== false)
    return {
      ok: `${rig} is draining: its pods restart on the new images once its trials and the judge's job end. Update now skips the wait.`,
    };
  // One change at a time: an update or a start still waiting for its pods is not overlapped.
  if (r.status === "updating" || r.status === "starting")
    return {
      error: `${rig} is ${r.status === "updating" ? "being updated" : "starting"}: wait until its page shows it running, or failed.`,
    };
  const addressOnly = old.harness === images.harness && old.supervisor === images.supervisor;
  // After a failed update the images are already recorded: applying them again retries it.
  const retry = addressOnly && r.status === "failed";
  if (addressOnly && !retry) {
    // Same images: only a changed address for control is worth a restart.
    const now = await parts.kube.kubectl(
      clusterTarget(parts, k),
      ["get", "deployment", clusterNames(rig).supervisor, "-n", r.namespace, "-o", "json"],
      undefined,
      30_000,
    );
    // An answer that is not a deployment is no answer: never take it for an unchanged rig.
    const env = now.code === 0 ? deploymentEnv(now.stdout) : null;
    if (!env)
      return {
        error: `Control could not read ${rig}'s deployment to compare control's address: ${now.code === 0 ? "kubectl's answer is not a deployment" : kubeError(now)}`,
      };
    const was = env.find((x) => x.name === "CONTROL_URL")?.value;
    if (was === undefined || was === parts.publicUrl.replace(/\/$/, ""))
      return { ok: `${rig} already runs control's images.` };
  }
  // The new deployments give its supervisor the share for how its agent programs run now.
  const programMode = programModeOf(store, rig);
  if (r.spec.resources) {
    try {
      rigResources(r.spec.resources, programMode);
    } catch (err) {
      const why = `${rig} has ${resourcesWords(r.spec.resources)}, and ${errorText(err)}. Give it more memory on Edit rig first, or set Agent programs run to Headless there.`;
      // A rig that drained for it goes back to work: the update did not happen.
      if (r.status === "draining") {
        store.rigHistory.add(rig, "images", false, why);
        undrain(parts, rig, by);
        store.clusters.setRigStatus(rig, "failed");
      }
      return { error: why };
    }
  }
  const stopped = r.status === "stopped";
  // Drain first (goal 079): while trials run or the judge has a job under way, the rig starts
  // nothing new and lets those end; the drain watch (drain.ts) restarts its pods once nothing
  // runs. A harness too old to report its work is updated at once, as before.
  const work = rigWork(parts, rig);
  if (
    o.wait !== false &&
    !stopped &&
    r.status !== "draining" &&
    work &&
    (work.trials > 0 || work.judge_jobs > 0)
  ) {
    issueCommand(store, parts.privateKeyPem, {
      rig,
      kind: "drain_rig",
      payload: {
        drain: true,
        reason: IMAGES_REASON,
        ...(o.drainMinutes ? { deadline_minutes: o.drainMinutes } : {}),
      },
      issuedBy: by,
    });
    store.clusters.setRigStatus(rig, "draining");
    store.rigHistory.add(rig, "drain", true, `waiting for ${workWords(work)} to finish`);
    store.auditLog.add(by, "cluster_rig_drain", { rig, to: images });
    return {
      ok: `${rig} drains first: it starts nothing new, and its pods restart on the new images once ${workWords(work)} ${work.trials + work.judge_jobs === 1 ? "finishes" : "finish"}. Update now, on its page or with update_rig_images and wait false, skips the wait.`,
    };
  }
  const out = await parts.kube.kubectl(
    clusterTarget(parts, k),
    ["apply", "-f", "-"],
    asList(clusterRigDeployments(clusterPlan(parts, r, images, programMode), stopped)),
    120_000,
  );
  if (out.code !== 0) {
    store.rigHistory.add(rig, "images", false, kubeError(out));
    // A rig that drained for it goes back to work: the update did not happen.
    if (r.status === "draining") {
      undrain(parts, rig, by);
      store.clusters.setRigStatus(rig, "failed");
    }
    return { error: kubeError(out) };
  }
  store.clusters.setRigImages(rig, images, programMode, controlAddress(parts));
  const changed =
    [
      old.harness !== images.harness ? `harness ${old.harness} → ${images.harness}` : "",
      old.supervisor !== images.supervisor
        ? `supervisor ${old.supervisor} → ${images.supervisor}`
        : "",
    ]
      .filter(Boolean)
      .join("; ") ||
    (retry
      ? "the same images again, after a failed change"
      : `control's address for rigs → ${parts.publicUrl}`);
  store.rigHistory.add(rig, "images", true, stopped ? `${changed}; at its next start` : changed);
  store.auditLog.add(by, "cluster_rig_images", { rig, from: old, to: images });
  if (stopped)
    return {
      ok: addressOnly
        ? `${rig} gets control's new address when it starts again.`
        : `${rig} runs the new images when it starts again.`,
    };
  store.clusters.setRigStatus(rig, "updating");
  void inBackground(store, "cluster", r.rig, "images_running", awaitNewPods(parts, r, k));
  return {
    ok: retry
      ? `${rig}'s pods restart on control's images again (a retry).`
      : addressOnly
        ? `${rig}'s pods restart with control's new address.`
        : `${rig}'s pods restart on the new images.`,
  };
}
