import type { Hono } from "hono";
import { RIG_ID } from "../../../core/ids.ts";
import {
  addClusterRunner,
  addMachineRunner,
  type ClusterFacts,
  rigReportsSettings,
} from "../../clusters/index.ts";
import type { MachineFacts } from "../../machines/index.ts";
import { setRigSettings } from "../../rigs/index.ts";
import type { ControlStore } from "../../store/index.ts";
import { infoLabel } from "../../ui/campaigns/new/index.ts";
import { esc } from "../../ui/components/index.ts";
import { rigHref } from "../../ui/urls.ts";
import type { Dashboard } from "../context.ts";

/**
 * Edit rig's Add a runner on a cluster (goal 206): where (a cluster, its slot, a node), its GPU,
 * how it asks for it, and its pool. Its own form, outside Edit rig's: control sets the runner up,
 * then gives it to the rig, which its history says.
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
function placeOf(value: string): Place {
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
export const machineAt = (machine: string, gpu: number) =>
  `${MACHINE}${encodeURIComponent(machine)}|${gpu}`;
/** A cluster's slot, node and way of asking for a GPU as a place's value. */
export const clusterAt = (cluster: string, slot: string, node: string, mode: string) =>
  [cluster, slot, node, mode].map(encodeURIComponent).join("|");

/**
 * Each place a runner can go: a cluster's slot (or its own namespace) and a node, or a machine's
 * GPU over SSH.
 */
function places(store: ControlStore, rig: string): { value: string; text: string }[] {
  const out: { value: string; text: string }[] = [];
  for (const k of store.clusters.list()) {
    const f = k.facts as ClusterFacts | null;
    if (!f || k.check_error) continue;
    // A slot holds one rig: this one's core and runners may share it.
    const others = new Set([
      ...store.clusters
        .rigs(k.name)
        .filter((r) => r.status !== "removed" && r.rig !== rig)
        .map((r) => r.namespace),
      ...store.rigRunners
        .onCluster(k.name)
        .filter((r) => r.rig !== rig)
        .map((r) => r.namespace),
    ]);
    const slots =
      k.placement === "slot"
        ? f.slots.filter((s) => s.usable && !others.has(s.namespace)).map((s) => s.namespace)
        : [""];
    const nodes = f.nodes.filter((n) => n.ready);
    for (const slot of slots)
      for (const n of nodes.length ? nodes : [undefined])
        out.push({
          value: [k.name, slot, n?.name ?? ""].map(encodeURIComponent).join("|"),
          text: [
            k.name,
            slot || "its own namespace",
            n
              ? `${n.name}${n.gpus ? ` · ${n.gpus} GPU${n.gpus > 1 ? "s" : ""}` : ""}${n.gpu_product ? ` (${n.gpu_product})` : ""}${n.arch ? `, ${n.arch}` : ""}`
              : "any node",
          ].join(" › "),
        });
  }
  for (const m of store.machines.list()) {
    const f = m.facts as MachineFacts | null;
    if (!f || m.check_error || !m.host_keys.length) continue;
    for (const g of f.gpus)
      out.push({
        value: machineAt(m.name, g.index),
        text: `${m.name} › over SSH › GPU ${g.index} · ${g.name}`,
      });
  }
  return out;
}

/** The ways a cluster's GPUs come: the device plugin, or one of its DRA device classes. */
function modes(store: ControlStore): string[] {
  const classes = new Set<string>();
  for (const k of store.clusters.list())
    for (const c of (k.facts as ClusterFacts | null)?.device_classes ?? []) classes.add(c);
  return ["device-plugin", ...[...classes].map((c) => `dra:${c}`)];
}

/**
 * The form's fields, for Edit rig's 4 · Where it runs: each takes `form="add-runner"`, so that it
 * belongs to the form after Edit rig's own (`runnerFormTag`).
 */
export function runnerOnClusterFields(store: ControlStore, rig: string, lanes: number): string {
  const where = places(store, rig);
  if (!where.length)
    return `<div class="muted small" style="margin-top:10px">To add a runner that control sets up, add a cluster or a machine under <a href="/ui/settings/machines">Settings › Machines</a>.</div>`;
  const opt = (v: string, t: string) => `<option value="${esc(v)}">${esc(t)}</option>`;
  const pools = [
    opt("judge", "The judge's"),
    opt("shared", "Shared: the judge and the lanes"),
    ...Array.from({ length: lanes }, (_, i) => opt(`lane-${i + 1}`, `Lane ${i + 1}'s`)),
  ].join("");
  return `<div class="sec-sub"><h3>Add a runner on a cluster or a machine</h3><div class="g3">
<label class="fd">${infoLabel("Runner name", "Its name in the rig: 2 to 40 lowercase letters, digits and dashes, such as the node's name.")}<input form="add-runner" name="runner" maxlength="40" required placeholder="spark-02"></label>
<label class="fd" style="grid-column:span 2">${infoLabel("Where", "A cluster under Settings › Machines, the slot it goes in (a free one, or one that holds this rig or its runners) and its node; or a GPU of a machine control reaches over SSH.")}<select form="add-runner" name="where">${where.map((w) => opt(w.value, w.text)).join("")}</select></label>
<label class="fd">${infoLabel("GPU", "One GPU of the node, or none: the node's CPUs.")}<select form="add-runner" name="gpus">${opt("1", "One GPU")}${opt("0", "None: its CPUs")}</select></label>
<label class="fd">${infoLabel("GPUs through", "On a cluster: NVIDIA's device plugin, or a DRA device class, as the cluster offers its GPUs. On a machine, its GPU comes through NVIDIA's container toolkit, whatever this says.")}<select form="add-runner" name="mode">${modes(
    store,
  )
    .map((m) => opt(m, m === "device-plugin" ? "NVIDIA's device plugin" : `DRA: ${m.slice(4)}`))
    .join("")}</select></label>
<label class="fd">${infoLabel("Its pool", "The judge's: only the judge measures there. Shared: the judge and every lane, in turn. A lane's: only that lane runs its run_experiment there.")}<select form="add-runner" name="pool">${pools}</select></label>
</div><div class="act" style="margin-top:8px"><button form="add-runner" class="sm">Add the runner</button><span class="muted small">Control sets it up, then gives it to the rig: it takes runs once it answers. The run goes on.</span></div></div>`;
}

/** The form itself, after Edit rig's own: its fields above name it. */
export const runnerFormTag = (rig: string, t: string) =>
  `<form id="add-runner" method="post" action="${rigHref(rig)}/runners"><input type="hidden" name="csrf" value="${t}"></form>`;

export function runnerRoutes(app: Hono, dash: Dashboard): void {
  const { parts } = dash;
  app.post("/ui/rigs/:rig/runners", async (c) => {
    const rig = c.req.param("rig");
    const f = await c.req.parseBody();
    const at = placeOf(String(f.where ?? ""));
    const runner = String(f.runner ?? "").trim();
    const pool = String(f.pool ?? "shared");
    const out =
      at.kind === "machine"
        ? await addMachineRunner(
            parts,
            { rig, runner, machine: at.machine, gpu: f.gpus === "0" ? undefined : at.gpu, pool },
            "owner:ui",
          )
        : await addClusterRunner(
            parts,
            {
              rig,
              runner,
              ...at,
              gpus: Number(f.gpus ?? 1),
              mode: String(f.mode ?? at.mode ?? "device-plugin"),
              pool,
            },
            "owner:ui",
          );
    const said = "error" in out ? `Not added: ${out.error}` : out.said;
    return c.redirect(
      `${rigHref(rig)}?${"error" in out ? "error" : "ok"}=${encodeURIComponent(said)}`,
      303,
    );
  });
}

/**
 * The runners Add a rig's form chose (goal 206): each GPU row given a pool, with its name, place,
 * GPU and how it asks for it. Not used, or no pool: none.
 */
export function addRigRunnersChosen(f: Record<string, unknown>): {
  runner: string;
  at: Place;
  gpus: number;
  mode: string;
  pool: string;
}[] {
  const one = (k: string) => {
    const v = f[k];
    return String(Array.isArray(v) ? v[0] : (v ?? "")).trim();
  };
  const out = [];
  for (let i = 0; `ar_at__${i}` in f; i++) {
    const pool = one(`ar_pool__${i}`);
    if (!pool || pool === "off") continue;
    const at = placeOf(one(`ar_at__${i}`));
    const mode =
      one(`ar_mode__${i}`) || (at.kind === "cluster" ? at.mode : undefined) || "device-plugin";
    const named =
      one(`ar_name__${i}`) ||
      (at.kind === "machine" ? `${at.machine}-gpu-${at.gpu ?? 0}` : (at.node ?? ""));
    out.push({
      runner: RIG_ID.test(named) ? named : `runner-${i + 1}`,
      at,
      gpus: mode === "none" ? 0 : 1,
      mode: mode === "none" ? "device-plugin" : mode,
      pool,
    });
  }
  return out;
}

/**
 * Sets up the runners Add a rig chose, after the rig itself: each is refused or set up on its own,
 * and the rig's history says so; the first refusal is returned, in words.
 */
export async function addRigRunners(
  parts: Dashboard["parts"],
  rig: string,
  chosen: ReturnType<typeof addRigRunnersChosen>,
): Promise<string | undefined> {
  let first: string | undefined;
  for (const r of chosen) {
    const { at, ...rest } = r;
    const out =
      at.kind === "machine"
        ? await addMachineRunner(
            parts,
            {
              rig,
              runner: r.runner,
              machine: at.machine,
              gpu: r.gpus ? at.gpu : undefined,
              pool: r.pool,
            },
            "owner:ui",
          )
        : await addClusterRunner(parts, { rig, ...rest, ...at, mode: r.mode }, "owner:ui");
    if ("error" in out) {
      parts.store.rigHistory.add(rig, "runner_added", false, `${r.runner}: ${out.error}`);
      first ??= `${r.runner}: ${out.error}`;
    }
  }
  return first;
}

/**
 * Add a rig's Workers at a time (goal 206), sent once the rig reports its settings, as Edit rig
 * sends it; its history says how it went.
 */
export async function giveWorkers(
  parts: Dashboard["parts"],
  rig: string,
  lanes: number,
): Promise<void> {
  const { store } = parts;
  if (!(await rigReportsSettings(parts, rig))) {
    store.rigHistory.add(rig, "workers_given", false, `${rig} has not reported its settings yet`);
    return;
  }
  const out = await setRigSettings(parts, rig, { lanes }, "owner:ui", true);
  store.rigHistory.add(
    rig,
    "workers_given",
    out.state !== "refused",
    out.state === "refused" ? out.error : `${lanes} at a time: ${out.said}`,
  );
}
