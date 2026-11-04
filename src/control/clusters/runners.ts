import { z } from "zod";
import { errorText } from "../../common/errors.ts";
import { RIG_NAME_RULE } from "../../core/ids.ts";
import { RunnerSetting } from "../../core/rig-settings.ts";
import { inBackground } from "../background.ts";
import { newToken } from "../credential.ts";
import type { ControlParts } from "../parts.ts";
import {
  type CudaVersion,
  controlImages,
  NO_RIG_BUS,
  rigBusOf,
  setRigSettings,
} from "../rigs/index.ts";
import { RIG_ID, type RigRunner } from "../store/index.ts";
import { rigSettingsOf } from "../views/index.ts";
import { cudaOfPlace } from "./cuda.ts";
import { type ClusterFacts, HARNESS_LABELS, slotNetwork } from "./facts.ts";
import { kubeError } from "./kubectl.ts";
import {
  asList,
  type ClusterRigPlan,
  clusterRigObjects,
  rigResources,
  runnerUnit,
} from "./manifests.ts";
import { quotaRefusal } from "./resources.ts";
import { clusterTarget, NS } from "./rigs.ts";

/**
 * A rig's runner processes on a cluster control knows (goal 206): each a harness and a supervisor
 * started as a runner, on one node, with one GPU or none, a volume of its own and a token of its
 * own, with which its supervisor registers its key on the bus and nothing else. Control sets it up,
 * then sends the rig its new list of runners, which the rig's core takes while it works; taken
 * away, the rig hears first, so the core fails its run under way cleanly, then its objects go.
 */

/** How long a runner set up with its rig waits for the rig's first report: 20 minutes. */
const RIG_WAIT_MS = 10_000;
const RIG_WAIT_TRIES = 120;

/** Adding a runner process on a cluster (Edit rig, REST or MCP). */
interface ClusterRunnerRequest {
  rig: string;
  runner: string;
  cluster: string;
  /** For a cluster of pre-made slots: a free one, or one that holds this rig or its runners. */
  slot?: string | undefined;
  node?: string | undefined;
  /** Its GPUs: none (the node's CPUs) or one. */
  gpus: number;
  /** "device-plugin", "dra" (with deviceClass) or "dra:<class>". */
  mode?: string | undefined;
  deviceClass?: string | undefined;
  cuda?: CudaVersion | undefined;
  storageClass?: string | undefined;
  storageGi?: number | undefined;
  cpus?: number | undefined;
  memoryGi?: number | undefined;
  /** Its runner's pool: the judge's, shared, or a lane's. */
  pool: string;
}

/**
 * A runner process on a cluster as REST and MCP ask for it: Edit rig's fields. Types only: a value
 * out of range is refused in addClusterRunner's words.
 */
export const ClusterRunnerBody = z.strictObject({
  runner: z
    .string()
    .describe("The runner process's name in the rig: 2 to 40 lowercase letters, digits and dashes"),
  cluster: z.string().describe("A cluster in Settings › Machines"),
  slot: z
    .string()
    .optional()
    .describe(
      "On a cluster of pre-made slots: a free slot, or one that holds this rig or its runners",
    ),
  node: z.string().optional().describe("The node it runs on; none: any node with room"),
  gpus: z.number().int().describe("Its GPUs: 1, or 0 for the node's CPUs"),
  mode: z
    .string()
    .optional()
    .describe(
      "How it asks for its GPU: device-plugin (the default), dra with device_class, or dra:<class>",
    ),
  device_class: z.string().optional().describe("The DRA device class, with mode dra"),
  cuda: z
    .enum(["12", "13"])
    .optional()
    .describe(
      "The CUDA harness its GPU takes; default: from the node where control can tell, else 12",
    ),
  storage_gi: z
    .number()
    .int()
    .optional()
    .describe("Its volume, for its builds and model files, in GB; default 100"),
  storage_class: z
    .string()
    .optional()
    .describe("The volume's storage class; default: the cluster's"),
  cpus: z.number().optional().describe("Its CPUs, with memory_gib; none: the namespace's defaults"),
  memory_gib: z.number().optional().describe("Its memory in GiB, with cpus"),
  pool: z
    .string()
    .describe(
      "Its runner's pool: judge, shared (the judge's and every lane's, in turn) or lane-1 to lane-16",
    ),
});
export type ClusterRunnerBody = z.infer<typeof ClusterRunnerBody>;

/** The request a body makes, for one rig. */
export const clusterRunnerRequest = (rig: string, b: ClusterRunnerBody): ClusterRunnerRequest => ({
  rig,
  runner: b.runner,
  cluster: b.cluster,
  slot: b.slot,
  node: b.node,
  gpus: b.gpus,
  mode: b.mode,
  deviceClass: b.device_class,
  cuda: b.cuda,
  storageGi: b.storage_gi,
  storageClass: b.storage_class,
  cpus: b.cpus,
  memoryGi: b.memory_gib,
  pool: b.pool,
});

/** What a runner process control set up on a cluster is deployed with. */
const runnerPlan = (parts: ControlParts, r: RigRunner): ClusterRigPlan => ({
  rig: r.rig,
  runner: r.runner,
  placement: r.placement,
  namespace: r.namespace,
  controlUrl: parts.publicUrl ?? "",
  images: r.spec.images,
  gpus: r.spec.gpus,
  gpuMode: r.spec.gpuMode,
  deviceClass: r.spec.deviceClass,
  node: r.spec.node,
  storageClass: r.spec.storageClass,
  storageGi: r.spec.storageGi,
  resources: r.spec.resources,
  // Its supervisor runs no advisor: the smaller share.
  programMode: "headless",
  controlPublicKey: parts.controlPublicKey,
  bus: rigBusOf(parts),
  reach: parts.store.reachable.list(),
});

/**
 * The rig's runner processes as its settings have them now, or why they can't change. A rig
 * control is setting up, which has not reported yet, has none (Add a rig with its runners).
 */
function runnersNow(parts: ControlParts, rig: string) {
  const now = rigSettingsOf(parts.store, rig);
  const { store } = parts;
  const settingUp = store.clusters.rig(rig) ?? store.machines.rig(rig);
  if (!now && settingUp && settingUp.status !== "removed") return [];
  if (!now) return `There is no rig ${rig}.`;
  if (!now.settings)
    return `${rig}'s harness is older: it does not report its settings and cannot take runners. They work after its next roll.`;
  return now.settings.runners;
}

/**
 * Sets a runner process up on a cluster for a rig, in the background, and gives it to the rig.
 * Says why in words when it can't.
 */
export async function addClusterRunner(
  parts: ControlParts,
  i: ClusterRunnerRequest,
  by: string,
): Promise<{ rig: string; runner: string; said: string } | { error: string }> {
  const { store } = parts;
  const fail = (error: string) => ({ error });
  const { rig, runner } = i;
  if (!parts.rigImages) return fail("Control has no rig images configured.");
  if (!parts.publicUrl) return fail("Control's address for rigs is not set.");
  if (!parts.rigBus) return fail(NO_RIG_BUS);
  const runners = runnersNow(parts, rig);
  if (typeof runners === "string") return fail(runners);
  if (!RIG_ID.test(runner)) return fail(`A runner's name is ${RIG_NAME_RULE}.`);
  if (
    runners.some((r) => r.name === runner) ||
    store.rigRunners.get(rig, runner)?.status === "deploying"
  )
    return fail(`${rig} has a runner named ${runner} already.`);
  const setting = RunnerSetting.safeParse({ name: runner, pools: [i.pool] });
  if (!setting.success) return fail("A runner's pool is judge, shared or lane-1 to lane-16.");
  const k = store.clusters.get(i.cluster);
  if (!k) return fail("Choose a cluster.");
  const facts = k.facts as ClusterFacts | null;
  if (!facts || k.check_error)
    return fail(`${k.name} is not ready: check it under Settings › Machines.`);
  const gpus = i.gpus;
  if (gpus !== 0 && gpus !== 1) return fail("A runner on a cluster takes one GPU, or none.");
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
  const node = i.node || undefined;
  if (node && facts.nodes.length && !facts.nodes.some((n) => n.name === node))
    return fail(`${k.name} has no node ${node} that control can see.`);
  if (gpus && !deviceClass && node && !facts.nodes.some((n) => n.name === node && n.gpus >= 1))
    return fail(`${node} offers no GPU through the device plugin.`);
  const storageClass = i.storageClass || undefined;
  if (storageClass && !NS.test(storageClass)) return fail("That is not a storage class name.");
  const storageGi = i.storageGi ?? 100;
  if (!Number.isInteger(storageGi) || storageGi < 1 || storageGi > 10_000)
    return fail("The volume size is a whole number of GB, from 1 to 10000.");
  const unit = runnerUnit(rig, runner);
  let namespace: string;
  let quota: ClusterFacts["slots"][number]["quota"];
  if (k.placement === "slot") {
    namespace = i.slot ?? "";
    const slot = facts.slots.find((s) => s.namespace === namespace && s.usable);
    if (!slot) return fail("Choose a slot control may deploy to.");
    // A slot holds one rig: this one's core and runners may share it, another rig's may not.
    const other =
      store.clusters
        .rigs(k.name)
        .find((r) => r.namespace === namespace && r.status !== "removed" && r.rig !== rig)?.rig ??
      store.rigRunners.onCluster(k.name).find((r) => r.namespace === namespace && r.rig !== rig)
        ?.rig;
    if (other) return fail(`The slot ${namespace} holds the rig ${other}.`);
    quota = slot.quota;
    const net = await slotNetwork(
      parts.kube,
      clusterTarget(parts, k),
      namespace,
      { ...HARNESS_LABELS, "app.kubernetes.io/instance": unit },
      store.reachable.list(),
    );
    if (!net.ok)
      return fail(
        `Refused: in the slot ${namespace}, ${net.why}. A runner's harness may reach only DNS and the internet: ask the cluster's operators for a network rule that keeps it off the cluster.`,
      );
  } else {
    namespace = k.namespace_pattern.replace("{rig}", unit);
    if (!NS.test(namespace)) return fail(`"${namespace}" is not a namespace name.`);
  }
  let resources: { cpus: number; memoryGi: number } | undefined;
  if (i.cpus !== undefined || i.memoryGi !== undefined) {
    if (i.cpus === undefined || i.memoryGi === undefined)
      return fail("Give the runner both its CPUs and its memory, or neither.");
    try {
      rigResources({ cpus: i.cpus, memoryGi: i.memoryGi }, "headless");
    } catch (err) {
      return fail(errorText(err).replace("a rig needs", "a runner needs"));
    }
    resources = { cpus: i.cpus, memoryGi: i.memoryGi };
  }
  const devices = quotaRefusal(namespace, quota, { gpus, deviceClass });
  if (devices) return fail(devices);
  const cuda = gpus ? (i.cuda ?? cudaOfPlace(facts, { deviceClass, node })?.cuda) : undefined;
  const images = controlImages(parts, gpus, cuda);
  if (typeof images === "string") return fail(images);
  const token = newToken();
  store.rigRunners.add({
    rig,
    runner,
    tokenSha256: token.sha256,
    cluster: k.name,
    namespace,
    placement: k.placement === "slot" ? "slot" : "created",
    spec: {
      gpus,
      gpuMode: deviceClass ? "dra" : "device-plugin",
      deviceClass,
      node,
      storageClass,
      storageGi,
      resources,
      images,
      ...(cuda === "13" ? { cuda: "13" as const } : {}),
      pools: [i.pool],
    },
    created_by: by,
  });
  store.rigHistory.add(rig, "runner_added", true, `${runner} on ${k.name}`);
  const r = store.rigRunners.get(rig, runner) as RigRunner;
  void inBackground(
    store,
    "cluster",
    rig,
    "runner_applied",
    deployRunner(parts, r, token.token, by),
  );
  return {
    rig,
    runner,
    said: `Control sets ${runner} up on ${k.name}${node ? `, on ${node}` : ""}, then gives it to ${rig}: it takes runs once it answers the rig's core.`,
  };
}

/** Applies a runner process's objects, then gives it to its rig. */
async function deployRunner(parts: ControlParts, r: RigRunner, token: string, by: string) {
  const { store } = parts;
  const k = store.clusters.get(r.cluster);
  try {
    if (!k) throw new Error(`the cluster ${r.cluster} is no longer in Settings › Machines`);
    const objects = clusterRigObjects(runnerPlan(parts, r), {
      controlToken: token,
      harnessSupervisorToken: newToken().token,
    });
    const out = await parts.kube.kubectl(
      clusterTarget(parts, k),
      ["apply", "-f", "-"],
      asList(objects),
      120_000,
    );
    if (out.code !== 0) throw new Error(kubeError(out));
    store.rigRunners.setStatus(r.rig, r.runner, "running");
    store.rigHistory.add(r.rig, "runner_applied", true, `${r.runner}: namespace ${r.namespace}`);
  } catch (err) {
    store.rigRunners.setStatus(r.rig, r.runner, "failed");
    store.rigHistory.add(r.rig, "runner_applied", false, `${r.runner}: ${errorText(err)}`);
    return;
  }
  // A rig control is setting up gets its runners once it reports its settings.
  for (let t = 0; t < RIG_WAIT_TRIES && !rigSettingsOf(store, r.rig)?.settings; t++)
    await new Promise((done) => setTimeout(done, RIG_WAIT_MS));
  const now = runnersNow(parts, r.rig);
  if (typeof now === "string" || !rigSettingsOf(store, r.rig)?.settings) {
    const why = typeof now === "string" ? now : `${r.rig} has not reported its settings yet`;
    store.rigHistory.add(r.rig, "runner_given", false, `${r.runner}: ${why}`);
    return;
  }
  const out = await setRigSettings(
    parts,
    r.rig,
    {
      runners: [...now.filter((x) => x.name !== r.runner), { name: r.runner, pools: r.spec.pools }],
    },
    by,
    true,
  );
  store.rigHistory.add(
    r.rig,
    "runner_given",
    out.state !== "refused",
    `${r.runner}: ${out.state === "refused" ? out.error : out.said}`,
  );
}

/** Deletes what control set up for a runner process on its cluster; why not, in words. */
async function deleteRunnerObjects(parts: ControlParts, r: RigRunner): Promise<string | undefined> {
  const k = parts.store.clusters.get(r.cluster);
  if (!k) return undefined;
  const sel = [
    "-n",
    r.namespace,
    "-l",
    `app.kubernetes.io/instance=${runnerUnit(r.rig, r.runner)}`,
  ];
  const calls =
    r.placement === "created"
      ? [["delete", "namespace", r.namespace, "--wait=false", "--ignore-not-found"]]
      : [
          [
            "delete",
            "deployment,service,persistentvolumeclaim,secret",
            ...sel,
            "--ignore-not-found",
          ],
          // A cluster without DRA has no resource claim templates: this may fail harmlessly.
          ["delete", "resourceclaimtemplates", ...sel, "--ignore-not-found"],
        ];
  for (const [n, args] of calls.entries()) {
    const out = await parts.kube.kubectl(clusterTarget(parts, k), args, undefined, 120_000);
    if (out.code !== 0 && n === 0) return `on ${k.name}: ${kubeError(out)}`;
  }
  return undefined;
}

/**
 * A rig removed: its runner processes on clusters go with it, each recorded in its history. The
 * rig's retirement already ended their tokens.
 */
export async function dropRunners(parts: ControlParts, rig: string, by: string): Promise<void> {
  for (const r of parts.store.rigRunners.of(rig)) await dropRunner(parts, rig, r.runner, by);
}

/**
 * A runner process that left its rig's settings (Edit rig's Take it away): what control set up for
 * it goes, and its token stops working. Nothing for one someone started by hand.
 */
export async function dropRunner(
  parts: ControlParts,
  rig: string,
  runner: string,
  by: string,
): Promise<void> {
  const r = parts.store.rigRunners.get(rig, runner);
  if (!r || r.status === "removed") return;
  const failed = await deleteRunnerObjects(parts, r);
  if (failed) parts.store.rigHistory.add(rig, "runner_removed", false, `${runner}: ${failed}`);
  else {
    parts.store.rigRunners.remove(rig, runner, by);
    parts.store.rigHistory.add(rig, "runner_removed", true, runner);
  }
}

/**
 * Takes a runner process away from its rig: the rig hears first, so its core fails the runner's
 * run under way and the judge or the lane tries again; then control deletes its objects, if it
 * set it up, and its token stops working. One someone started by hand leaves the rig only.
 */
export async function removeRunner(
  parts: ControlParts,
  rig: string,
  runner: string,
  by: string,
): Promise<{ ok: string } | { error: string }> {
  const { store } = parts;
  const runners = runnersNow(parts, rig);
  const placed = store.rigRunners.get(rig, runner);
  const listed = typeof runners !== "string" && runners.some((r) => r.name === runner);
  if (!listed && (!placed || placed.status === "removed"))
    return { error: `${rig} has no runner ${runner}.` };
  if (listed && typeof runners !== "string") {
    const out = await setRigSettings(
      parts,
      rig,
      { runners: runners.filter((r) => r.name !== runner) },
      by,
      true,
    );
    if (out.state === "refused") return { error: out.error };
  }
  if (placed && placed.status !== "removed") {
    const failed = await deleteRunnerObjects(parts, placed);
    if (failed) {
      store.rigHistory.add(rig, "runner_removed", false, `${runner}: ${failed}`);
      return { error: `${runner} left ${rig}, but its objects stay: ${failed}` };
    }
    store.rigRunners.remove(rig, runner, by);
  }
  store.rigHistory.add(rig, "runner_removed", true, runner);
  return {
    ok: `${runner} left ${rig}: its run under way, if any, is tried again${placed ? ", and control removed what it set up" : ""}.`,
  };
}

/**
 * Moves a rig's runner processes on clusters onto control's current images, with the rig's own
 * update: their deployments are applied again; their secrets, volumes and services stay. A runner
 * whose pods restart fails its run under way, which the judge or its lane tries again. Each
 * outcome goes in the rig's history.
 */
export async function updateRunnerImages(parts: ControlParts, rig: string): Promise<void> {
  const { store } = parts;
  for (const r of store.rigRunners.of(rig)) {
    if (r.status === "removed") continue;
    const images = controlImages(parts, r.spec.gpus, r.spec.cuda);
    const k = store.clusters.get(r.cluster);
    if (typeof images === "string" || !k) {
      const why = typeof images === "string" ? images : `the cluster ${r.cluster} is gone`;
      store.rigHistory.add(rig, "runner_images", false, `${r.runner}: ${why}`);
      continue;
    }
    if (images.harness === r.spec.images.harness && images.supervisor === r.spec.images.supervisor)
      continue;
    const deployments = clusterRigObjects(
      { ...runnerPlan(parts, r), images },
      { controlToken: "", harnessSupervisorToken: "" },
    ).filter((o) => o.kind === "Deployment");
    const out = await parts.kube.kubectl(
      clusterTarget(parts, k),
      ["apply", "-f", "-"],
      asList(deployments),
      120_000,
    );
    if (out.code !== 0) {
      store.rigHistory.add(rig, "runner_images", false, `${r.runner}: ${kubeError(out)}`);
      continue;
    }
    store.rigRunners.setImages(rig, r.runner, images);
    store.rigHistory.add(rig, "runner_images", true, `${r.runner}: harness ${images.harness}`);
  }
}
