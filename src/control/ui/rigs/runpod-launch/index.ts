import type { RunpodFacts, RunpodGpu } from "../../../runpod/index.ts";
import { infoLabel } from "../../campaigns/new/index.ts";
import { ago, esc, icon } from "../../components/index.ts";

export { RUNPOD_LAUNCH_JS } from "./client.ts";

/**
 * Launch on RunPod (goal 022): the owner picks a GPU from RunPod's list with its price, a count,
 * a data center, the volume, the image, a spend limit and an idle stop, and a name. The price
 * follows every choice (runpod-launch/client.ts), and choices that cannot apply are hidden: GPU
 * types with no stock on Secure cloud, the judge's share for one GPU, your own image's name while
 * control's image is chosen. Without the script the form still works: the server checks it all.
 */

/** A RunPod account in Providers, as the launch page needs it. */
export interface LaunchCloud {
  name: string;
  key_hint: string;
  facts: RunpodFacts | null;
  checked_at: string | null;
  error: string | null;
}

/** What the form had, to fill it in again after a refusal. */
export type LaunchForm = Partial<
  Record<
    | "cloud"
    | "gpu"
    | "gpu_count"
    | "judge_gpus"
    | "datacenter"
    | "volume_gb"
    | "image_choice"
    | "image"
    | "spend_limit_usd"
    | "idle_stop_minutes"
    | "rig",
    string
  >
>;

/** The GPU types a launch can use: on Secure cloud, with a price, and in stock. */
export function launchableGpus(f: RunpodFacts | null): RunpodGpu[] {
  return (f?.gpus ?? [])
    .filter((g) => g.secure && g.price_secure !== null && g.availability !== "NONE")
    .sort((a, b) => (a.price_secure ?? 0) - (b.price_secure ?? 0) || a.name.localeCompare(b.name));
}

const STOCK: Record<string, [string, string]> = {
  HIGH: ["ok", "high"],
  MEDIUM: ["", "medium"],
  LOW: ["warn", "low"],
};

const money = (n: number) => `$${n.toFixed(2)}`;

export function launchBody(o: {
  clouds: LaunchCloud[];
  cloud: LaunchCloud;
  /** Control's THERMITE_RUNPOD_RIG_IMAGE; none: the owner names one. */
  image: string | undefined;
  /**
   * The idle stop the form fills in when it opens (null: none). After a refusal the form keeps
   * what the owner typed, an empty field too.
   */
  idleFill: number | null;
  minIdle: number;
  volumeGb: number;
  csrf: string;
  now: number;
  form: LaunchForm;
  error?: string | undefined;
}): string {
  const { cloud: g, form: f } = o;
  const facts = g.facts;
  const gpus = launchableGpus(facts);
  const hidden = (facts?.gpus.length ?? 0) - gpus.length;
  const pick = gpus.find((x) => x.id === f.gpu) ?? gpus[0];
  const count = Math.min(8, Math.max(1, Number(f.gpu_count ?? "1") || 1));
  const price = pick ? (pick.price_secure ?? 0) * count : 0;
  const own = f.image_choice === "own" || !o.image;
  const running = facts?.pods.filter((p) => p.cost_per_hr > 0) ?? [];
  const idle = f.idle_stop_minutes ?? (o.idleFill === null ? "" : String(o.idleFill));
  const cloudLine = `<div class="card" style="margin-bottom:18px;display:flex;gap:10px;align-items:center;flex-wrap:wrap"><span class="kind g">GPU cloud</span>${
    o.clouds.length > 1
      ? `<form method="get" action="/ui/rigs/add/runpod" class="inline"><select name="cloud" aria-label="RunPod account" data-submit-on-change>${o.clouds.map((c) => `<option value="${esc(c.name)}"${c.name === g.name ? " selected" : ""}>${esc(c.name)}</option>`).join("")}</select> <button class="sm">Use this account</button></form>`
      : `<b>${esc(g.name)}</b>`
  }<span class="chip">key ${esc(g.key_hint)}</span><span class="muted small">${running.length ? `${running.length} pod${running.length === 1 ? "" : "s"} running at ${money(running.reduce((t, p) => t + p.cost_per_hr, 0))}/h · ` : ""}${g.checked_at ? `prices and stock read ${esc(ago(g.checked_at, o.now))} ago` : "not read yet"}</span><span class="grow"></span><form method="post" action="/ui/rigs/add/runpod" class="inline"><input type="hidden" name="csrf" value="${esc(o.csrf)}"><input type="hidden" name="cloud" value="${esc(g.name)}"><input type="hidden" name="read" value="1"><button class="sm">Read again</button></form></div>${g.error ? `<div class="card warn" style="margin-bottom:16px"><b class="bad">Control could not read the account:</b> ${esc(g.error)}${facts ? " The form shows the last read." : ""}</div>` : ""}`;
  const table = gpus.length
    ? `<div class="card flat" id="gtable" role="radiogroup" aria-label="GPU"><div class="gtab hd"><span></span><span>GPU</span><span>Memory</span><span class="num">Per GPU, an hour</span><span>Stock</span></div>${gpus
        .map((x) => {
          const [tone, word] = STOCK[x.availability ?? ""] ?? ["", "unknown"];
          const on = x.id === pick?.id;
          return `<label class="gtab${on ? " on" : ""}" data-price="${x.price_secure}" data-name="${esc(x.name)}" data-mem="${x.memory_gb}"><input type="radio" name="gpu" value="${esc(x.id)}"${on ? " checked" : ""}><span><b>${esc(x.name)}</b></span><span>${x.memory_gb} GB</span><span class="num">${money(x.price_secure ?? 0)}</span><span><span class="chip ${tone}">${esc(word)}</span></span></label>`;
        })
        .join(
          "",
        )}</div>${hidden > 0 ? `<div class="muted small" style="margin-top:6px">${hidden} GPU type${hidden === 1 ? " is" : "s are"} hidden: not on Secure cloud, or none in stock there now.</div>` : ""}`
    : `<div class="card"><div class="empty">${facts ? "RunPod has no GPU type in stock on Secure cloud now. Press Read again later." : "Control has not read this account yet. Press Read again."}</div></div>`;
  const dcs = facts?.datacenters ?? [];
  const body = `<p class="run-said">Control starts a pod on RunPod with Thermite's rig image. Control enrolls the pod with a one-time code, and the rig shows under Rigs with its price. RunPod bills a pod by the second while it runs. A stopped pod costs only its volume.</p>
${o.error ? `<div class="card warn" style="margin-bottom:16px"><b class="bad">Not launched.</b> ${esc(o.error)}</div>` : ""}${cloudLine}
<form id="rp" method="post" action="/ui/rigs/add/runpod" autocomplete="off" data-min-idle="${o.minIdle}"><input type="hidden" name="csrf" value="${esc(o.csrf)}"><input type="hidden" name="cloud" value="${esc(g.name)}">
<div class="sec"><h2>1 · GPU</h2><p class="lead">From RunPod's list, with its price for each GPU per hour on Secure cloud. Types with no stock there are hidden.</p>
${table}
<div class="g3" style="margin-top:14px">
<label class="fd">${infoLabel("How many GPUs", "GPUs in this one pod, 1 to 8. They share its CPUs, memory and volume. RunPod refuses the launch when it has fewer free.")}<select name="gpu_count" id="cnt">${[1, 2, 3, 4, 5, 6, 7, 8].map((n) => `<option value="${n}"${n === count ? " selected" : ""}>${n}${pick ? ` × ${esc(pick.name)}` : ""}</option>`).join("")}</select></label>
<label class="fd" id="judge-f"${count < 2 ? " hidden" : ""}>${infoLabel("GPUs for the judge", "How many of the pod's GPUs the judge measures on: the lowest-numbered ones. The rest are the agents' for their own test runs. Empty: half, rounded up.")}<input name="judge_gpus" id="judge" inputmode="numeric" placeholder="half" value="${esc(f.judge_gpus ?? "")}"></label>
</div><div class="nc-does" id="split">${count < 2 ? "<b>One GPU.</b> The judge and the agents share it. While the judge measures, the agents' own test runs wait, so its timings stay clean." : `<b>${count} GPUs.</b> The judge measures on the first ones, the agents test on the rest.`}</div></div>
<div class="sec"><h2>2 · Where</h2><div class="g3">
<div class="fd">${infoLabel("Cloud", "Secure cloud runs in RunPod's own data centers, on demand: the pod keeps its machine, and timings stay steady, which the judge needs. Community cloud and spot pods come in a later version.")}<div class="ch on" style="margin:0;cursor:default"><span class="dotx"></span><span><b>Secure cloud, on demand</b><span class="muted">RunPod's own data centers. Steady timings.</span></span></div><span class="muted small">Community cloud and spot pods come later.</span></div>
<label class="fd">${infoLabel("Data center", "Where the pod runs. Any: RunPod picks one with the GPU free.")}<select name="datacenter" id="dc"><option value="">Any data center</option>${dcs.map((d) => `<option value="${esc(d.id)}"${d.id === f.datacenter ? " selected" : ""}>${esc(d.id)}${d.name && d.name !== d.id ? ` · ${esc(d.name)}` : ""}</option>`).join("")}</select></label>
</div></div>
<div class="sec"><h2>3 · Storage</h2><div class="g3">
<div class="fd">${infoLabel("Storage", "Where the rig keeps a snapshot of its state, builds and model files among it: a volume of the pod, mounted at /workspace. The rig works on the pod's own disk, which RunPod empties when the pod stops; the snapshot brings its state back at the next start. The volume stays while the pod is stopped, and goes when the pod is terminated.")}<div class="small" style="padding-top:8px">A pod volume, kept while the pod is stopped and deleted with it.</div></div>
<label class="fd">${infoLabel("Volume size (GB)", "The pod volume's size, 10 to 10000 GB. RunPod bills it by the GB, while the pod runs and while it is stopped.")}<input name="volume_gb" id="gb" inputmode="numeric" value="${esc(f.volume_gb ?? String(o.volumeGb))}"></label>
</div></div>
<div class="sec"><h2>4 · Image</h2><div class="g3">
<label class="fd" style="grid-column:span 2">${infoLabel("Image", "The rig's container image. Thermite's rig image has the harness and the supervisor in one container, for CUDA. Your own image must be built on it, and RunPod must pull it without a login.")}<select name="image_choice" id="img">${o.image ? `<option value="control"${own ? "" : " selected"}>Thermite's rig image, as control names it: ${esc(o.image)}</option>` : ""}<option value="own"${own ? " selected" : ""}>Your own image, built on Thermite's</option></select></label>
<label class="fd" id="own-f"${own ? "" : " hidden"}>${infoLabel("Your image", "The image's full name and tag, at a registry RunPod can pull from without a login.")}<input name="image" id="own" placeholder="registry.example.com/you/thermite-rig:1" value="${esc(f.image ?? "")}"></label>
</div></div>
<div class="sec"><h2>5 · Spend, idle and name</h2><p class="lead">The spend limit is empty unless you fill it in.${o.idleFill === null ? " So is the idle stop." : ` The idle stop starts at ${o.idleFill} minutes. Change it, or clear it so that the pod never stops by itself.`} Control shows the spend on the rig's page either way.</p><div class="g3">
<label class="fd">${infoLabel("Spend limit (USD)", "Control stops the pod when it has cost this much in total, since launch. A stopped pod still pays for its volume. Empty: no limit.")}<input name="spend_limit_usd" id="lim" inputmode="decimal" placeholder="none" value="${esc(f.spend_limit_usd ?? "")}"></label>
<label class="fd">${infoLabel("Stop when idle for (minutes)", `Control stops the pod when no run has been at work on it for this long: no campaign runs, or every run is paused, blocked or finished. GPU billing then ends; the volume stays. Starting or resuming a run starts the pod again. ${o.minIdle} minutes or more. ${o.idleFill === null ? "" : `This form fills in ${o.idleFill} minutes. `}Empty: it never stops by itself. A launch over the REST API, MCP or the command line has no idle stop unless it names one.`)}<input name="idle_stop_minutes" id="idle" inputmode="numeric" placeholder="never" value="${esc(idle)}"></label>
<label class="fd">${infoLabel("Rig name", "The rig's name in Thermite: 2 to 40 lowercase letters, digits and dashes. It names the rig's runs, history and files, so it can't change later. Empty: control names it rp- and 8 letters or digits.")}<input name="rig" id="nm" placeholder="rp- and 8 characters" value="${esc(f.rig ?? "")}"></label>
</div></div>
<div class="card hl"><div style="display:flex;gap:18px;align-items:baseline;flex-wrap:wrap"><span class="price" id="price">${pick ? `${money(price)} an hour` : "–"}</span><span class="muted" id="price-s">${pick ? `for ${count} × ${esc(pick.name)} at RunPod's list price on Secure cloud. RunPod also bills the container disk and the volume by the GB.` : ""}</span></div><p class="sum" id="sum" style="margin-top:8px"></p>
<div class="act"><button class="primary big" id="go"${pick ? "" : " disabled"}>${pick ? `Launch · ${money(price)}/h` : "Launch"}</button><a class="btn" href="/ui/rigs/add">Cancel</a><span class="muted small">${icon.key} You are signed in as the owner. Only the owner can launch: control refuses a launch with any other token, over REST, MCP or the command line.</span></div>
<div class="nc-does"><b>What happens.</b> Control asks RunPod for the pod. It puts only what the pod needs to enroll in the pod's settings, which RunPod's console shows: the rig's name, a random path, a public key for what the pod sends to control, the SHA-256 of control's signing key (not the key) and a one-time enrollment code. The pod pulls the image (a few minutes), makes its own keys and checks its isolation. Control connects to it through RunPod's proxy, enrolls it with the code and pins its keys; the code is then spent. The rig shows under Rigs, and its page shows each step.</div></div>
</form>`;
  return body;
}
