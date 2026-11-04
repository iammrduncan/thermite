import { RIG_ID } from "../../../core/ids.ts";
import type { ClusterFacts } from "../../clusters/index.ts";
import { infoLabel } from "../../ui/campaigns/new/index.ts";
import { esc } from "../../ui/components/index.ts";

/**
 * Add a rig's More machines for a cluster (goal 205, from the owner's mockup): the other ready
 * nodes of the cluster, each of which can follow the rig's own node, with the GPUs the judge
 * measures on there, their DRA device class when it is not the rig's, its CPUs, memory and
 * volume; and whether the leader's own GPUs are the judge's and the workers' or the workers' only.
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
<label class="fd">${infoLabel("GPUs for the judge", "How many of this node's GPUs the judge measures on. Every GPU of a follower is the judge's.")}<select name="k_fgpus__${kn}__${nn}">${Array.from({ length: most }, (_, i) => opt(String(i + 1), String(i + 1))).join("")}</select></label>
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
  return `<div class="follow" style="margin-top:14px"><h3 style="font-size:14px;margin:0 0 4px">More machines</h3><p class="lead">The rig can run on more nodes of ${kn}. The node chosen above leads: it keeps the run and its lanes work there. Each node you add here follows it, and the judge measures on its GPUs.</p>
<label class="fd" style="max-width:420px">${infoLabel("The leader's own GPUs", "With followers: shared by the judge and the workers, as on a rig of one node, or the workers' only, so the judge measures on the followers' GPUs alone and the lanes' own runs never wait for it.")}<select name="k_lead__${kn}">${opt("shared", "the judge's and the workers'")}${opt("workers", "the workers' only: the judge measures on the followers'")}</select></label>
<div class="stack" style="margin-top:10px">${rows}</div></div>`;
}
