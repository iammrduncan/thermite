import type { Hono } from "hono";
import { errorText } from "../../../common/errors.ts";
import { RIG_ID_SENTENCE } from "../../../core/ids.ts";
import { inBackground } from "../../background.ts";
import { addClusterRig, type ClusterFacts, clusterLine, NS } from "../../clusters/index.ts";
import { newToken } from "../../credential.ts";
import type { JoinedSpec, JoinForm } from "../../join.ts";
import {
  deployScript,
  factsLine,
  MAX_RIG_GPUS,
  type MachineFacts,
  tail,
} from "../../machines/index.ts";
import { awaitFirstReport, judgeShare, NO_RIG_BUS, rigBusOf, rigTaken } from "../../rigs/index.ts";
import {
  type Cluster,
  fingerprint,
  type JoinedRig,
  type Machine,
  type MachineRig,
  RIG_ID,
} from "../../store/index.ts";
import { infoLabel } from "../../ui/campaigns/new/index.ts";
import { esc } from "../../ui/components/index.ts";
import { ADD_RIG_JS } from "../../ui/rigs/add/client.ts";
import type { Ctx, Dashboard } from "../context.ts";
import { rigHelpers } from "./shared.ts";

/**
 * Rigs › Add a rig: on a machine control reaches over SSH, on a cluster, or joined from a place
 * control can't reach.
 */
export function addRigRoutes(app: Hono, dash: Dashboard): void {
  const { csrf, opts, page, parts, ssh, store } = dash;
  const { joinedPage, mintJoin } = rigHelpers(dash);

  // ---------------------------------------------------------------- rigs on machines
  // Rigs › Add a rig: control enrolls the rig, writes its files and Quadlet units over SSH, and
  // starts it (machines/deploy.ts). Every step is a setup event on the rig's page.
  /** GPUs of a machine that rigs control set up there use, by index. */
  const gpusInUse = (machine: string) =>
    new Map(
      store.machines
        .rigs(machine)
        .filter((r) => r.status !== "removed")
        .flatMap((r) => r.gpus.map((g) => [g, r.rig] as const)),
    );
  /** Why a machine can't take a rig now, or nothing. */
  const notReady = (m: Machine): string | undefined => {
    const f = m.facts as MachineFacts | null;
    if (!m.host_keys.length) return "its host key is not trusted yet";
    if (!f) return "it has not been checked yet";
    if (m.check_error) return `its last check failed: ${m.check_error}`;
    if (!f.podman) return "Podman is missing";
    if (!f.systemd) return "it has no systemd";
    if (!f.root && f.linger === false) return "lingering is off for its user";
    return undefined;
  };
  /** Sets a rig up on a machine, in the background: each step becomes a setup event. */
  const deployRig = async (
    r: MachineRig,
    m: Machine & { key_sealed: string },
    controlToken: string,
  ) => {
    const target = {
      address: m.address,
      port: m.port,
      user: m.user,
      privateKey: opts.secrets.open(m.key_sealed),
      hostKeys: m.host_keys,
    };
    try {
      const out = await ssh.sshScript(
        target,
        deployScript(
          {
            rig: r.rig,
            controlUrl: parts.publicUrl ?? "",
            images: r.images,
            gpus: r.gpus,
            judgeGpus: r.judge_gpus,
            root: r.root,
            controlPublicKey: parts.controlPublicKey,
            controlFingerprint: fingerprint(parts.controlPublicKey),
            bus: rigBusOf(parts),
          },
          { controlToken, harnessSupervisorToken: newToken().token },
        ),
        [],
        30 * 60_000,
      );
      if (out.code !== 0) throw new Error(tail(out.stderr) || `the deploy exited ${out.code}`);
      store.rigHistory.add(r.rig, "deployed", true);
      store.machines.setRigStatus(r.rig, "starting");
    } catch (err) {
      store.rigHistory.add(r.rig, "deploy", false, errorText(err));
      store.machines.setRigStatus(r.rig, "failed");
      return;
    }
    await awaitFirstReport(parts, r.rig, (s) => store.machines.setRigStatus(r.rig, s));
  };
  app.get("/ui/assets/add-rig.js", (c) =>
    c.body(ADD_RIG_JS, 200, {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "no-cache",
    }),
  );
  app.get("/ui/rigs/add", (c) => {
    const t = csrf(c);
    const error = c.req.query("error");
    const machines = store.machines.list();
    const cards = machines
      .map((m, i) => {
        const why = notReady(m);
        const f = m.facts as MachineFacts | null;
        const used = gpusInUse(m.name);
        const free = (f?.gpus ?? []).filter((g) => !used.has(g.index)).length;
        const rigsHere = store.machines.rigs(m.name).filter((r) => r.status !== "removed");
        const sub = why
          ? `Not ready: ${why}. Fix it under Settings › Providers.`
          : `${factsLine(f as MachineFacts)}${rigsHere.length ? ` · runs ${rigsHere.map((r) => r.rig).join(", ")}` : ""}${f?.gpus.length ? ` · ${free} GPU${free === 1 ? "" : "s"} free` : ""}`;
        return `<label class="ch${why ? " dis" : ""}"><input type="radio" name="place" value="machine:${esc(m.name)}"${why ? " disabled" : i === 0 ? " checked" : ""} style="margin:2px 8px 0 0"><span><b>${esc(m.name)} · a machine over SSH</b><br><span class="muted small">${esc(sub)}</span></span></label>`;
      })
      .join("");
    const gpuLists = machines
      .map((m) => {
        const f = m.facts as MachineFacts | null;
        const used = gpusInUse(m.name);
        const rows = (f?.gpus ?? [])
          .map((g) => {
            const by = used.get(g.index);
            return `<label class="gr${by ? " used" : ""}"><input type="checkbox" name="gpus" value="${g.index}"${by ? " disabled" : ""}><span><b>GPU ${g.index}</b> · ${esc(g.name)} ${Math.round(g.memory_mib / 1024)} GB</span><span class="muted small">${by ? `used by rig ${esc(by)}` : `free · ${g.busy_pct}% busy · ${g.used_mib} MiB in use`}</span></label>`;
          })
          .join("");
        return `<div data-place="machine:${esc(m.name)}" hidden>${rows ? `<div class="card flat">${rows}</div>` : `<div class="card"><div class="muted">This machine has no NVIDIA GPU: the rig measures on its CPUs.</div></div>`}</div>`;
      })
      .join("");
    // Clusters: how many GPUs and how, which node, which storage, and (for slots) which slot.
    const clusters = store.clusters.list();
    const clusterReady = (k: Cluster) => {
      const f = k.facts as ClusterFacts | null;
      if (!f) return "it has not been checked yet";
      if (k.check_error) return `its last check failed: ${k.check_error}`;
      if (k.placement === "created" && !f.can_create_namespaces)
        return "control may not create namespaces there";
      if (k.placement === "slot" && !f.slots.some((s) => s.usable && !s.used_by))
        return "it has no free slot";
      return undefined;
    };
    const clusterCards = clusters
      .map((k) => {
        const why = clusterReady(k);
        const f = k.facts as ClusterFacts | null;
        const sub = why
          ? `Not ready: ${why}. Check it under Settings › Providers.`
          : `${clusterLine(f as ClusterFacts)} · ${k.placement === "created" ? `rigs get namespace ${k.namespace_pattern}` : `${(f as ClusterFacts).slots.filter((s) => s.usable && !s.used_by).length} free slot(s)`}`;
        return `<label class="ch${why ? " dis" : ""}"><input type="radio" name="place" value="cluster:${esc(k.name)}"${why ? " disabled" : ""} style="margin:2px 8px 0 0"><span><b>${esc(k.name)} · Kubernetes</b><br><span class="muted small">${esc(sub)}</span></span></label>`;
      })
      .join("");
    const clusterSections = clusters
      .map((k) => {
        const f = (k.facts as ClusterFacts | null) ?? {
          version: "?",
          nodes: [],
          device_classes: [],
          storage_classes: [],
          can_create_namespaces: false,
          slots: [],
        };
        const kn = esc(k.name);
        // The free slots' quota fills in the rig's CPUs, memory and volume (the first free one's).
        const freeQuota = f.slots.find((x) => x.usable && !x.used_by)?.quota;
        // A slot's role usually can't list nodes or device classes: then the choices are offered
        // as asked, and the cluster's own rules decide.
        const restricted = !f.nodes.length;
        const plugin = restricted || f.nodes.some((n) => n.gpus > 0);
        const maxGpus = restricted
          ? 8
          : Math.min(
              MAX_RIG_GPUS,
              Math.max(0, ...f.nodes.map((n) => n.gpus), f.device_classes.length ? 8 : 0),
            );
        const opt = (v: string, text: string, on = false) =>
          `<option value="${esc(v)}"${on ? " selected" : ""}>${esc(text)}</option>`;
        const def = f.storage_classes.find((s) => s.default)?.name;
        return `<div data-place="cluster:${kn}" hidden><div class="g3">
<label class="fd">${infoLabel("GPUs", "How many GPUs the rig's harness pod asks for. One is shared by the judge and the agents; with more, you choose how many are the judge's and the rest are the agents'.")}<select name="k_gpus__${kn}">${Array.from({ length: maxGpus + 1 }, (_, n) => opt(String(n), n === 0 ? "none: the CPU" : String(n), n === Math.min(1, maxGpus))).join("")}</select></label>
<label class="fd" data-judge-for="k_gpus__${kn}" hidden>${infoLabel("GPUs for the judge", "How many of the rig's GPUs the judge measures on; the rest are the agents' for their own test runs. More judge GPUs check more changes at once; more agent GPUs let more lanes test at once. Default: half, rounded up.")}<input name="k_judge__${kn}" inputmode="numeric" maxlength="2" placeholder="half"></label>
<label class="fd">${infoLabel("GPUs through", "NVIDIA's device plugin (nvidia.com/gpu) or DRA (a device class), as the cluster offers them.")}<select name="k_mode__${kn}">${plugin ? opt("device-plugin", "NVIDIA's device plugin") : ""}${f.device_classes.map((d) => opt(`dra:${d}`, `DRA: ${d}`)).join("")}${restricted ? opt("dra", "DRA: a device class you name") : ""}${!plugin && !f.device_classes.length ? opt("device-plugin", "no GPUs offered") : ""}</select></label>
${restricted ? `<label class="fd">${infoLabel("DRA device class", "Only for DRA in a cluster whose classes control can't list: the device class the cluster's operators named, such as gpu.nvidia.com.")}<input name="k_class__${kn}" maxlength="253" placeholder="gpu.nvidia.com"></label>` : ""}
<label class="fd">${infoLabel("Node", "Any lets Kubernetes choose. A fixed node keeps the rig on a known machine, which keeps timings comparable between runs.")}<select name="k_node__${kn}">${opt("", "any node with room")}${f.nodes
          .filter((n) => n.ready)
          .map((n) =>
            opt(n.name, `${n.name}${n.gpus ? ` (${n.gpus} GPU${n.gpus === 1 ? "" : "s"})` : ""}`),
          )
          .join("")}</select></label>
<label class="fd">${infoLabel("Storage class", "The class for the rig's volume (its state, builds, inbox and outbox).")}<select name="k_storage__${kn}">${def ? "" : opt("", "the cluster's default")}${f.storage_classes.map((s) => opt(s.name, `${s.name}${s.default ? " (default)" : ""}`, s.name === def)).join("")}</select></label>
<label class="fd">${infoLabel("Volume size (GB)", "The rig's volume: builds and model files can be large.")}<input name="k_size__${kn}" value="${freeQuota?.storageGi !== undefined ? Math.floor(freeQuota.storageGi) : 100}"></label>
<label class="fd">${infoLabel("CPUs", "The rig's CPUs: the supervisor gets half a CPU, the harness the rest. Filled in from the slot's quota when control can read it; empty: the namespace's defaults apply.")}<input name="k_cpus__${kn}" inputmode="decimal" value="${freeQuota?.cpus ?? ""}" placeholder="the namespace's defaults"></label>
<label class="fd">${infoLabel("Memory (GiB)", "The rig's memory: the supervisor gets 2 GiB, the harness the rest. Filled in from the slot's quota when control can read it; empty: the namespace's defaults apply.")}<input name="k_mem__${kn}" inputmode="decimal" value="${freeQuota?.memoryGi !== undefined ? Math.floor(freeQuota.memoryGi) : ""}" placeholder="the namespace's defaults"></label>
${
  k.placement === "slot"
    ? `<label class="fd">${infoLabel("Slot", "One of the free slots the cluster's operators made for Thermite.")}<select name="k_slot__${kn}">${f.slots
        .filter((s) => s.usable && !s.used_by)
        .map((s) => opt(s.namespace, s.namespace))
        .join("")}</select></label>`
    : `<div class="fd">${infoLabel("Namespace", "Control creates it for this rig, with its own network rules.")}<span class="mono small">${esc(k.namespace_pattern)}</span></div>`
}
</div></div>`;
      })
      .join("");
    // Rigs you run yourself: one command where the rig goes, for places control can't reach.
    const joinCards = `<label class="ch"><input type="radio" name="place" value="join:machine" style="margin:2px 8px 0 0"><span><b>A machine you set it up on yourself</b><br><span class="muted small">For a machine control can't reach over SSH, such as one behind NAT. You run one command there; it fetches the rig's files from control and starts it. Control can't reach the machine afterwards, so you stop and remove it there too.</span></span></label>
<label class="ch"><input type="radio" name="place" value="join:namespace" style="margin:2px 8px 0 0"><span><b>A Kubernetes namespace you apply it to yourself</b><br><span class="muted small">For a cluster whose operators give Thermite no kubeconfig. You run one kubectl apply, with your own rights, in a namespace you have. Control holds no credential for the cluster.</span></span></label>`;
    const joinSections = `<div data-place="join:machine" hidden><div class="g3">
<label class="fd">${infoLabel("GPUs on the machine", "The numbers of the machine's NVIDIA GPUs the rig uses, as nvidia-smi lists them. Empty: none, the rig measures on the CPU. One GPU is shared by the judge and the agents; with more, the lowest-numbered are the judge's.")}<input name="j_gpus" maxlength="40" placeholder="empty, 0, or 0,1"></label>
<label class="fd">${infoLabel("GPUs for the judge", "With two or more GPUs: how many the judge measures on (the lowest-numbered); the rest are the agents'. Default: half, rounded up.")}<input name="j_judge" inputmode="numeric" maxlength="2" placeholder="half"></label>
</div></div>
<div data-place="join:namespace" hidden><div class="g3">
<label class="fd">${infoLabel("Namespace", "The namespace the rig goes in. It must exist, and you need rights there to create deployments, services, secrets, volume claims and network policies.")}<input name="j_namespace" maxlength="63" placeholder="thermite-rig-1"></label>
<label class="fd">${infoLabel("GPUs", "How many GPUs the rig's harness pod asks for. One is shared by the judge and the agents; with more, you choose how many are the judge's.")}<select name="j_k_gpus">${Array.from({ length: 9 }, (_, n) => `<option value="${n}"${n === 1 ? " selected" : ""}>${n === 0 ? "none: the CPU" : n}</option>`).join("")}</select></label>
<label class="fd">${infoLabel("GPUs for the judge", "With two or more GPUs: how many the judge measures on; the rest are the agents'. Default: half, rounded up.")}<input name="j_k_judge" inputmode="numeric" maxlength="2" placeholder="half"></label>
<label class="fd">${infoLabel("GPUs through", "NVIDIA's device plugin (nvidia.com/gpu) or DRA (a device class), as the cluster offers them.")}<select name="j_mode"><option value="device-plugin">NVIDIA's device plugin</option><option value="dra">DRA: a device class you name</option></select></label>
<label class="fd">${infoLabel("DRA device class", "Only for DRA: the device class the cluster offers, such as gpu.nvidia.com.")}<input name="j_class" maxlength="253" placeholder="gpu.nvidia.com"></label>
<label class="fd">${infoLabel("Storage class", "The class for the rig's volume (its state, builds, inbox and outbox). Empty: the cluster's default.")}<input name="j_storage" maxlength="63" placeholder="the cluster's default"></label>
<label class="fd">${infoLabel("Volume size (GB)", "The rig's volume: builds and model files can be large.")}<input name="j_size" value="100"></label>
</div></div>`;
    const images = parts.rigImages;
    const blocked = !images
      ? "Control has no rig images configured (THERMITE_RIG_HARNESS_IMAGE, THERMITE_RIG_SUPERVISOR_IMAGE), so it can't set rigs up yet."
      : !parts.publicUrl
        ? "Control's address for rigs is not set (THERMITE_CONTROL_PUBLIC_URL), so a rig would not know where to report."
        : !parts.rigBus
          ? NO_RIG_BUS
          : "";
    return page(
      c,
      {
        title: "Add a rig",
        crumbs: [{ href: "/ui/rigs", text: "Rigs" }],
        active: "rigs",
      },
      `<p class="run-said">Choose where the rig runs. On a machine or cluster control knows, control connects with the credentials you gave it once, writes the rig's files and services, starts it and looks after it: stop, start, restart, remove. Where control can't connect, you run one command it gives you.</p>
${error ? `<div class="card warn" style="margin-bottom:16px"><b class="bad">Not created.</b> ${esc(error)}</div>` : ""}${blocked ? `<div class="card warn" style="margin-bottom:16px">${esc(blocked)}</div>` : ""}
<form id="add-rig" method="post" action="/ui/rigs/add" autocomplete="off"><input type="hidden" name="csrf" value="${t}">
<div class="sec"><h2>1 · Where</h2><p class="lead">A machine or a cluster control knows. They are added, checked and prepared under <a href="/ui/settings">Settings › Providers</a>.</p>
<div class="stack">${cards}${clusterCards}${cards || clusterCards ? "" : `<div class="card"><div class="empty">No machine or cluster yet.</div></div>`}<a class="ch" href="/ui/settings"><span><b>+ A new machine or cluster</b><br><span class="muted small">A Linux machine control can reach with an SSH key, or a Kubernetes cluster through a kubeconfig. Add it in Providers, then come back.</span></span></a></div>
<p class="lead" style="margin-top:14px">Or run it yourself, where control can't connect:</p><div class="stack">${joinCards}</div>
<p class="lead" style="margin-top:14px">Or launch it on a GPU you rent by the hour:</p><div class="stack">${
        store.gpuClouds
          .list()
          .map(
            (g) =>
              `<a class="ch" href="/ui/rigs/add/runpod?cloud=${encodeURIComponent(g.name)}"><span><b>${esc(g.name)} · RunPod</b><br><span class="muted small">Control starts a pod with Thermite's rig image, enrolls it and follows its price. RunPod bills it by the second while it runs. Opens Launch on RunPod.</span></span></a>`,
          )
          .join("") ||
        `<a class="ch" href="/ui/settings"><span><b>+ A RunPod account</b><br><span class="muted small">Add it in Providers with an API key that may start pods, then come back to launch a rig on it.</span></span></a>`
      }</div></div>
<div class="sec"><h2>2 · GPUs and resources</h2><p class="lead">As control last read the place. One GPU is shared by the judge and the agents. With more, some are the judge's and the rest the agents': half each by default, and on a machine the lowest-numbered GPUs are the judge's.</p>${gpuLists}<label class="fd" id="judge-pick" hidden style="max-width:280px;margin-top:10px">${infoLabel("GPUs for the judge", "How many of the chosen GPUs the judge measures on: the lowest-numbered ones. The rest are the agents' for their own test runs. More judge GPUs check more changes at once; more agent GPUs let more lanes test at once. Default: half, rounded up.")}<input name="judge_gpus" inputmode="numeric" maxlength="2" placeholder="half"></label>${clusterSections}${joinSections}<div class="nc-does" id="gpu-note"></div></div>
<div class="sec"><h2>3 · Name and start</h2><div class="g3">
<label class="fd">${infoLabel("Rig name", "The rig's name in Thermite: 2 to 40 lowercase letters, digits and dashes, starting and ending with a letter or digit. It names the rig's runs, history and files, so it can't change later.")}<input name="rig" required maxlength="40" placeholder="gpu-box-1-a"></label>
<label class="fd" style="grid-column:span 2">${infoLabel("Images", "The Thermite images control deploys, as set where control is deployed. A GPU rig uses the CUDA harness image.")}<span class="mono small">${images ? `${esc(images.harness)}${images.harnessCuda ? `<br>${esc(images.harnessCuda)} (GPU rigs)` : ""}<br>${esc(images.supervisor)}` : "none configured"}</span></label>
<label class="fd" style="grid-column:span 3">${infoLabel("Message bus", "Where the rig's supervisor reaches control's message bus, over TLS, for its reports, commands, live lines and config (THERMITE_NATS_PUBLIC_URL). The machine or cluster must reach this port, or the rig never reports, and is shown broken.")}<span class="mono small">${parts.rigBus ? esc(parts.rigBus.url) : "none: control can't set a rig up"}</span></label>
</div>
<div class="card hl"><p class="sum" id="add-sum">Control will enroll the rig, write its files and services on the machine, start it, and wait for its first report.</p><div class="act"><button class="primary big"${blocked ? " disabled" : ""}>Create the rig</button></div></div></div>
</form>
<script src="/ui/assets/add-rig.js" defer></script>`,
    );
  });
  app.post("/ui/rigs/add", async (c) => {
    const f = await c.req.parseBody({ all: true });
    const fail = (why: string) => c.redirect(`/ui/rigs/add?error=${encodeURIComponent(why)}`, 303);
    const rig = String(f.rig ?? "").trim();
    const place = String(f.place ?? (f.machine ? `machine:${String(f.machine)}` : ""));
    if (place.startsWith("cluster:")) return addClusterRigFrom(c, f, rig, place.slice(8), fail);
    if (place.startsWith("join:")) return addJoinedRigFrom(c, f, rig, place.slice(5), fail);
    const m = store.machines.get(place.startsWith("machine:") ? place.slice(8) : "");
    const gpus = [f.gpus ?? []]
      .flat()
      .map((x) => Number(x))
      .sort((a, b) => a - b);
    if (!parts.rigImages) return fail("Control has no rig images configured.");
    if (!parts.publicUrl) return fail("Control's address for rigs is not set.");
    if (!parts.rigBus) return fail(NO_RIG_BUS);
    if (!RIG_ID.test(rig)) return fail(RIG_ID_SENTENCE);
    if (rigTaken(parts, rig)) return fail(`There is a rig named ${rig} already.`);
    if (!m) return fail("Choose a machine.");
    const why = notReady(m);
    if (why) return fail(`${m.name} is not ready: ${why}.`);
    const facts = m.facts as MachineFacts;
    const used = gpusInUse(m.name);
    for (const g of gpus) {
      if (!facts.gpus.some((x) => x.index === g)) return fail(`${m.name} has no GPU ${g}.`);
      if (used.has(g)) return fail(`GPU ${g} is used by rig ${used.get(g)}.`);
    }
    if (new Set(gpus).size !== gpus.length) return fail("Name each GPU once.");
    if (gpus.length > MAX_RIG_GPUS) return fail(`A rig takes at most ${MAX_RIG_GPUS} GPUs.`);
    const judge = judgeShare(String(f.judge_gpus ?? "").trim(), gpus.length);
    if (typeof judge === "string") return fail(judge);
    if (gpus.length && !(facts.nvidia_ctk && facts.cdi))
      return fail(`${m.name} needs NVIDIA's container toolkit first: install it under Providers.`);
    if (gpus.length && !parts.rigImages.harnessCuda)
      return fail(
        "Control has no CUDA harness image configured (THERMITE_RIG_HARNESS_CUDA_IMAGE).",
      );
    const images = {
      harness: gpus.length ? (parts.rigImages.harnessCuda as string) : parts.rigImages.harness,
      supervisor: parts.rigImages.supervisor,
    };
    const token = newToken();
    store.enrollments.enroll(rig, token.sha256, "owner:ui");
    const placed = {
      rig,
      machine: m.name,
      gpus,
      judge_gpus: judge,
      images,
      root: facts.root,
      created_by: "owner:ui",
    };
    store.machines.addRig(placed);
    store.rigHistory.add(rig, "enrolled", true);
    const r = store.machines.rig(rig) as MachineRig;
    void inBackground(store, "machine", rig, "deploy", deployRig(r, m, token.token));
    return c.redirect(`/ui/rigs/${encodeURIComponent(rig)}`, 303);
  });
  const addClusterRigFrom = async (
    c: Ctx,
    f: Record<string, unknown>,
    rig: string,
    name: string,
    fail: (why: string) => Response,
  ) => {
    const one = (key: string) => {
      const v = f[`${key}__${name}`];
      return String(Array.isArray(v) ? v[0] : (v ?? "")).trim();
    };
    const num = (key: string) => (one(key) ? Number(one(key)) : undefined);
    const r = await addClusterRig(
      parts,
      {
        rig,
        cluster: name,
        slot: one("k_slot") || undefined,
        gpus: Number(one("k_gpus") || "0"),
        judgeGpus: one("k_judge") || undefined,
        mode: one("k_mode") || "device-plugin",
        deviceClass: one("k_class") || undefined,
        node: one("k_node") || undefined,
        storageClass: one("k_storage") || undefined,
        storageGi: Number(one("k_size") || "100"),
        cpus: num("k_cpus"),
        memoryGi: num("k_mem"),
      },
      "owner:ui",
    );
    if ("error" in r) return fail(r.error);
    return c.redirect(`/ui/rigs/${encodeURIComponent(r.rig)}`, 303);
  };
  const DRA_CLASS = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/;
  /** Add a rig you join yourself: checks the choices, then shows its join command once. */
  const addJoinedRigFrom = (
    c: Ctx,
    f: Record<string, unknown>,
    rig: string,
    form: string,
    fail: (why: string) => Response,
  ) => {
    const one = (key: string) => {
      const v = f[key];
      return String(Array.isArray(v) ? v[0] : (v ?? "")).trim();
    };
    if (!parts.rigImages) return fail("Control has no rig images configured.");
    if (!parts.publicUrl) return fail("Control's address for rigs is not set.");
    if (!parts.rigBus) return fail(NO_RIG_BUS);
    if (!RIG_ID.test(rig)) return fail(RIG_ID_SENTENCE);
    if (rigTaken(parts, rig)) return fail(`There is a rig named ${rig} already.`);
    if (form !== "machine" && form !== "namespace") return fail("Choose where the rig runs.");
    const cuda = "Control has no CUDA harness image configured (THERMITE_RIG_HARNESS_CUDA_IMAGE).";
    const imagesFor = (gpu: boolean) => ({
      harness: gpu
        ? (parts.rigImages?.harnessCuda as string)
        : (parts.rigImages?.harness as string),
      supervisor: parts.rigImages?.supervisor as string,
    });
    let spec: JoinedSpec;
    if (form === "machine") {
      const raw = one("j_gpus");
      const gpus = raw
        ? raw
            .split(/[\s,]+/)
            .filter(Boolean)
            .map(Number)
        : [];
      if (gpus.some((g) => !Number.isInteger(g) || g < 0 || g > 63))
        return fail("GPUs are the machine's GPU numbers, as nvidia-smi lists them: 0, or 0,1.");
      if (new Set(gpus).size !== gpus.length) return fail("Name each GPU once.");
      if (gpus.length > MAX_RIG_GPUS) return fail(`A rig takes at most ${MAX_RIG_GPUS} GPUs.`);
      const judgeGpus = judgeShare(one("j_judge"), gpus.length);
      if (typeof judgeGpus === "string") return fail(judgeGpus);
      if (gpus.length && !parts.rigImages.harnessCuda) return fail(cuda);
      spec = { gpus: gpus.sort((a, b) => a - b), judgeGpus, images: imagesFor(gpus.length > 0) };
    } else {
      const namespace = one("j_namespace");
      if (!NS.test(namespace)) return fail("Name the namespace the rig goes in.");
      const gpus = Number(one("j_k_gpus") || "0");
      if (!Number.isInteger(gpus) || gpus < 0 || gpus > 8)
        return fail("A rig in a namespace takes from none to 8 GPUs.");
      const judgeGpus = judgeShare(one("j_k_judge"), gpus);
      if (typeof judgeGpus === "string") return fail(judgeGpus);
      const dra = one("j_mode") === "dra";
      const deviceClass = gpus && dra ? one("j_class") : undefined;
      if (gpus && dra && !DRA_CLASS.test(deviceClass ?? ""))
        return fail("Name the DRA device class, such as gpu.nvidia.com.");
      const storageClass = one("j_storage") || undefined;
      if (storageClass && !NS.test(storageClass)) return fail("That is not a storage class name.");
      const storageGi = Number(one("j_size") || "100");
      if (!Number.isInteger(storageGi) || storageGi < 1 || storageGi > 10_000)
        return fail("The volume size is a whole number of GB, from 1 to 10000.");
      if (gpus && !parts.rigImages.harnessCuda) return fail(cuda);
      spec = {
        gpus,
        judgeGpus,
        images: imagesFor(gpus > 0),
        namespace,
        gpuMode: deviceClass ? "dra" : "device-plugin",
        deviceClass,
        storageClass,
        storageGi,
      };
    }
    store.joinedRigs.add({ rig, form: form as JoinForm, spec, by: "owner:ui" });
    const token = mintJoin(rig);
    return joinedPage(c, store.joinedRigs.get(rig) as JoinedRig, "", token);
  };
}
