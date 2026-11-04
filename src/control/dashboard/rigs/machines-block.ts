import type { ControlStore } from "../../store/index.ts";
import { esc } from "../../ui/components/index.ts";

/**
 * A rig over several machines on its page (goal 205, from the owner's mockup): its leader, the node
 * that keeps the run and whose GPUs are the judge's and the workers' or the workers' only, and each
 * follower, its node, its GPUs (the judge's), its volume, and whether its supervisor has
 * registered its key on the bus, so it takes the leader's asks. A rig of one machine has none.
 */
export function machinesBlock(store: ControlStore, rig: string): string {
  const r = store.clusters.rig(rig);
  const followers = r?.spec.followers ?? [];
  if (!r || !followers.length) return "";
  const gpus = (n: number) => `${n} GPU${n === 1 ? "" : "s"}`;
  const leader = `<div class="ck"><span class="ck-main"><span><b>${esc(r.spec.node ?? "")}</b> <span class="chip info">leader</span></span><span class="ck-sum">keeps the run, plans and hands out the work · ${r.spec.gpus ? `${gpus(r.spec.gpus)}, ${r.spec.judgeHere === false ? "the workers'" : "the judge's and the workers'"}` : "no GPU"}</span></span></div>`;
  const rows = followers
    .map((f) => {
      const on = store.busKeys.machineKey(rig, f.machine) !== undefined;
      return `<div class="ck"><span class="ck-main"><span><b>${esc(f.node)}</b> <span class="chip">follower</span></span><span class="ck-sum${on ? "" : " bad"}">${gpus(f.gpus)}, the judge's · ${f.storageGi} GB volume · ${on ? "its supervisor is on the bus and takes the leader's asks" : "its supervisor has not registered on the bus yet"}</span></span></div>`;
    })
    .join("");
  return `<div class="block" data-part="machines"><div class="head"><h2>Machines</h2><span class="n">${followers.length + 1}</span></div><div class="card flat cks">${leader}${rows}</div></div>`;
}
