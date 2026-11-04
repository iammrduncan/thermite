import { RIG_ID } from "../../../core/ids.ts";
import { type ClusterFacts, clusterLine, cudaFor, quantity } from "../../clusters/index.ts";
import { factsLine, type MachineFacts } from "../../machines/index.ts";
import type { Cluster, ControlStore, Machine } from "../../store/index.ts";
import { esc, infoLabel } from "../../ui/components/index.ts";

/**
 * Add a rig's places (goal 206): where the rig's core can go, a machine over SSH, a free slot of a
 * cluster or a namespace of its own, and every free GPU control knows that can be one of its
 * runners, grouped by the machine, node or slot it is on, each in a pool the owner chooses.
 */

/** A machine's GPU as a place's value: never a cluster's, whose names have no `@`. */
const MACHINE = "@machine|";

/**
 * A place's value read back: a machine and its GPU, or a cluster, its slot, a node and how the
 * runner asks for its GPU (Add a rig's rows say; Edit rig's form has a field of its own).
 */
export type Place =
  | { kind: "machine"; machine: string; gpu: number | undefined }
  | {
      kind: "cluster";
      cluster: string;
      slot: string | undefined;
      node: string | undefined;
      mode: string | undefined;
    };
export function placeOf(value: string): Place {
  const parts = value.split("|").map((x) => decodeURIComponent(x));
  if (value.startsWith(MACHINE))
    return {
      kind: "machine",
      machine: parts[1] ?? "",
      gpu: parts[2] ? Number(parts[2]) : undefined,
    };
  const [cluster = "", slot = "", node = "", mode = ""] = parts;
  return {
    kind: "cluster",
    cluster,
    slot: slot || undefined,
    node: node || undefined,
    mode: mode || undefined,
  };
}

/** A machine's GPU as a place's value. */
const machineAt = (machine: string, gpu: number) =>
  `${MACHINE}${encodeURIComponent(machine)}|${gpu}`;
/** A cluster's slot, node and way of asking for a GPU as a place's value. */
const clusterAt = (cluster: string, slot: string, node: string, mode: string) =>
  [cluster, slot, node, mode].map(encodeURIComponent).join("|");

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

/** A cluster's slots no rig holds, by its core or its runners, but `rig` itself. */
function freeSlots(store: ControlStore, k: Cluster, rig?: string) {
  const f = k.facts as ClusterFacts;
  const held = new Set([
    ...store.clusters
      .rigs(k.name)
      .filter((r) => r.status !== "removed" && r.rig !== rig)
      .map((r) => r.namespace),
    ...store.rigRunners
      .onCluster(k.name)
      .filter((r) => r.rig !== rig)
      .map((r) => r.namespace),
  ]);
  return f.slots.filter(
    (s) => s.usable && (!s.used_by || s.used_by === rig) && !held.has(s.namespace),
  );
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
  /** Its GPUs: a place with none comes first for the core, which needs none. */
  gpus: number;
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
      gpus: f?.gpus.length ?? 0,
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
        gpus: 0,
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
        gpus: f.nodes.reduce((n, x) => n + x.gpus, 0),
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
        gpus: devices,
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

/**
 * Every free GPU control knows, grouped by its machine, node or slot, each with its runner's name;
 * for Edit rig, `rig`'s own slots too, and none of its runners' names (`names`: those it reports).
 */
export function runnerGroups(
  store: ControlStore,
  rig?: string,
  names: string[] = [],
): (Omit<RunnerGroup, "gpus"> & {
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
        ? freeSlots(store, k, rig)
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
      // DRA: in a slot whose quota control reads, the classes it names, each as many times as it
      // allows (a slot whose quota names none takes no GPU); else each class whose GPU control
      // knows, once.
      const classes: [string, number][] = q
        ? Object.entries(q.devices ?? {}).filter(([c, n]) => n > 0 && f.device_classes.includes(c))
        : Object.keys(f.gpu_classes ?? {}).map((c) => [c, 1]);
      // Less the devices of each class the slot's runners take already.
      const inUse = (c: string) =>
        slot
          ? store.rigRunners
              .onCluster(k.name)
              .filter((r) => r.namespace === slot && r.spec.deviceClass === c).length
          : 0;
      for (const [c, all] of classes) {
        const n = all - inUse(c);
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
  const taken = new Set<string>([
    ...names,
    ...(rig ? store.rigRunners.of(rig).map((r) => r.runner) : []),
  ]);
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

/** What a runner's pool means, beside its field. */
const POOL_TIP =
  "The judge's: only the judge measures here. Shared: the judge and every lane, in turn, first come, first served. A lane's: only that lane tries its changes here, with run_experiment, and the judge never measures on it.";

/**
 * The core's place chosen first: the one Settings › Machines' Add a rig here asked for, else the
 * first ready one without a GPU, as the core needs none, else the first ready one.
 */
export function firstPlace(places: CorePlace[], wanted: string | undefined) {
  const ready = places.filter((p) => !p.why);
  return wanted
    ? ready.find((p) => wanted === p.value || wanted === p.value.split("|")[0])
    : (ready.find((p) => !p.gpus) ?? ready[0]);
}

/** Add a rig's 1 · The core: a radio row for each place, a not-ready one disabled with why. */
export function coreRows(places: CorePlace[], wanted: string | undefined): string {
  const first = firstPlace(places, wanted)?.value;
  return places
    .map((p) => {
      const checked = p.value === first;
      const size = p.size
        ? ` data-cpus="${esc(p.size.cpus)}" data-mem="${esc(p.size.memoryGi)}" data-disk="${esc(p.size.diskGb)}"`
        : "";
      return `<label class="ar-place${p.why ? " dis" : ""}${checked ? " on" : ""}"><input type="radio" name="place" value="${esc(p.value)}"${p.why ? " disabled" : checked ? " checked" : ""} data-name="${esc(p.name)}" data-arch="${esc(p.arch)}"${size}><span class="ar-what"><span><b>${esc(p.name)}</b> <span class="chip">${esc(p.where)}</span>${p.checked && !p.why ? ` <span class="chip ok">${esc(p.checked)}</span>` : ""} <span class="chip info" data-core-chip hidden>the core</span></span><span class="muted small">${esc(p.why ? `Not ready: ${p.why}. Fix it under Settings › Machines.` : p.facts)}</span></span></label>`;
    })
    .join("");
}

/**
 * Add a rig's 2 · Runners (goal 206): none at first; **+ Add a runner** adds a row where the owner
 * picks a machine (a machine over SSH, a node or a slot), then one of its free GPUs, then the
 * runner's pool. The row comes from a template the page's script copies; without the script, one
 * row is in the form. Each row sends `runner_new__<n>` (the runner's name, `=`, its place) and
 * `runner_new_pool__<n>`.
 */
export function runnerPicker(groups: ReturnType<typeof runnerGroups>): string {
  if (!groups.length)
    return `<div class="card"><div class="empty">No free GPU that control knows. Without runners, the rig measures on its core's CPUs.</div></div>`;
  const opt = (v: string, t: string, more = "") =>
    `<option value="${esc(v)}"${more}>${esc(t)}</option>`;
  const machines = groups
    .map((g, i) =>
      opt(
        String(i),
        `${g.name} · ${g.where}${g.facts ? ` (${g.facts})` : ""}`,
        ` data-core-of="${esc(g.core.join(" "))}"`,
      ),
    )
    .join("");
  const gpus = groups
    .flatMap((g, i) =>
      g.gpus.map((x) =>
        opt(
          `${x.runner}=${x.at}`,
          x.used ? `${x.label}: ${x.used}` : x.label,
          ` data-group="${i}" data-product="${esc(x.product)}" data-cuda="${x.cuda}" data-says="${esc(x.says)}"${x.used ? " disabled" : ""}`,
        ),
      ),
    )
    .join("");
  const pools = [
    opt("judge", "The judge's"),
    opt("shared", "Shared: the judge and the lanes"),
    ...Array.from({ length: 16 }, (_, i) => opt(`lane-${i + 1}`, `Lane ${i + 1}'s`)),
  ].join("");
  const row = (n: string) =>
    `<div class="ar-run" data-runner-row><label class="fd">${infoLabel("Machine", "A machine control reaches over SSH, a node of a cluster, or a slot whose GPUs come through DRA, where the device class picks the node.")}<select data-machine aria-label="The runner's machine"><option value="">Choose a machine</option>${machines}</select></label><label class="fd">${infoLabel("GPU", "One of the machine's free GPUs: the runner takes it alone, one run at a time.")}<select name="runner_new__${n}" data-gpu-pick aria-label="The runner's GPU"><option value="">Choose its GPU</option>${gpus}</select></label><label class="fd">${infoLabel("Its pool", POOL_TIP)}<select class="ar-pool" name="runner_new_pool__${n}" aria-label="The runner's pool">${pools}</select></label><button type="button" class="sm" data-remove-runner>Remove</button><span class="muted small ar-says" data-pool-says></span></div>`;
  return `<div class="card flat" data-runner-list><div class="empty" data-runner-none>No runners yet: the rig measures on its core's CPUs. Add one for each GPU it should use.</div><noscript>${row("0")}</noscript></div><div class="act" style="margin-top:10px"><button type="button" class="sm" data-add-runner hidden>+ Add a runner</button></div><template id="ar-row">${row("N")}</template>`;
}
