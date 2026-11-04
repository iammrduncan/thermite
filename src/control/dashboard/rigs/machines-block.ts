import type { ControlStore } from "../../store/index.ts";
import { esc } from "../../ui/components/index.ts";

/**
 * A rig over several machines on its page (goal 205, from the owner's mockup): its leader, the
 * node or machine that keeps the run, and whose its GPUs are; each follower, its GPUs by pool
 * (with none, whose its CPUs are), and whether its supervisor has registered its key on the bus,
 * so it takes the leader's asks. A rig of one machine has none.
 */
export function machinesBlock(store: ControlStore, rig: string): string {
  const k = store.clusters.rig(rig);
  const m = store.machines.rig(rig);
  const plural = (n: number, what: string) => `${n} ${what}${n === 1 ? "" : "s"}`;
  // Each part as both kinds of place give it: where it is, its GPUs by pool, the follower's volume.
  const leaderOf = (judgeHere: boolean | undefined, lanesHere: boolean | undefined) =>
    judgeHere === false
      ? "the workers'"
      : lanesHere === false
        ? "the judge's"
        : "the judge's and the workers'";
  const leader = k?.spec.followers?.length
    ? {
        at: k.spec.node ?? "",
        gpus: k.spec.gpus,
        whose: leaderOf(k.spec.judgeHere, k.spec.lanesHere),
      }
    : m?.followers?.machines.length
      ? {
          at: m.machine,
          gpus: m.gpus.length,
          whose: leaderOf(m.followers.judgeHere, m.followers.lanesHere),
        }
      : undefined;
  if (!leader) return "";
  const followers = k?.spec.followers?.length
    ? k.spec.followers.map((f) => ({
        machine: f.machine,
        at: f.node,
        judge: f.gpus,
        workers: f.workers ?? 0,
        cpu: f.cpu,
        volume: ` · ${f.storageGi} GB volume`,
      }))
    : (m?.followers?.machines ?? []).map((f) => ({
        machine: f.machine,
        at: f.machine,
        judge: f.gpus.length,
        workers: f.workers?.length ?? 0,
        cpu: f.cpu,
        volume: "",
      }));
  const gpus = (n: number, whose: string) => (n ? `${plural(n, "GPU")}, ${whose}` : "no GPU");
  const pools = (f: (typeof followers)[number]) =>
    f.judge + f.workers
      ? [
          f.judge ? `${plural(f.judge, "GPU")} the judge's` : "",
          f.workers ? `${plural(f.workers, "GPU")} the workers'` : "",
        ]
          .filter(Boolean)
          .join(", ")
      : `its CPUs, ${f.cpu === "workers" ? "the workers'" : "the judge's"}`;
  const head = `<div class="ck"><span class="ck-main"><span><b>${esc(leader.at)}</b> <span class="chip info">leader</span></span><span class="ck-sum">keeps the run, plans and hands out the work · ${gpus(leader.gpus, leader.whose)}</span></span></div>`;
  const rows = followers
    .map((f) => {
      const on = store.busKeys.machineKey(rig, f.machine) !== undefined;
      return `<div class="ck"><span class="ck-main"><span><b>${esc(f.at)}</b> <span class="chip">follower</span></span><span class="ck-sum${on ? "" : " bad"}">${pools(f)}${f.volume} · ${on ? "its supervisor is on the bus and takes the leader's asks" : "its supervisor has not registered on the bus yet"}</span></span></div>`;
    })
    .join("");
  return `<div class="block" data-part="machines"><div class="head"><h2>Machines</h2><span class="n">${followers.length + 1}</span></div><div class="card flat cks">${head}${rows}</div></div>`;
}
