import type { ReachEntry } from "../../core/reach.ts";
import { type ClusterKubectl, type ClusterTarget, kubeError } from "./kubectl.ts";
import { harnessIngress, harnessKeptOffCluster, type SlotOpening } from "./netcheck.ts";

/**
 * What control reads from a cluster before it sets a rig up there, and again with "Check again".
 * Only reads: the server's version, its nodes and their GPUs (NVIDIA's device plugin), DRA device
 * classes, and the resource slices that say which GPU each class names (goal 132) where control may
 * read them, storage classes, and whether control may create namespaces (created placement) or
 * deploy into each slot (pre-made placement).
 */

export interface ClusterNode {
  name: string;
  ready: boolean;
  /** Allocatable nvidia.com/gpu (the device plugin); 0 when none. */
  gpus: number;
  gpu_product?: string | undefined;
  /** Its CPUs' architecture (`kubernetes.io/arch`), such as amd64 or arm64. */
  arch?: string | undefined;
  cpu: string;
  memory: string;
}

/**
 * What control knows of a GPU (goal 132): its name, compute capability and node's architecture;
 * for a DRA class that names one GPU, its node (goal 206).
 */
export interface GpuKind {
  product?: string | undefined;
  cc?: string | undefined;
  arch?: string | undefined;
  node?: string | undefined;
}

export interface ClusterSlot {
  namespace: string;
  /** Control may create the rig's objects there. */
  usable: boolean;
  /** A rig control set up there already, by its label. */
  used_by?: string | undefined;
  /** Whether the slot's network rules keep a harness off the cluster, and why. */
  network_ok?: boolean | undefined;
  network_why?: string | undefined;
  /** Each address of the list of addresses rigs may reach that the slot's rules open. */
  openings?: SlotOpening[] | undefined;
  /** Whether the slot's rules let only the rig's supervisor connect to the harness, and why not. */
  ingress_ok?: boolean | undefined;
  ingress_why?: string | undefined;
  /** What the slot's quota allows a rig (limits, else requests), when control can read it. */
  quota?: SlotQuota | undefined;
  /**
   * The nodes the slot takes pods on, when its rules name some (goal 206), and the cluster's
   * words for its rule; none: any node, or control can't tell.
   */
  nodes?: string[] | undefined;
  node_rule?: string | undefined;
}

/**
 * What a slot's quota allows, each when the quota sets it: CPUs, memory and storage; GPUs through
 * NVIDIA's device plugin (requests.nvidia.com/gpu); and devices of each DRA device class
 * (`<class>.deviceclass.resource.k8s.io/devices`).
 */
export interface SlotQuota {
  cpus?: number | undefined;
  memoryGi?: number | undefined;
  storageGi?: number | undefined;
  gpus?: number | undefined;
  devices?: Record<string, number> | undefined;
}

/** A Kubernetes quantity ("6", "5500m", "24Gi", "200G") in CPUs or GiB. */
export function quantity(v: unknown, unit: "cpu" | "gi"): number | undefined {
  const m = /^([0-9.]+)([a-zA-Z]*)$/.exec(String(v ?? "").trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return undefined;
  const suffix = m[2] ?? "";
  if (unit === "cpu") return suffix === "m" ? n / 1000 : suffix === "" ? n : undefined;
  const bytes: Record<string, number> = {
    "": 1,
    Ki: 2 ** 10,
    Mi: 2 ** 20,
    Gi: 2 ** 30,
    Ti: 2 ** 40,
    K: 1e3,
    M: 1e6,
    G: 1e9,
    T: 1e12,
  };
  const b = bytes[suffix];
  return b === undefined ? undefined : (n * b) / 2 ** 30;
}

/** The tightest of a slot's quotas, from `kubectl get resourcequota -o json`. */
export function slotQuota(json: string): ClusterSlot["quota"] {
  let items: {
    status?: { hard?: Record<string, string> };
    spec?: { hard?: Record<string, string> };
  }[] = [];
  try {
    items = (JSON.parse(json) as { items?: typeof items }).items ?? [];
  } catch {
    return undefined;
  }
  const min = (vals: (number | undefined)[]) => {
    const ok = vals.filter((x): x is number => x !== undefined);
    return ok.length ? Math.min(...ok) : undefined;
  };
  const hard = items.map((q) => q.status?.hard ?? q.spec?.hard ?? {});
  const pick = (keys: string[], unit: "cpu" | "gi") =>
    min(hard.flatMap((h) => keys.map((k) => quantity(h[k], unit))));
  const count = (v: unknown) => {
    const n = quantity(v, "cpu");
    return n !== undefined && Number.isInteger(n) ? n : undefined;
  };
  const devices: Record<string, number> = {};
  for (const h of hard)
    for (const [key, v] of Object.entries(h)) {
      const m = /^(.+)\.deviceclass\.resource\.k8s\.io\/devices$/.exec(key);
      const n = count(v);
      if (m?.[1] && n !== undefined) devices[m[1]] = Math.min(devices[m[1]] ?? n, n);
    }
  const out: SlotQuota = {
    cpus: pick(["limits.cpu", "requests.cpu", "cpu"], "cpu"),
    memoryGi: pick(["limits.memory", "requests.memory", "memory"], "gi"),
    storageGi: pick(["requests.storage"], "gi"),
    gpus: min(hard.map((h) => count(h["requests.nvidia.com/gpu"]))),
    ...(Object.keys(devices).length ? { devices } : {}),
  };
  return out.cpus === undefined &&
    out.memoryGi === undefined &&
    out.storageGi === undefined &&
    out.gpus === undefined &&
    !out.devices
    ? undefined
    : out;
}

export interface ClusterFacts {
  version: string;
  nodes: ClusterNode[];
  device_classes: string[];
  /**
   * Each DRA device class's GPU, where control can tell (goal 132): from the GPU UUIDs or names
   * its selectors give, found in the cluster's resource slices. None: control may not read them.
   */
  gpu_classes?: Record<string, GpuKind> | undefined;
  storage_classes: { name: string; default: boolean }[];
  can_create_namespaces: boolean;
  slots: ClusterSlot[];
}

type K8sList = { items?: Record<string, unknown>[] };
const json = (s: string): K8sList => {
  try {
    return JSON.parse(s) as K8sList;
  } catch {
    return {};
  }
};
const meta = (o: Record<string, unknown>) =>
  (o.metadata ?? {}) as {
    name?: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
  };

/** Nodes from `kubectl get nodes -o json`. */
export function parseNodes(text: string): ClusterNode[] {
  return (json(text).items ?? []).map((n) => {
    const status = (n.status ?? {}) as {
      allocatable?: Record<string, string>;
      conditions?: { type: string; status: string }[];
    };
    // A node with no architecture label has no `arch`, as before the check read it (goal 132).
    const arch = meta(n).labels?.["kubernetes.io/arch"];
    return {
      name: meta(n).name ?? "?",
      ready: (status.conditions ?? []).some((c) => c.type === "Ready" && c.status === "True"),
      gpus: Number(status.allocatable?.["nvidia.com/gpu"] ?? 0) || 0,
      gpu_product: meta(n).labels?.["nvidia.com/gpu.product"],
      ...(arch ? { arch } : {}),
      cpu: status.allocatable?.cpu ?? "?",
      memory: status.allocatable?.memory ?? "?",
    };
  });
}

/** A device attribute's value, under its own name or its driver's (gpu.nvidia.com/uuid). */
const attr = (attrs: Record<string, Record<string, unknown>>, name: string): string | undefined => {
  const key = Object.keys(attrs).find((k) => k === name || k.endsWith(`/${name}`));
  const v = key ? attrs[key] : undefined;
  const s = v?.string ?? v?.version ?? v?.int;
  return s === undefined ? undefined : String(s);
};

/**
 * Each DRA device class's GPU (goal 132), from `kubectl get deviceclasses -o json` and `kubectl
 * get resourceslices -o json`: a class whose selectors name a GPU's UUID gets that device's name,
 * compute capability, node and node's architecture; one that names a product gets that name.
 */
function gpuClasses(
  classesText: string,
  slicesText: string,
  nodes: ClusterNode[],
): Record<string, GpuKind> {
  const devices = (json(slicesText).items ?? []).flatMap((s) => {
    const spec = (s.spec ?? {}) as { nodeName?: string; devices?: Record<string, unknown>[] };
    const arch = nodes.find((n) => n.name === spec.nodeName)?.arch;
    return (spec.devices ?? []).map((d) => {
      const attrs = (d.attributes ??
        (d.basic as { attributes?: unknown })?.attributes ??
        {}) as Record<string, Record<string, unknown>>;
      return {
        uuid: attr(attrs, "uuid"),
        product: attr(attrs, "productName"),
        cc: attr(attrs, "cudaComputeCapability"),
        arch,
        node: spec.nodeName,
      };
    });
  });
  const out: Record<string, GpuKind> = {};
  for (const c of json(classesText).items ?? []) {
    const spec = c.spec as { selectors?: { cel?: { expression?: string } }[] } | undefined;
    const cel = (spec?.selectors ?? []).map((x) => x.cel?.expression ?? "").join("\n");
    const uuids: string[] = cel.match(/GPU-[0-9a-fA-F-]{36}/g) ?? [];
    const named = /productName[^=]*==\s*"([^"]+)"/.exec(cel)?.[1];
    const d = devices.find((x) => x.uuid && uuids.includes(x.uuid));
    const kind: GpuKind = d
      ? { product: d.product, cc: d.cc, arch: d.arch, ...(d.node ? { node: d.node } : {}) }
      : named
        ? { product: named }
        : {};
    if (kind.product || kind.cc || kind.arch) out[meta(c).name ?? "?"] = kind;
  }
  return out;
}

/** Storage classes from `kubectl get storageclass -o json`, the default one marked. */
export function parseStorageClasses(text: string): { name: string; default: boolean }[] {
  return (json(text).items ?? []).map((s) => ({
    name: meta(s).name ?? "?",
    default:
      meta(s).annotations?.["storageclass.kubernetes.io/is-default-class"] === "true" ||
      meta(s).annotations?.["storageclass.beta.kubernetes.io/is-default-class"] === "true",
  }));
}

/** The labels every rig's harness pod has (its instance label is added per rig). */
export const HARNESS_LABELS = {
  "app.kubernetes.io/name": "thermite",
  "app.kubernetes.io/managed-by": "thermite-control",
  "app.kubernetes.io/component": "harness",
};

/**
 * Reads a slot's network rules and says whether they keep a harness with these labels off the
 * cluster, beside the addresses of the owner's list (`reach`) they open; and whether only the
 * rig's supervisor may connect to the harness, which is a warning, never a refusal.
 */
export async function slotNetwork(
  k: ClusterKubectl,
  t: ClusterTarget,
  namespace: string,
  labels: Record<string, string>,
  reach: ReachEntry[],
): Promise<{
  ok: boolean;
  why: string;
  openings: SlotOpening[];
  ingress?: { ok: boolean; why: string } | undefined;
}> {
  const r = await k.kubectl(t, ["get", "networkpolicy", "-n", namespace, "-o", "json"]);
  if (r.code !== 0)
    return {
      ok: false,
      why: `control could not read the slot's network rules: ${kubeError(r)}`,
      openings: [],
    };
  const policies = (json(r.stdout).items ?? []) as never[];
  return {
    ...harnessKeptOffCluster(policies, labels, reach),
    ingress: harnessIngress(policies, labels),
  };
}

/**
 * Reads the cluster, each slot's network rules against the owner's list of addresses rigs may
 * reach. Throws, in words, when control can't reach it at all.
 */
export async function checkCluster(
  k: ClusterKubectl,
  t: ClusterTarget,
  slots: string[],
  reach: ReachEntry[] = [],
  image?: string | undefined,
): Promise<ClusterFacts> {
  const version = await k.kubectl(t, ["version", "-o", "json"]);
  if (version.code !== 0)
    throw new Error(`control could not reach the cluster: ${kubeError(version)}`);
  let gitVersion = "?";
  try {
    gitVersion =
      (JSON.parse(version.stdout) as { serverVersion?: { gitVersion?: string } }).serverVersion
        ?.gitVersion ?? "?";
  } catch {}
  const nodes = await k.kubectl(t, ["get", "nodes", "-o", "json"]);
  const classes = await k.kubectl(t, ["get", "deviceclasses", "-o", "json"]);
  const storage = await k.kubectl(t, ["get", "storageclass", "-o", "json"]);
  const ns = await k.kubectl(t, ["auth", "can-i", "create", "namespaces"]);
  // Which GPU each device class names (goal 132): only where control may read resource slices.
  const slices =
    classes.code === 0 ? await k.kubectl(t, ["get", "resourceslices", "-o", "json"]) : undefined;
  const nodeList = nodes.code === 0 ? parseNodes(nodes.stdout) : [];
  const out: ClusterFacts = {
    version: gitVersion,
    nodes: nodeList,
    device_classes:
      classes.code === 0 ? (json(classes.stdout).items ?? []).map((c) => meta(c).name ?? "?") : [],
    gpu_classes:
      classes.code === 0
        ? gpuClasses(classes.stdout, slices?.code === 0 ? slices.stdout : "{}", nodeList)
        : undefined,
    storage_classes: storage.code === 0 ? parseStorageClasses(storage.stdout) : [],
    can_create_namespaces: ns.stdout.trim() === "yes",
    slots: [],
  };
  for (const s of slots) {
    const can = await k.kubectl(t, ["auth", "can-i", "create", "deployments", "-n", s]);
    const used = await k.kubectl(t, [
      "get",
      "deployments",
      "-n",
      s,
      "-l",
      "app.kubernetes.io/managed-by=thermite-control",
      "-o",
      "jsonpath={.items[0].metadata.labels.app\\.kubernetes\\.io/instance}",
    ]);
    const by = used.code === 0 && used.stdout.trim() ? used.stdout.trim() : undefined;
    // A slot that holds a rig is read with that rig's labels, as Add a rig read it.
    const labels = by ? { ...HARNESS_LABELS, "app.kubernetes.io/instance": by } : HARNESS_LABELS;
    const net = await slotNetwork(k, t, s, labels, reach);
    const quotas = await k.kubectl(t, ["get", "resourcequota", "-n", s, "-o", "json"]);
    const usable = can.stdout.trim() === "yes";
    const rule = usable && image ? await slotNodes(k, t, s, labels, nodeList, image) : {};
    out.slots.push({
      namespace: s,
      usable,
      used_by: by,
      network_ok: net.ok,
      network_why: net.why,
      ...(net.openings.length ? { openings: net.openings } : {}),
      ...(net.ingress ? { ingress_ok: net.ingress.ok, ingress_why: net.ingress.why } : {}),
      quota: quotas.code === 0 ? slotQuota(quotas.stdout) : undefined,
      ...(rule.nodes ? { nodes: rule.nodes, node_rule: rule.why } : {}),
    });
  }
  return out;
}

/**
 * The node of a rig or a runner in a slot whose rules name its nodes (goal 206): the one given,
 * if the slot takes it; else `prefer` (a DRA class's GPU's node), if the slot takes it; else the
 * slot's one node; else why not, in words. A slot that names none takes any.
 */
export function nodeInSlot(
  slot: ClusterSlot | undefined,
  node: string | undefined,
  prefer?: string | undefined,
): { node: string | undefined } | { error: string } {
  const allowed = slot?.nodes;
  if (!slot || !allowed?.length) return { node };
  const why = {
    error: `The slot ${slot.namespace} takes pods only on ${allowed.join(", ")}: choose one of them as the node.`,
  };
  if (node) return allowed.includes(node) ? { node } : why;
  if (prefer && allowed.includes(prefer)) return { node: prefer };
  return allowed.length === 1 ? { node: allowed[0] } : why;
}

/**
 * The nodes a slot takes pods on, when its rules name some (goal 206): the cluster's own answer to
 * a dry run of a Deployment there, which its admission rules check and which creates nothing, with
 * no node, then on each ready node. Its image is control's own harness image (`image`), which a
 * slot's rules take as they take a rig's; a dry run pulls nothing. A slot that takes one with no node takes any; one that takes
 * none, whatever the node, refuses for another reason, which the rig's setup then says.
 */
async function slotNodes(
  k: ClusterKubectl,
  t: ClusterTarget,
  slot: string,
  labels: Record<string, string>,
  nodes: ClusterNode[],
  image: string,
): Promise<{ nodes?: string[]; why?: string }> {
  const probe = (node?: string) => {
    const meta = { name: "thermite-node-probe", labels };
    const pod = {
      ...(node ? { nodeSelector: { "kubernetes.io/hostname": node } } : {}),
      containers: [{ name: "probe", image }],
    };
    const deployment = {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: meta,
      spec: {
        replicas: 0,
        selector: { matchLabels: labels },
        template: { metadata: meta, spec: pod },
      },
    };
    return k.kubectl(
      t,
      ["create", "--dry-run=server", "-n", slot, "-f", "-"],
      JSON.stringify(deployment),
      30_000,
    );
  };
  const any = await probe();
  if (any.code === 0 || !nodes.length) return {};
  const ok: string[] = [];
  for (const n of nodes.filter((x) => x.ready))
    if ((await probe(n.name)).code === 0) ok.push(n.name);
  return ok.length ? { nodes: ok, why: kubeError(any) } : {};
}

/** A short line about the cluster, for the Providers list. */
export function clusterLine(f: ClusterFacts): string {
  const gpuNodes = f.nodes.filter((n) => n.gpus > 0);
  const gpus = gpuNodes.reduce((t, n) => t + n.gpus, 0);
  const def = f.storage_classes.find((s) => s.default)?.name;
  return [
    `Kubernetes ${f.version}`,
    `${f.nodes.length} node${f.nodes.length === 1 ? "" : "s"}${gpuNodes.length ? `, ${gpuNodes.length} with ${gpus} GPU${gpus === 1 ? "" : "s"}` : ", no GPU nodes"}`,
    f.device_classes.length ? `DRA: ${f.device_classes.join(", ")}` : "",
    def
      ? `storage ${def}`
      : f.storage_classes.length
        ? "no default storage class"
        : "no storage class",
  ]
    .filter(Boolean)
    .join(" · ");
}
