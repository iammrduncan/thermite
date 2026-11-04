import type { Hono } from "hono";
import { RIG_ID } from "../../../core/ids.ts";
import { addClusterRunner, addMachineRunner, rigReportsSettings } from "../../clusters/index.ts";
import { setRigSettings } from "../../rigs/index.ts";
import type { ControlStore } from "../../store/index.ts";
import type { RunnerPlaces } from "../../ui/rigs/runners.ts";
import { rigHref } from "../../ui/urls.ts";
import type { Dashboard } from "../context.ts";
import { type Place, placeOf, productAt, runnerGroups } from "./add-places.ts";

/**
 * A rig's runners that control sets up (goal 206): Add a rig's and Edit rig's chosen GPUs, each
 * set up and given to the rig, which its history says; and the route that adds one by its place.
 */

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

/**
 * What Edit rig shows of a rig's runners (goal 206): where each runner control set up is, and its
 * GPU; each free GPU it can add, as the form's value (its runner's name, then its place); and
 * whether the core judges on its runners alone. `names`: the runners the rig reports.
 */
export function runnerPlaces(store: ControlStore, rig: string, names: string[]): RunnerPlaces {
  const placed: RunnerPlaces["placed"] = {};
  for (const r of store.rigRunners.of(rig)) {
    if (r.status === "removed") continue;
    const at: Place =
      r.placement === "machine"
        ? { kind: "machine", machine: r.cluster, gpu: r.spec.gpuIndex }
        : {
            kind: "cluster",
            cluster: r.cluster,
            slot: r.namespace,
            node: r.spec.node,
            mode: r.spec.deviceClass ? `dra:${r.spec.deviceClass}` : "device-plugin",
          };
    const product = r.spec.gpus ? productAt(store, at) : "";
    const gpu = !r.spec.gpus
      ? "Its CPUs"
      : r.placement === "machine"
        ? `GPU ${r.spec.gpuIndex ?? 0} · ${product || "a GPU"}`
        : `${product || "A GPU"}${r.spec.deviceClass ? ` · DRA class ${r.spec.deviceClass}` : r.spec.node ? ` on ${r.spec.node}` : ""}`;
    placed[r.runner] = {
      where:
        r.placement === "machine" ? `${r.cluster} · over SSH` : `${r.cluster} › ${r.namespace}`,
      gpu,
      product,
    };
  }
  const add = runnerGroups(store, rig, names).flatMap((g) =>
    g.gpus
      .filter((x) => !x.used)
      .map((x) => ({
        value: `${x.runner}=${x.at}`,
        text: `${g.name} · ${x.label} · ${g.where}`,
        product: x.product,
      })),
  );
  const judgeOnRunners = Boolean(
    store.clusters.rig(rig)?.spec.judgeOnRunners ?? store.machines.rig(rig)?.judge_on_runners,
  );
  return { placed, add, judgeOnRunners };
}

/**
 * The runners Edit rig adds (goal 206): each one Add put in the list (`runner_new__<n>`: its
 * name, `=`, its place; with `runner_new_pool__<n>`), and one chosen in Add a runner and not put
 * there, with its pool. Each name once.
 */
export function runnersAdded(f: Record<string, unknown>): ReturnType<typeof addRigRunnersChosen> {
  const one = (k: string) => {
    const v = f[k];
    return String(Array.isArray(v) ? v[0] : (v ?? "")).trim();
  };
  const asked = Object.keys(f)
    .filter((k) => /^runner_new__\d+$/.test(k))
    .map((k) => [one(k), one(k.replace("runner_new__", "runner_new_pool__"))] as const);
  if (one("add_at")) asked.push([one("add_at"), one("add_pool") || "shared"]);
  const out: ReturnType<typeof addRigRunnersChosen> = [];
  for (const [value, pool] of asked) {
    const cut = value.indexOf("=");
    const runner = value.slice(0, cut);
    if (cut < 1 || !RIG_ID.test(runner) || out.some((r) => r.runner === runner)) continue;
    const at = placeOf(value.slice(cut + 1));
    out.push({
      runner,
      at,
      gpus: 1,
      mode: (at.kind === "cluster" ? at.mode : undefined) ?? "device-plugin",
      pool,
    });
  }
  return out;
}
