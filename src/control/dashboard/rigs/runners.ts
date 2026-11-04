import type { Hono } from "hono";
import { addClusterRunner, type ClusterFacts } from "../../clusters/index.ts";
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

/** Each place a runner can go: a cluster's slot (or its own namespace) and a node. */
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
    return `<div class="muted small" style="margin-top:10px">To add a runner that control sets up, add a cluster under <a href="/ui/settings/machines">Settings › Machines</a>.</div>`;
  const opt = (v: string, t: string) => `<option value="${esc(v)}">${esc(t)}</option>`;
  const pools = [
    opt("judge", "The judge's"),
    opt("shared", "Shared: the judge and the lanes"),
    ...Array.from({ length: lanes }, (_, i) => opt(`lane-${i + 1}`, `Lane ${i + 1}'s`)),
  ].join("");
  return `<div class="sec-sub"><h3>Add a runner on a cluster</h3><div class="g3">
<label class="fd">${infoLabel("Runner name", "Its name in the rig: 2 to 40 lowercase letters, digits and dashes, such as the node's name.")}<input form="add-runner" name="runner" maxlength="40" required placeholder="spark-02"></label>
<label class="fd" style="grid-column:span 2">${infoLabel("Where", "A cluster under Settings › Machines, the slot it goes in (a free one, or one that holds this rig or its runners) and its node.")}<select form="add-runner" name="where">${where.map((w) => opt(w.value, w.text)).join("")}</select></label>
<label class="fd">${infoLabel("GPU", "One GPU of the node, or none: the node's CPUs.")}<select form="add-runner" name="gpus">${opt("1", "One GPU")}${opt("0", "None: its CPUs")}</select></label>
<label class="fd">${infoLabel("GPUs through", "NVIDIA's device plugin, or a DRA device class, as the cluster offers its GPUs.")}<select form="add-runner" name="mode">${modes(
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
    const [cluster = "", slot = "", node = ""] = String(f.where ?? "")
      .split("|")
      .map((x) => decodeURIComponent(x));
    const out = await addClusterRunner(
      parts,
      {
        rig,
        runner: String(f.runner ?? "").trim(),
        cluster,
        slot: slot || undefined,
        node: node || undefined,
        gpus: Number(f.gpus ?? 1),
        mode: String(f.mode ?? "device-plugin"),
        pool: String(f.pool ?? "shared"),
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
 * Add a rig's runners (goal 206): each node of a cluster control knows, with the pool its runner
 * would take and how it would ask for its GPU; Not used by default. The rig is set up first, then
 * each chosen runner, which the rig takes once it reports.
 */
export function addRigRunnersSection(store: ControlStore): string {
  const where = places(store, "").filter((w) => !w.value.endsWith("|"));
  if (!where.length) return "";
  const opt = (v: string, t: string) => `<option value="${esc(v)}">${esc(t)}</option>`;
  const ways = modes(store);
  const rows = where
    .map(
      (w, i) =>
        `<div class="rn"><div><b>${esc(w.text)}</b></div><div class="g3"><input type="hidden" name="ar_at__${i}" value="${esc(w.value)}">
<label class="fd">${infoLabel("Its pool", "Not used: no runner here. The judge's: only the judge measures there. Shared: the judge and every lane, in turn. A lane's: only that lane runs its run_experiment there.")}<select name="ar_pool__${i}">${opt("", "Not used")}${opt("judge", "The judge's")}${opt("shared", "Shared: the judge and the lanes")}${opt("lane-1", "Lane 1's")}${opt("lane-2", "Lane 2's")}${opt("lane-3", "Lane 3's")}${opt("lane-4", "Lane 4's")}</select></label>
<label class="fd">${infoLabel("Its GPU through", "One GPU of the node, through NVIDIA's device plugin or a DRA device class; or none: the node's CPUs.")}<select name="ar_mode__${i}">${ways.map((m) => opt(m, m === "device-plugin" ? "One GPU, NVIDIA's device plugin" : `One GPU, DRA: ${m.slice(4)}`)).join("")}${opt("none", "None: its CPUs")}</select></label></div></div>`,
    )
    .join("");
  return `<div class="sec"><h2>Runners on other machines</h2><p class="lead">A rig is a core and its runners. The core, above, keeps the run: its records, the planner, the lanes' agent programs and the judge's decisions; it needs no GPU. Each runner is one GPU of a node, in one pool, and takes one run at a time. Runners can be added and taken away later on Edit rig, while a run goes on.</p><div class="card flat">${rows}</div></div>`;
}

/** The runners Add a rig's form chose, each with its name (the node's), place, GPU and pool. */
export function addRigRunnersChosen(f: Record<string, unknown>): {
  runner: string;
  cluster: string;
  slot?: string;
  node?: string;
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
    if (!pool) continue;
    const [cluster = "", slot = "", node = ""] = one(`ar_at__${i}`)
      .split("|")
      .map((x) => decodeURIComponent(x));
    const mode = one(`ar_mode__${i}`) || "device-plugin";
    out.push({
      runner: /^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/.test(node) ? node : `runner-${i + 1}`,
      cluster,
      ...(slot ? { slot } : {}),
      ...(node ? { node } : {}),
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
    const out = await addClusterRunner(parts, { rig, ...r }, "owner:ui");
    if ("error" in out) {
      parts.store.rigHistory.add(rig, "runner_added", false, `${r.runner}: ${out.error}`);
      first ??= `${r.runner}: ${out.error}`;
    }
  }
  return first;
}
