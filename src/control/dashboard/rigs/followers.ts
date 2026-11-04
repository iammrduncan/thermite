import { RIG_ID } from "../../../core/ids.ts";
import type { ClusterFacts } from "../../clusters/index.ts";
import { infoLabel } from "../../ui/campaigns/new/index.ts";
import { esc } from "../../ui/components/index.ts";

/**
 * Add a rig's More machines for a cluster (goal 205, from the owner's mockup): the other ready
 * nodes of the cluster, each of which can follow the rig's own node, with how many of its GPUs
 * are the judge's and how many the workers' (with none, whose its CPUs are), their DRA device
 * class when it is not the rig's, its CPUs, memory and volume; and the pool of the leader's own
 * GPUs.
 * A node whose name is no rig's name can't be a follower, and is left out.
 */
export function followerChoices(cluster: string, f: ClusterFacts): string {
  const nodes = f.nodes.filter((n) => n.ready && RIG_ID.test(n.name));
  if (nodes.length < 2) return "";
  const kn = esc(cluster);
  const opt = (v: string, text: string, on = false) =>
    `<option value="${esc(v)}"${on ? " selected" : ""}>${esc(text)}</option>`;
  const rows = nodes
    .map((n) => {
      const nn = esc(n.name);
      const most = Math.max(1, Math.min(8, n.gpus || 8));
      const what = [n.gpus ? `${n.gpus} GPU${n.gpus === 1 ? "" : "s"}` : "", n.arch ?? ""]
        .filter(Boolean)
        .join(", ");
      return `<label class="ch"><input type="checkbox" name="k_follow__${kn}" value="${nn}" style="margin:2px 8px 0 0"><span><b>${nn}</b>${what ? ` <span class="muted small">${esc(what)}</span>` : ""}</span></label>
<div class="g3" data-follow-for="${kn}:${nn}" hidden>
<label class="fd">${infoLabel("GPUs for the judge", "How many of this node's GPUs the judge measures on.")}<select name="k_fgpus__${kn}__${nn}">${Array.from({ length: most + 1 }, (_, i) => opt(String(i), String(i), i === 1)).join("")}</select></label>
<label class="fd">${infoLabel("GPUs for the workers", "How many of this node's GPUs the lanes work on: their trials run on this node then, with their workspace and their own checks. A node with no GPU for the judge gives the workers one for now.")}<select name="k_fwork__${kn}__${nn}">${Array.from({ length: most + 1 }, (_, i) => opt(String(i), String(i))).join("")}</select></label>
<label class="fd">${infoLabel("With no GPU, its CPUs", "With no GPU for either here: the judge measures on this node's CPUs, or the lanes work there.")}<select name="k_fcpu__${kn}__${nn}">${opt("judge", "the judge's")}${opt("workers", "the workers'")}</select></label>
${
  f.device_classes.length
    ? `<label class="fd">${infoLabel("DRA device class", "When the rig's GPUs come through DRA and this node's GPU is in another device class than the rig's, such as a class for any GB10.")}<select name="k_fmode__${kn}__${nn}">${opt("", "the rig's")}${f.device_classes.map((d) => opt(`dra:${d}`, d)).join("")}</select></label>`
    : `<label class="fd">${infoLabel("DRA device class", "When the rig's GPUs come through DRA and this node's GPU is in another device class than the rig's: the class the cluster's operators named for it. Empty: the rig's.")}<input name="k_fclass__${kn}__${nn}" maxlength="253" placeholder="the rig's"></label>`
}
<label class="fd">${infoLabel("CPUs", "This node's share for the rig: its supervisor takes half a CPU, its harness the rest. Empty: the namespace's defaults.")}<input name="k_fcpus__${kn}__${nn}" inputmode="decimal" placeholder="the namespace's defaults"></label>
<label class="fd">${infoLabel("Memory (GiB)", "This node's share for the rig: its supervisor takes 2 GiB, its harness the rest. A DGX Spark's GPU uses the same memory, so a model the judge loads counts here. Empty: the namespace's defaults.")}<input name="k_fmem__${kn}__${nn}" inputmode="decimal" placeholder="the namespace's defaults"></label>
<label class="fd">${infoLabel("Volume size (GB)", "This node's own volume: its builds, the kits and the model's files, which it fetches once.")}<input name="k_fsize__${kn}__${nn}" value="100"></label>
</div>`;
    })
    .join("");
  return `<div class="follow" style="margin-top:14px"><h3 style="font-size:14px;margin:0 0 4px">More machines</h3><p class="lead">The rig can run on more nodes of ${kn}. The node chosen above leads: it keeps the run's records and hands out the work. Each node you add here follows it, and its GPUs go to the judge or to the workers: the judge measures on the judge's, and the lanes work on the workers'.</p>
${leaderChoice(`k_lead__${kn}`, "node")}
<div class="stack" style="margin-top:10px">${rows}</div></div>`;
}

/** The leader's own GPUs' pool, as both kinds of More machines offer it (core/followers.ts). */
function leaderChoice(name: string, one: string): string {
  return `<label class="fd" style="max-width:420px">${infoLabel(
    "The leader's own GPUs",
    `With followers: shared by the judge and the workers, as on a rig of one ${one}; the workers' only, so the judge measures on the followers' GPUs alone and the lanes' own runs never wait for it; or the judge's only, so the lanes work on the followers' GPUs and nothing but the judge runs beside its measurements.`,
  )}<select name="${name}"><option value="shared">the judge's and the workers'</option><option value="workers">the workers' only: the judge measures on the followers'</option><option value="judge">the judge's only: the lanes work on the followers'</option></select></label>`;
}

/**
 * Add a rig's More machines for a machine over SSH (goal 205, from the owner's mockup): the other
 * ready machines, each of which can follow the rig, with what each free GPU there is for: the
 * judge, the workers or nothing; with no GPU, whose its CPUs are. And the pool of the leader's
 * own GPUs.
 */
export function machineFollowerChoices(
  leader: string,
  others: { name: string; gpus: { index: number; name: string; used?: string | undefined }[] }[],
): string {
  if (!others.length) return "";
  const kn = esc(leader);
  const rows = others
    .map((o) => {
      const on = esc(o.name);
      const gpus = o.gpus
        .map(
          (g) =>
            `<label class="gr${g.used ? " used" : ""}"><span><b>GPU ${g.index}</b> · ${esc(g.name)}</span>${
              g.used
                ? `<span class="muted small">used by rig ${esc(g.used)}</span>`
                : `<select name="m_fgpu__${kn}__${on}__${g.index}" aria-label="What GPU ${g.index} of ${on} is for"><option value="">not used</option><option value="judge" selected>the judge's</option><option value="workers">the workers'</option></select>`
            }</label>`,
        )
        .join("");
      return `<label class="ch"><input type="checkbox" name="m_follow__${kn}" value="${on}" style="margin:2px 8px 0 0"><span><b>${on}</b> <span class="muted small">a machine over SSH</span></span></label>
<div data-follow-for="${kn}:${on}" hidden>${
        gpus
          ? `<div class="card flat">${gpus}</div>`
          : `<div class="card"><label class="fd" style="max-width:420px">${infoLabel("Its CPUs", "This machine has no NVIDIA GPU: the judge measures on its CPUs, or the lanes work there.")}<select name="m_fcpu__${kn}__${on}"><option value="judge">the judge's</option><option value="workers">the workers'</option></select></label></div>`
      }</div>`;
    })
    .join("");
  return `<div class="follow" style="margin-top:14px"><h3 style="font-size:14px;margin:0 0 4px">More machines</h3><p class="lead">The rig can run on more machines. This one leads: it keeps the run's records and hands out the work. Each machine you add follows it, and each of its GPUs goes to the judge or to the workers: the judge measures on the judge's, and the lanes work on the workers'.</p>
${leaderChoice(`m_lead__${kn}`, "machine")}
<div class="stack" style="margin-top:10px">${rows}</div></div>`;
}
