import { errorText } from "../../common/errors.ts";
import { RIG_ID_SENTENCE } from "../../core/ids.ts";
import { inBackground } from "../background.ts";
import { newToken } from "../credential.ts";
import { issueCommand } from "../issue/index.ts";
import { MAX_RIG_GPUS } from "../machines/index.ts";
import type { ControlParts } from "../parts.ts";
import {
  awaitFirstReport,
  controlAddress,
  judgeShare,
  NO_RIG_BUS,
  rigBusOf,
  rigTaken,
  sleep,
} from "../rigs/index.ts";
import { type Cluster, type ClusterRig, RIG_ID } from "../store/index.ts";
import {
  type ClusterFacts,
  type ClusterSlot,
  checkCluster,
  HARNESS_LABELS,
  slotNetwork,
} from "./facts.ts";
import { kubeError } from "./kubectl.ts";
import { asList, clusterNames, clusterRigObjects, rigResources } from "./manifests.ts";
import type { SlotOpening } from "./netcheck.ts";
import { quotaRefusal } from "./resources.ts";

/**
 * Rigs control sets up on Kubernetes clusters (Add a rig, a rig's page, Edit rig, REST and MCP):
 * the cluster's slots and its check, a rig's setup, the wait for its new pods, what it still runs,
 * and the check of its deployments. Its new images are in images.ts, its new size in resize.ts,
 * its stop, start, restart and removal in actions.ts, and the watch of its drain in drain.ts.
 */

/** A namespace's name, as Kubernetes takes it. */
export const NS = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** How kubectl reaches a cluster: its kubeconfig, opened, and its context. */
export const clusterTarget = (
  parts: Pick<ControlParts, "secrets">,
  c: Cluster & { kubeconfig_sealed: string },
) => ({
  kubeconfig: parts.secrets.open(c.kubeconfig_sealed),
  context: c.context || undefined,
});

/** Reads a cluster again (clusters/facts.ts) and keeps what it found; why not, in words. */
export async function checkClusterNow(parts: ControlParts, name: string): Promise<string | null> {
  const { store } = parts;
  const c = store.clusters.get(name);
  if (!c) return "no such cluster";
  try {
    const facts = await checkCluster(
      parts.kube,
      clusterTarget(parts, c),
      c.slots,
      store.reachable.list(),
    );
    store.clusters.setFacts(name, { facts });
    // Each slot's rig takes what its slot's rules open and let in now, for its page.
    const inSlots = store.clusters.rigs(name).filter((r) => r.placement === "slot");
    for (const slot of facts.slots)
      for (const r of inSlots.filter(
        (x) => x.namespace === slot.namespace && x.status !== "removed",
      ))
        store.clusters.setRigSlotNetwork(r.rig, {
          openings: slot.openings ?? [],
          ingress:
            slot.ingress_ok === undefined
              ? undefined
              : { ok: slot.ingress_ok, why: slot.ingress_why ?? "" },
        });
    return null;
  } catch (err) {
    const why = errorText(err);
    store.clusters.setFacts(name, { error: why });
    return why;
  }
}

/** A cluster of slots gets a new list of slots, and is read again. */
export async function setClusterSlots(
  parts: ControlParts,
  name: string,
  slots: string[],
  by: string,
): Promise<string | null> {
  const { store } = parts;
  const k = store.clusters.get(name);
  if (!k) return "no such cluster";
  if (k.placement !== "slot")
    return `${name} puts rigs in namespaces control creates, not in slots`;
  const bad = slots.find((x) => !NS.test(x));
  if (bad) return `"${bad}" is not a namespace name`;
  const using = store.clusters
    .rigs(name)
    .filter((r) => r.status !== "removed" && !slots.includes(r.namespace));
  if (using.length)
    return `${using.map((r) => r.namespace).join(", ")} still holds a rig (${using.map((r) => r.rig).join(", ")}): keep it in the list`;
  store.clusters.setSlots(name, [...new Set(slots)], by);
  return await checkClusterNow(parts, name);
}

/** Adding a rig on a cluster control knows (Add a rig, or MCP's add_cluster_rig). */
export interface ClusterRigRequest {
  rig: string;
  cluster: string;
  /** For a cluster of pre-made slots: which free slot. */
  slot?: string | undefined;
  gpus: number;
  /** With two or more GPUs, how many are the judge's (default: half, rounded up). */
  judgeGpus?: string | number | undefined;
  /** "device-plugin", "dra" (with deviceClass) or "dra:<class>". */
  mode?: string | undefined;
  deviceClass?: string | undefined;
  node?: string | undefined;
  storageClass?: string | undefined;
  storageGi?: number | undefined;
  /** The rig's CPUs and memory; default: what the slot's quota allows, else none. */
  cpus?: number | undefined;
  memoryGi?: number | undefined;
}

/**
 * Adds a rig on a cluster control knows and sets it up in the background: from Add a rig's
 * form, or over MCP (add_cluster_rig). Says why in words when it can't.
 */
export async function addClusterRig(
  parts: ControlParts,
  i: ClusterRigRequest,
  by: string,
): Promise<{ rig: string } | { error: string }> {
  const { store } = parts;
  const fail = (error: string) => ({ error });
  const { rig } = i;
  const k = store.clusters.get(i.cluster);
  if (!parts.rigImages) return fail("Control has no rig images configured.");
  if (!parts.publicUrl) return fail("Control's address for rigs is not set.");
  if (!parts.rigBus) return fail(NO_RIG_BUS);
  if (!RIG_ID.test(rig)) return fail(RIG_ID_SENTENCE);
  if (rigTaken(parts, rig)) return fail(`There is a rig named ${rig} already.`);
  if (!k) return fail("Choose a machine or a cluster.");
  const facts = k.facts as ClusterFacts | null;
  if (!facts || k.check_error) return fail(`${k.name} is not ready: check it under Providers.`);
  const gpus = i.gpus;
  if (!Number.isInteger(gpus) || gpus < 0 || gpus > MAX_RIG_GPUS)
    return fail(`A rig takes from none to ${MAX_RIG_GPUS} GPUs.`);
  const judgeGpus = judgeShare(i.judgeGpus === undefined ? "" : String(i.judgeGpus), gpus);
  if (typeof judgeGpus === "string") return fail(judgeGpus);
  // Control checks only what it could see: a slot's role may not list nodes, classes or storage.
  const mode = i.mode || "device-plugin";
  const deviceClass = mode.startsWith("dra:")
    ? mode.slice(4)
    : mode === "dra"
      ? i.deviceClass
      : undefined;
  if (gpus && mode === "dra" && !/^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/.test(deviceClass ?? ""))
    return fail("Name the DRA device class, such as gpu.nvidia.com.");
  if (gpus && mode.startsWith("dra:") && !facts.device_classes.includes(deviceClass ?? ""))
    return fail(`${k.name} has no DRA device class ${deviceClass}.`);
  if (gpus && !deviceClass && facts.nodes.length && !facts.nodes.some((n) => n.gpus >= gpus))
    return fail(
      `No node of ${k.name} offers ${gpus} GPU${gpus === 1 ? "" : "s"} through the device plugin.`,
    );
  const node = i.node || undefined;
  if (node && facts.nodes.length && !facts.nodes.some((n) => n.name === node))
    return fail(`${k.name} has no node ${node} that control can see.`);
  const storageClass = i.storageClass || undefined;
  if (
    storageClass &&
    facts.storage_classes.length &&
    !facts.storage_classes.some((s) => s.name === storageClass)
  )
    return fail(`${k.name} has no storage class ${storageClass}.`);
  if (storageClass && !NS.test(storageClass)) return fail("That is not a storage class name.");
  const storageGi = i.storageGi ?? 100;
  if (!Number.isInteger(storageGi) || storageGi < 1 || storageGi > 10_000)
    return fail("The volume size is a whole number of GB, from 1 to 10000.");
  let namespace: string;
  let slotQuota: ClusterSlot["quota"];
  let openings: SlotOpening[] = [];
  let ingress: { ok: boolean; why: string } | undefined;
  if (k.placement === "slot") {
    namespace = i.slot ?? "";
    const slot = facts.slots.find((s) => s.namespace === namespace && s.usable && !s.used_by);
    if (!slot) return fail("Choose a free slot.");
    slotQuota = slot.quota;
    if (
      store.clusters.rigs(k.name).some((r) => r.namespace === namespace && r.status !== "removed")
    )
      return fail(`The slot ${namespace} is in use.`);
    // Refuse a slot whose rules don't keep this harness off the cluster; keep what they open of
    // the owner's list of addresses rigs may reach, for the rig's page.
    const net = await slotNetwork(
      parts.kube,
      clusterTarget(parts, k),
      namespace,
      { ...HARNESS_LABELS, "app.kubernetes.io/instance": rig },
      store.reachable.list(),
    );
    if (!net.ok)
      return fail(
        `Refused: in the slot ${namespace}, ${net.why}. A rig's harness may reach only DNS, the internet, its model and the addresses in Settings › Addresses cluster rigs may reach: ask the cluster's operators for a network rule that keeps it off the cluster.`,
      );
    openings = net.openings;
    ingress = net.ingress;
  } else {
    namespace = k.namespace_pattern.replace("{rig}", rig);
    if (!NS.test(namespace)) return fail(`"${namespace}" is not a namespace name.`);
  }
  // CPUs and memory: as given, else what the slot's quota allows; none: the namespace's defaults.
  const cpus = i.cpus ?? slotQuota?.cpus;
  const memoryGi = i.memoryGi ?? slotQuota?.memoryGi;
  let resources: { cpus: number; memoryGi: number } | undefined;
  if (cpus !== undefined || memoryGi !== undefined) {
    if (cpus === undefined || memoryGi === undefined)
      return fail("Give the rig both its CPUs and its memory, or neither.");
    try {
      rigResources({ cpus, memoryGi });
    } catch (err) {
      return fail(errorText(err));
    }
    if (slotQuota?.cpus !== undefined && cpus > slotQuota.cpus + 1e-9)
      return fail(`The slot ${namespace} allows ${slotQuota.cpus} CPUs.`);
    if (slotQuota?.memoryGi !== undefined && memoryGi > slotQuota.memoryGi + 1e-9)
      return fail(`The slot ${namespace} allows ${slotQuota.memoryGi} GiB of memory.`);
    resources = { cpus, memoryGi };
  }
  if (slotQuota?.storageGi !== undefined && storageGi > slotQuota.storageGi + 1e-9)
    return fail(`The slot ${namespace} allows ${slotQuota.storageGi} GB of storage.`);
  // GPUs: what the slot's quota allows through the device plugin, or of the DRA device class.
  const devices = quotaRefusal(namespace, slotQuota, { gpus, deviceClass });
  if (devices) return fail(devices);
  if (gpus && !parts.rigImages.harnessCuda)
    return fail("Control has no CUDA harness image configured (THERMITE_RIG_HARNESS_CUDA_IMAGE).");
  const token = newToken();
  store.enrollments.enroll(rig, token.sha256, by);
  store.clusters.addRig({
    rig,
    cluster: k.name,
    namespace,
    placement: k.placement,
    spec: {
      gpus,
      judgeGpus,
      gpuMode: deviceClass ? "dra" : "device-plugin",
      deviceClass,
      node,
      storageClass,
      storageGi,
      resources,
      images: {
        harness: gpus ? (parts.rigImages.harnessCuda as string) : parts.rigImages.harness,
        supervisor: parts.rigImages.supervisor,
      },
      controlUrl: controlAddress(parts),
      ...(openings.length ? { openings } : {}),
      ...(ingress ? { ingress } : {}),
    },
    created_by: by,
  });
  store.rigHistory.add(rig, "enrolled", true);
  const deploy = deployClusterRig(parts, store.clusters.rig(rig) as ClusterRig, k, token.token);
  void inBackground(store, "cluster", rig, "applied", deploy);
  return { rig };
}

/** What a rig control set up on a cluster is deployed with, with its images or others. */
export const clusterPlan = (parts: ControlParts, r: ClusterRig, images = r.spec.images) => ({
  rig: r.rig,
  placement: r.placement,
  namespace: r.namespace,
  controlUrl: parts.publicUrl ?? "",
  images,
  gpus: r.spec.gpus,
  judgeGpus: r.spec.judgeGpus,
  gpuMode: r.spec.gpuMode,
  deviceClass: r.spec.deviceClass,
  node: r.spec.node,
  storageClass: r.spec.storageClass,
  storageGi: r.spec.storageGi,
  resources: r.spec.resources,
  controlPublicKey: parts.controlPublicKey,
  bus: rigBusOf(parts),
  reach: parts.store.reachable.list(),
});

/** Sets a rig up on a cluster, in the background: one apply, then the first report. */
async function deployClusterRig(
  parts: ControlParts,
  r: ClusterRig,
  k: Cluster & { kubeconfig_sealed: string },
  controlToken: string,
) {
  const { store } = parts;
  try {
    const objects = clusterRigObjects(clusterPlan(parts, r), {
      controlToken,
      harnessSupervisorToken: newToken().token,
    });
    const out = await parts.kube.kubectl(
      clusterTarget(parts, k),
      ["apply", "-f", "-"],
      asList(objects),
      120_000,
    );
    if (out.code !== 0) throw new Error(kubeError(out));
    store.rigHistory.add(r.rig, "applied", true, `namespace ${r.namespace}`);
    store.clusters.setRigStatus(r.rig, "starting");
  } catch (err) {
    store.rigHistory.add(r.rig, "deploy", false, errorText(err));
    store.clusters.setRigStatus(r.rig, "failed");
    return;
  }
  await awaitFirstReport(parts, r.rig, (s) => store.clusters.setRigStatus(r.rig, s));
}

/** Whether both of a rig's deployments (kubectl get -o json) run only their newest pods. */
function rolledOut(json: string): boolean {
  type D = {
    metadata?: { generation?: number };
    spec?: { replicas?: number };
    status?: {
      observedGeneration?: number;
      replicas?: number;
      updatedReplicas?: number;
      availableReplicas?: number;
    };
  };
  try {
    const items = (JSON.parse(json) as { items?: D[] }).items ?? [];
    return (
      items.length === 2 &&
      items.every((d) => {
        const want = d.spec?.replicas ?? 1;
        const st = d.status ?? {};
        return (
          (st.observedGeneration ?? 0) >= (d.metadata?.generation ?? 1) &&
          (st.replicas ?? 0) === want &&
          (st.updatedReplicas ?? 0) === want &&
          (st.availableReplicas ?? 0) === want
        );
      })
    );
  } catch {
    return false;
  }
}

/** Waits for a rig's new pods, for at most 15 minutes, then for a report from them. */
export async function awaitNewPods(
  parts: ControlParts,
  r: ClusterRig,
  k: Cluster & { kubeconfig_sealed: string },
  why: "images" | "start" | "resources" = "images",
) {
  const { store } = parts;
  const n = clusterNames(r.rig);
  const set = (st: string) => store.clusters.setRigStatus(r.rig, st);
  // The status this wait is for: a stop or a removal meanwhile ends it.
  const waiting = why === "start" ? "starting" : "updating";
  const still = () => store.clusters.rig(r.rig)?.status === waiting;
  const [pods, report] =
    why === "images"
      ? ["images_running", "report_after_images"]
      : why === "resources"
        ? ["resources_running", "report_after_resources"]
        : ["pods_running", "report_after_start"];
  const deadline = Date.now() + 15 * 60_000;
  for (;;) {
    if (!still()) return;
    const out = await parts.kube.kubectl(
      clusterTarget(parts, k),
      ["get", "deployment", n.harness, n.supervisor, "-n", r.namespace, "-o", "json"],
      undefined,
      60_000,
    );
    if (out.code === 0 && rolledOut(out.stdout)) break;
    if (Date.now() > deadline) {
      if (!still()) return;
      const err = out.code === 0 ? "" : `: ${kubeError(out)}`;
      store.rigHistory.add(r.rig, pods, false, `not running after 15 minutes${err}`);
      set("failed");
      return;
    }
    await sleep(5000);
  }
  if (!still()) return;
  store.rigHistory.add(r.rig, pods, true);
  await awaitFirstReport(parts, r.rig, set, 10, Date.now(), { step: report, still });
}

export const IMAGES_REASON = "its images are about to change";
export const RESIZE_REASON = "its GPUs, CPUs or memory are about to change";

/** What a rig still runs, as its last report says (goal 079); none from an older harness. */
export function rigWork(
  parts: ControlParts,
  rig: string,
): { trials: number; judge_jobs: number; draining: unknown } | undefined {
  const w = (
    parts.store.reportedRigs.list().find((x) => x.id === rig)?.summary as
      | { work?: unknown }
      | undefined
  )?.work as { trials?: unknown; judge_jobs?: unknown; draining?: unknown } | undefined;
  if (!w || typeof w.trials !== "number" || typeof w.judge_jobs !== "number") return undefined;
  return { trials: w.trials, judge_jobs: w.judge_jobs, draining: w.draining ?? null };
}

export const workWords = (w: { trials: number; judge_jobs: number }) =>
  [
    w.trials ? `${w.trials} trial${w.trials === 1 ? "" : "s"}` : "",
    w.judge_jobs ? `the judge's job${w.judge_jobs === 1 ? "" : "s"}` : "",
  ]
    .filter(Boolean)
    .join(" and ") || "its work";

/** A drain ends: the rig starts work again (its images did not change). */
export const undrain = (parts: ControlParts, rig: string, by: string) =>
  issueCommand(parts.store, parts.privateKeyPem, {
    rig,
    kind: "drain_rig",
    payload: { drain: false, reason: "the update did not happen" },
    issuedBy: by,
  });

/** What a cluster's API says about a rig's two deployments, in words: ok when both run. */
export async function checkClusterRig(
  parts: Pick<ControlParts, "store" | "secrets" | "kube">,
  rig: string,
): Promise<{ ok: boolean; words: string }> {
  const r = parts.store.clusters.rig(rig);
  const k = r ? parts.store.clusters.get(r.cluster) : undefined;
  if (!r || !k) return { ok: false, words: "The cluster is no longer in Settings › Providers." };
  const n = clusterNames(rig);
  const out = await parts.kube.kubectl(
    clusterTarget(parts, k),
    ["get", "deployment", n.harness, n.supervisor, "-n", r.namespace, "-o", "json"],
    undefined,
    60_000,
  );
  if (out.code !== 0)
    return { ok: false, words: `${r.cluster}'s API did not answer: ${kubeError(out)}` };
  type D = {
    metadata?: { name?: string };
    spec?: { replicas?: number };
    status?: { readyReplicas?: number };
  };
  let items: D[] = [];
  try {
    items = (JSON.parse(out.stdout) as { items?: D[] }).items ?? [];
  } catch {
    return { ok: false, words: `${r.cluster}'s API gave an answer control can't read.` };
  }
  const part = (name: string, word: string) => {
    const d = items.find((x) => x.metadata?.name === name);
    if (!d) return { ok: false, text: `the ${word} has no deployment` };
    const want = d.spec?.replicas ?? 1;
    const ready = d.status?.readyReplicas ?? 0;
    return {
      ok: want > 0 && ready >= want,
      text: `the ${word} has ${ready} of ${want} pod${want === 1 ? "" : "s"} ready`,
    };
  };
  const h = part(n.harness, "harness");
  const s = part(n.supervisor, "supervisor");
  return {
    ok: h.ok && s.ok,
    words: `${h.ok && s.ok ? "Both deployments run" : "Not both deployments run"}: ${h.text}, ${s.text}.`,
  };
}
