import { RIG_ID } from "../../../core/ids.ts";
import { type ClusterFacts, clusterLine, cudaFor, quantity } from "../../clusters/index.ts";
import { factsLine, type MachineFacts } from "../../machines/index.ts";
import type { Cluster, ControlStore, Machine } from "../../store/index.ts";
import { esc, infoLabel } from "../../ui/components/index.ts";
import { clusterAt, machineAt, type Place } from "./runners.ts";

/**
 * Add a rig's places (goal 206): where the rig's core can go, a machine over SSH, a free slot of a
 * cluster or a namespace of its own, and every free GPU control knows that can be one of its
 * runners, grouped by the machine, node or slot it is on, each in a pool the owner chooses.
 */

/** Why a machine can't take a rig or a runner now, or nothing. */
export function machineNotReady(m: Machine): string | undefined {
  const f = m.facts as MachineFacts | null;
  if (!m.host_keys.length) return "its host key is not trusted yet";
  if (!f) return "it has not been checked yet";
  if (m.check_error) return `its last check failed: ${m.check_error}`;
  if (!f.podman) return "Podman is missing";
  if (!f.systemd) return "it has no systemd";
  if (!f.root && f.linger === false) return "lingering is off for its user";
  return undefined;
}

/** Why a cluster can't take a rig's core now, or nothing. */
function clusterNotReady(k: Cluster): string | undefined {
  const f = k.facts as ClusterFacts | null;
  if (!f) return "it has not been checked yet";
  if (k.check_error) return `its last check failed: ${k.check_error}`;
  if (k.placement === "created" && !f.can_create_namespaces)
    return "control may not create namespaces there";
  if (k.placement === "slot" && !f.slots.some((s) => s.usable && !s.used_by))
    return "it has no free slot";
  return undefined;
}

/** A cluster's slots no rig holds, by its core or its runners. */
function freeSlots(store: ControlStore, k: Cluster) {
  const f = k.facts as ClusterFacts;
  const held = new Set([
    ...store.clusters
      .rigs(k.name)
      .filter((r) => r.status !== "removed")
      .map((r) => r.namespace),
    ...store.rigRunners.onCluster(k.name).map((r) => r.namespace),
  ]);
  return f.slots.filter((s) => s.usable && !s.used_by && !held.has(s.namespace));
}

/** amd64 or arm64, as the images name them; empty when unknown. */
const archOf = (a: string | undefined) =>
  a === "x86_64" ? "amd64" : a === "aarch64" ? "arm64" : (a ?? "");
/** A node's memory, such as "131072Ki", in whole GiB. */
const gib = (q: string) => {
  const n = quantity(q, "gi");
  return n === undefined ? q : `${Math.round(n)} GiB`;
};
const checked = (at: string | null) =>
  at
    ? `checked ${at.slice(11, 16)} UTC${at.slice(0, 10) === new Date().toISOString().slice(0, 10) ? "" : `, ${at.slice(0, 10)}`}`
    : "";
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** A place the rig's core can go. */
interface CorePlace {
  /** The form's `place`: machine:<m>, cluster:<k>, or cluster:<k>|<slot>. */
  value: string;
  name: string;
  where: string;
  facts: string;
  checked: string;
  why?: string | undefined;
  /** A cluster's core: the CPUs, memory (GiB) and volume (GB) it starts with; empty: the defaults. */
  size?: { cpus: string; memoryGi: string; diskGb: string } | undefined;
  arch: string;
}

/** Every place the rig's core can go, a not-ready one with why. */
export function corePlaces(store: ControlStore): CorePlace[] {
  const out: CorePlace[] = [];
  for (const m of store.machines.list()) {
    const f = m.facts as MachineFacts | null;
    out.push({
      value: `machine:${m.name}`,
      name: m.name,
      where: "over SSH",
      facts: f ? factsLine(f) : "",
      checked: checked(m.checked_at),
      why: machineNotReady(m),
      arch: archOf(f?.arch),
    });
  }
  for (const k of store.clusters.list()) {
    const why = clusterNotReady(k);
    const f = k.facts as ClusterFacts | null;
    if (why || !f) {
      out.push({
        value: `cluster:${k.name}`,
        name: k.name,
        where: "Kubernetes",
        facts: "",
        checked: checked(k.checked_at),
        why,
        arch: "",
      });
      continue;
    }
    if (k.placement === "created") {
      out.push({
        value: `cluster:${k.name}`,
        name: k.name,
        where: "Kubernetes · a namespace of its own",
        facts: `${clusterLine(f)} · namespace ${k.namespace_pattern}`,
        checked: checked(k.checked_at),
        size: { cpus: "", memoryGi: "", diskGb: "100" },
        arch: "",
      });
      continue;
    }
    for (const s of freeSlots(store, k)) {
      const q = s.quota;
      const devices = Object.values(q?.devices ?? {}).reduce((a, b) => a + b, 0) + (q?.gpus ?? 0);
      out.push({
        value: `cluster:${k.name}|${s.namespace}`,
        name: s.namespace,
        where: `a slot of ${k.name}`,
        facts: q
          ? [
              q.cpus !== undefined ? `${q.cpus} CPUs` : "",
              q.memoryGi !== undefined ? `${Math.floor(q.memoryGi)} GiB` : "",
              q.storageGi !== undefined ? `${Math.floor(q.storageGi)} GB of volumes` : "",
              devices ? plural(devices, "GPU") : "no GPU",
            ]
              .filter(Boolean)
              .join(" · ")
          : "its quota can't be read: the namespace's defaults apply",
        checked: checked(k.checked_at),
        size: {
          cpus: q?.cpus !== undefined ? String(q.cpus) : "",
          memoryGi: q?.memoryGi !== undefined ? String(Math.floor(q.memoryGi)) : "",
          diskGb: q?.storageGi !== undefined ? String(Math.floor(q.storageGi)) : "100",
        },
        arch: "",
      });
    }
  }
  return out;
}

/** One GPU that can be a runner. */
interface RunnerGpu {
  /** The form's ar_at__<n>. */
  at: string;
  label: string;
  /** Its name as the GPU reports it: a rig's runners are of one kind. */
  product: string;
  cuda: "12" | "13";
  /** The runner's name in the rig, and how the page's summary calls it. */
  runner: string;
  says: string;
  /** Why it can't be one now, such as the rig that uses it. */
  used?: string | undefined;
}

/** A machine, node or slot and its GPUs that can be runners. */
interface RunnerGroup {
  key: string;
  name: string;
  where: string;
  facts: string;
  /** The core's places that would put the core here too. */
  core: string[];
  /** A node or a machine by name, whose GPUs are named for it. */
  named: boolean;
  gpus: Omit<RunnerGpu, "runner" | "says">[];
}

/** The GPU's model as a short word for a runner's name, such as gb10 or p100. */
const shortOf = (product: string) =>
  (/\b(GB\d+|[A-Z]{1,2}\d{2,4}[A-Z]?|RTX ?\d{4})\b/i.exec(product)?.[1] ?? "gpu")
    .replace(/\s/g, "")
    .toLowerCase();

/** Every free GPU control knows, grouped by its machine, node or slot, each with its runner's name. */
export function runnerGroups(store: ControlStore): (Omit<RunnerGroup, "gpus"> & {
  gpus: RunnerGpu[];
})[] {
  const groups = new Map<string, RunnerGroup>();
  const group = (g: Omit<RunnerGroup, "gpus">) => {
    const had = groups.get(g.key);
    if (had) return had;
    const made = { ...g, gpus: [] };
    groups.set(g.key, made);
    return made;
  };
  for (const m of store.machines.list()) {
    const f = m.facts as MachineFacts | null;
    if (!f?.gpus.length || machineNotReady(m)) continue;
    const toolkit = Boolean(f.nvidia_ctk && f.cdi);
    const rigs = new Map(
      store.machines
        .rigs(m.name)
        .filter((r) => r.status !== "removed")
        .flatMap((r) => r.gpus.map((g) => [g, `rig ${r.rig}`] as const)),
    );
    const runners = new Map(
      store.rigRunners
        .onCluster(m.name)
        .filter((r) => r.placement === "machine" && r.spec.gpuIndex !== undefined)
        .map((r) => [r.spec.gpuIndex as number, `runner ${r.runner} of ${r.rig}`] as const),
    );
    const g = group({
      key: `machine:${m.name}`,
      name: m.name,
      where: "over SSH",
      facts: [archOf(f.arch), `${f.cpus} CPUs`, `${Math.round(f.mem_kib / 1024 / 1024)} GiB`]
        .filter(Boolean)
        .join(" · "),
      core: [`machine:${m.name}`],
      named: true,
    });
    for (const x of f.gpus) {
      const by = rigs.get(x.index) ?? runners.get(x.index);
      g.gpus.push({
        at: machineAt(m.name, x.index),
        label: `GPU ${x.index} · ${x.name}`,
        product: x.name,
        cuda: cudaFor({ product: x.name, arch: f.arch })?.cuda ?? "12",
        used: by
          ? `Used by ${by}.`
          : toolkit
            ? undefined
            : "Needs NVIDIA's container toolkit first: install it under Providers.",
      });
    }
  }
  for (const k of store.clusters.list()) {
    const f = k.facts as ClusterFacts | null;
    if (!f || k.check_error) continue;
    const slots =
      k.placement === "slot"
        ? freeSlots(store, k)
        : k.placement === "created" && f.can_create_namespaces
          ? [undefined]
          : [];
    for (const s of slots) {
      const slot = s?.namespace ?? "";
      const q = s?.quota;
      const nodeGroup = (node: string) => {
        const n = f.nodes.find((x) => x.name === node);
        return group({
          key: `cluster:${k.name}|${slot}|${node}`,
          name: node,
          where: slot ? `a node of ${k.name} · slot ${slot}` : `a node of ${k.name}`,
          facts: n
            ? [archOf(n.arch), `${n.cpu} CPUs`, gib(n.memory)].filter(Boolean).join(" · ")
            : "",
          core: slot ? [`cluster:${k.name}|${slot}`] : [],
          named: true,
        });
      };
      // DRA: the classes the slot's quota allows, each as many times; with no such quota, each
      // class whose GPU control knows, once.
      const classes: [string, number][] = q?.devices
        ? Object.entries(q.devices).filter(([c, n]) => n > 0 && f.device_classes.includes(c))
        : Object.keys(f.gpu_classes ?? {}).map((c) => [c, 1]);
      for (const [c, n] of classes) {
        const kind = f.gpu_classes?.[c] ?? {};
        const g = kind.node
          ? nodeGroup(kind.node)
          : group({
              key: `cluster:${k.name}|${slot}|`,
              name: slot || k.name,
              where: slot ? `a slot of ${k.name}` : "Kubernetes",
              facts: "GPUs through DRA: the device class picks the node",
              core: slot ? [`cluster:${k.name}|${slot}`] : [],
              named: false,
            });
        for (let i = 0; i < n; i++)
          g.gpus.push({
            at: clusterAt(k.name, slot, "", `dra:${c}`),
            label: `${kind.product ?? "A GPU"} · DRA class ${c}${n > 1 ? ` · ${i + 1} of ${n}` : ""}`,
            product: kind.product ?? "",
            cuda: cudaFor(kind)?.cuda ?? "12",
          });
      }
      // NVIDIA's device plugin: each node's GPUs, as many as the slot's quota allows.
      let room = q ? (q.gpus ?? Number.POSITIVE_INFINITY) : Number.POSITIVE_INFINITY;
      for (const n of f.nodes.filter((x) => x.ready && x.gpus > 0)) {
        const g = nodeGroup(n.name);
        for (let i = 0; i < n.gpus && room > 0; i++, room--)
          g.gpus.push({
            at: clusterAt(k.name, slot, n.name, "device-plugin"),
            label: `GPU ${i} · ${n.gpu_product ?? "an NVIDIA GPU"}`,
            product: n.gpu_product ?? "",
            cuda: cudaFor({ product: n.gpu_product, arch: n.arch })?.cuda ?? "12",
          });
      }
    }
  }
  // Each runner's name: its node's or machine's, numbered when it has several; else its GPU's.
  const taken = new Set<string>();
  const nameOf = (want: string, short: string) => {
    let name = RIG_ID.test(want) && !taken.has(want) ? want : "";
    for (let i = 1; !name; i++) if (!taken.has(`${short}-${i}`)) name = `${short}-${i}`;
    taken.add(name);
    return name;
  };
  return [...groups.values()]
    .filter((g) => g.gpus.length)
    .map((g) => ({
      ...g,
      gpus: g.gpus.map((x, i) => {
        const short = shortOf(x.product);
        const one = g.gpus.length === 1;
        const runner = nameOf(g.named ? (one ? g.name : `${g.name}-${i + 1}`) : "", short);
        const word = short === "gpu" ? "GPU" : short.toUpperCase();
        return {
          ...x,
          runner,
          says: g.named ? `${g.name}'s ${word}${one ? "" : ` ${i + 1}`}` : runner,
        };
      }),
    }));
}

/** A runner's GPU as control last read it, for the check that a rig's runners are of one kind. */
export function productAt(store: ControlStore, at: Place): string {
  if (at.kind === "machine") {
    const f = store.machines.get(at.machine)?.facts as MachineFacts | null | undefined;
    return f?.gpus.find((g) => g.index === at.gpu)?.name ?? "";
  }
  const f = store.clusters.get(at.cluster)?.facts as ClusterFacts | null | undefined;
  if (at.mode?.startsWith("dra:")) return f?.gpu_classes?.[at.mode.slice(4)]?.product ?? "";
  return f?.nodes.find((n) => n.name === at.node)?.gpu_product ?? "";
}

/** The pools a runner row offers: not used first chosen, as the form sends none. */
const POOL_TIP =
  "The runner's pool. The judge's: only the judge measures here. Shared: the judge and every lane, in turn. A lane's: only that lane tries its changes here, with run_experiment, and the judge never measures on it. Not used: it stays free for other rigs.";

/** Add a rig's 1 · The core: a radio row for each place, a not-ready one disabled with why. */
export function coreRows(places: CorePlace[], wanted: string | undefined): string {
  const first = places.find((p) => !p.why)?.value;
  const on = (p: CorePlace) =>
    !p.why && (wanted ? wanted === p.value || wanted === p.value.split("|")[0] : p.value === first);
  let chosen = false;
  return places
    .map((p) => {
      const checked = !chosen && on(p);
      if (checked) chosen = true;
      const size = p.size
        ? ` data-cpus="${esc(p.size.cpus)}" data-mem="${esc(p.size.memoryGi)}" data-disk="${esc(p.size.diskGb)}"`
        : "";
      return `<label class="ar-place${p.why ? " dis" : ""}${checked ? " on" : ""}"><input type="radio" name="place" value="${esc(p.value)}"${p.why ? " disabled" : checked ? " checked" : ""} data-name="${esc(p.name)}" data-arch="${esc(p.arch)}"${size}><span class="ar-what"><span><b>${esc(p.name)}</b> <span class="chip">${esc(p.where)}</span>${p.checked && !p.why ? ` <span class="chip ok">${esc(p.checked)}</span>` : ""} <span class="chip info" data-core-chip hidden>the core</span></span><span class="muted small">${esc(p.why ? `Not ready: ${p.why}. Fix it under Settings › Machines.` : p.facts)}</span></span></label>`;
    })
    .join("");
}

/** Add a rig's 2 · Runners: each group's GPUs, each with its pool, not used by default. */
export function runnerRows(groups: ReturnType<typeof runnerGroups>): string {
  const opt = (v: string, t: string, on = false) =>
    `<option value="${v}"${on ? " selected" : ""}>${esc(t)}</option>`;
  const pools = [
    opt("judge", "The judge's"),
    opt("shared", "Shared: the judge and the lanes"),
    ...Array.from({ length: 16 }, (_, i) => opt(`lane-${i + 1}`, `Lane ${i + 1}'s`)),
    opt("off", "Not used", true),
  ].join("");
  let n = 0;
  return groups
    .map(
      (g) =>
        `<div class="ar-mach" data-core-of="${esc(g.core.join(" "))}"><div><b>${esc(g.name)}</b> <span class="chip">${esc(g.where)}</span> <span class="chip info" data-core-too hidden>the core too</span> <span class="muted small">${esc(g.facts)}</span></div>${g.gpus
          .map((x) => {
            const i = n++;
            return `<div class="ar-gpu" data-gpu data-product="${esc(x.product)}" data-cuda="${x.cuda}" data-says="${esc(x.says)}"><span class="small">${infoLabel(x.label, POOL_TIP)}</span><span><input type="hidden" name="ar_at__${i}" value="${esc(x.at)}"><input type="hidden" name="ar_name__${i}" value="${esc(x.runner)}"><select class="ar-pool" name="ar_pool__${i}" aria-label="${esc(`The pool of ${x.says}`)}"${x.used ? " disabled" : ""}>${pools}</select></span><span class="muted small" data-pool-says>${esc(x.used ?? "Not used: free for other rigs.")}</span></div>`;
          })
          .join("")}</div>`,
    )
    .join("");
}
