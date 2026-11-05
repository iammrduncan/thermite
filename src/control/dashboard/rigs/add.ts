import type { Hono } from "hono";
import { errorText } from "../../../common/errors.ts";
import { MAX_LANES, RIG_ID_SENTENCE } from "../../../core/ids.ts";
import { inBackground } from "../../background.ts";
import { addClusterRig, leastRigSize, NS, SUPERVISOR_SHARE } from "../../clusters/index.ts";
import { newToken } from "../../credential.ts";
import type { JoinedSpec, JoinForm } from "../../join.ts";
import { deployScript, MAX_RIG_GPUS, type MachineFacts, tail } from "../../machines/index.ts";
import { awaitFirstReport, judgeShare, NO_RIG_BUS, rigBusOf, rigTaken } from "../../rigs/index.ts";
import {
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
import {
  coreNodeOptions,
  corePlaces,
  coreRows,
  firstPlace,
  machineNotReady,
  productAt,
  runnerGroups,
  runnerPicker,
} from "./add-places.ts";
import { addRigRunners, addRigRunnersChosen, giveWorkers, runnersAdded } from "./runners.ts";
import { rigHelpers } from "./shared.ts";

/**
 * Rigs › Add a rig (goal 206): a rig's core on a machine control reaches over SSH or on a
 * cluster, and its runners, each a GPU control knows in a pool; or a rig joined from a place
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
            judgeOnRunners: r.judge_on_runners,
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
    // The place to choose first: one from Settings › Machines' Add a rig here (goal 203).
    const wanted = c.req.query("place");
    const places = corePlaces(store);
    const groups = runnerGroups(store);
    const first = firstPlace(places, wanted);
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
    const size = first?.size;
    const clouds =
      store.gpuClouds
        .list()
        .map(
          (g) =>
            `<a class="ch" href="/ui/rigs/add/runpod?cloud=${encodeURIComponent(g.name)}"><span><b>${esc(g.name)} · RunPod</b><br><span class="muted small">Control starts a pod with Thermite's rig image, enrolls it and follows its price. RunPod bills it by the second while it runs. Opens Launch on RunPod.</span></span></a>`,
        )
        .join("") ||
      `<a class="ch" href="/ui/settings/machines?add=1#add-machine"><span><b>+ A RunPod account</b><br><span class="muted small">Add it under Settings › Machines with an API key that may start pods, then press Launch a rig on it.</span></span></a>`;
    return page(
      c,
      {
        title: "Add a rig",
        crumbs: [{ href: "/ui/rigs", text: "Rigs" }],
        active: "rigs",
      },
      `<p class="run-said">A rig is a core and its runners. The core keeps the run: its records, the planner, every lane's agent program and the judge's decisions. Each runner is one GPU, or a machine's CPUs, where the judge measures and the lanes try their changes. Machines are added and checked under <a href="/ui/settings/machines">Settings › Machines</a>.</p>
${error ? `<div class="card warn" style="margin-bottom:16px"><b class="bad">Not created.</b> ${esc(error)}</div>` : ""}${blocked ? `<div class="card warn" style="margin-bottom:16px">${esc(blocked)}</div>` : ""}
<form id="add-rig" method="post" action="/ui/rigs/add" autocomplete="off" data-img-cpu="${esc(images?.harness ?? "")}" data-img-cuda12="${esc(images?.harnessCuda ?? "")}" data-img-cuda13="${esc(images?.harnessCuda13 ?? "")}"><input type="hidden" name="csrf" value="${t}">
<div class="sec"><h2>1 · The core</h2><p class="lead">Any machine control knows. It needs no GPU: a CPU machine keeps every GPU free for runs.</p>
<div class="card flat" role="radiogroup" aria-label="Where the core runs">${places.length ? coreRows(places, wanted) : `<div class="empty">No machine or cluster yet. Add one under <a href="/ui/settings/machines?add=1#add-machine">Settings › Machines</a>.</div>`}</div>
<div class="g3" data-core-size${size ? "" : " hidden"} style="margin-top:12px">
<label class="fd">${infoLabel("CPUs", "The CPUs the core takes: its supervisor gets half a CPU, and the harness the rest, for the planner, the agents' programs and their builds. Filled in from the slot's quota when control can read it; empty: the namespace's defaults apply.")}<input name="core_cpus" inputmode="decimal" value="${esc(size?.cpus ?? "")}" placeholder="the namespace's defaults"></label>
<label class="fd">${infoLabel("Memory (GiB)", `The core's memory: the supervisor gets ${SUPERVISOR_SHARE.terminal.memoryGi} GiB, since a new rig's agent programs run in their own terminals, and the harness the rest, so at least ${leastRigSize("terminal").memoryGi} GiB. Filled in from the slot's quota when control can read it; empty: the namespace's defaults apply.`)}<input name="core_mem" inputmode="decimal" value="${esc(size?.memoryGi ?? "")}" placeholder="the namespace's defaults"></label>
<label class="fd">${infoLabel("Disk (GB)", "The core's volume: the run's records, every lane's workspace and the exports it sends.")}<input name="core_disk" inputmode="numeric" value="${esc(size?.diskGb ?? "100")}"></label>
<label class="fd">${infoLabel("Node", "The node the core runs on. Any lets Kubernetes choose; a slot whose rules take pods only on nodes they name needs one of those.")}<select name="core_node"><option value="">any node with room</option>${coreNodeOptions(store)}</select></label>
</div>
<p class="muted small" data-core-machine${first?.value.startsWith("machine:") ? "" : " hidden"} style="margin:10px 0 0">On a machine over SSH, the core takes the CPUs and memory it needs, and keeps its volume on the machine's disk.</p>
<p class="lead" style="margin-top:18px">Or run it yourself, where control can't connect:</p><div class="stack">${joinCards}</div>${joinSections}<div class="nc-does" id="gpu-note" hidden></div>
<p class="lead" style="margin-top:14px">Or launch it on a GPU you rent by the hour:</p><div class="stack">${clouds}</div></div>
<div class="sec" data-runners><div class="sec-head"><h2>2 · Runners <span class="muted small" id="ar-count">0 chosen</span></h2><a class="small" href="/ui/settings/machines?add=1#add-machine">+ A new machine (Settings › Machines)</a></div>
<p class="lead">Add a runner for each GPU the rig uses: its machine, its GPU and its pool. A runner takes one run at a time, so a measurement never shares its GPU.</p>
${runnerPicker(groups)}
<label class="fd" style="max-width:200px;margin-top:14px">${infoLabel("Workers at a time", `How many lanes work at once: 1 to ${MAX_LANES}. A lane's own runner serves only that lane.`)}<input name="lanes" type="number" min="1" max="${MAX_LANES}" value="2"></label></div>
<div class="sec"><h2>3 · Name and start</h2><div class="g3">
<label class="fd">${infoLabel("Rig name", "The rig's name in Thermite: 2 to 40 lowercase letters, digits and dashes, starting and ending with a letter or digit. It names the rig's runs, history and files, so it can't change later.")}<input name="rig" required maxlength="40" placeholder="spark-rig"></label>
<div class="fd" style="grid-column:span 2">${infoLabel("Images", "The core runs control's CPU harness image. The runners run its CUDA harness image for their GPUs, as control reads them: 13 for Blackwell and the DGX Spark's GB10 on arm64, 12 for Pascal to Hopper on amd64. They are set where control is deployed.")}<span class="small ar-img">${images ? `The core: <span class="mono" id="ar-core-img">${esc(images.harness)}</span> · runners: <span class="mono" id="ar-run-img">none chosen</span>` : "none configured"}</span></div>
<div class="fd" style="grid-column:span 3">${infoLabel("Message bus", "Where the rig's core and runners reach control's message bus, over TLS, for their reports, commands, live lines and config (THERMITE_NATS_PUBLIC_URL). Every machine and cluster they run on must reach this port, or the rig never reports, and is shown broken.")}<span class="mono small">${parts.rigBus ? esc(parts.rigBus.url) : "none: control can't set a rig up"}</span></div>
</div></div>
<section class="card ar-sum" aria-label="What this rig will be" aria-live="polite"><h2>What this rig will be</h2><ul id="add-sum"><li>Choose where the core runs and which GPUs are its runners.</li></ul><div id="ar-notes"></div></section>
<div class="act ar-end"><a class="btn" href="/ui/rigs">Cancel</a><button class="primary big" id="ar-create"${blocked ? " disabled" : ""}>Create the rig</button></div>
</form>
<script src="/ui/assets/add-rig.js" defer></script>`,
    );
  });
  /**
   * The runners Add a rig chose and its Workers at a time (goal 206), checked before anything is
   * set up: a core with no GPU of its own (`coreGpus`) needs a runner for its judge, once it has
   * any, and a rig's runners are of one kind, so its verdicts compare. Refused in words.
   */
  const runnersPlan = (f: Record<string, unknown>, coreGpus: number) => {
    // The rows of + Add a runner, and an older form's list of every GPU with its pool.
    const chosen = [...runnersAdded(f), ...addRigRunnersChosen(f)];
    const raw = String([f.lanes ?? ""].flat()[0] ?? "").trim();
    const lanes = raw ? Number(raw) : undefined;
    if (lanes !== undefined && !(Number.isInteger(lanes) && lanes >= 1 && lanes <= MAX_LANES))
      return `Workers at a time is a whole number from 1 to ${MAX_LANES}.`;
    const judged = chosen.some((r) => r.pool === "judge" || r.pool === "shared");
    if (chosen.length && !judged && !coreGpus)
      return "Give the judge a runner, its own or a shared one: the core has no GPU to measure on.";
    const kinds = [...new Set(chosen.map((r) => productAt(store, r.at)).filter(Boolean))];
    if (kinds.length > 1)
      return `The runners are of ${kinds.length === 2 ? "two" : kinds.length} kinds, ${kinds.slice(0, -1).join(", ")} and ${kinds.at(-1)}: a rig measures on one kind of target, so its verdicts compare. Use one kind, or make a rig for each.`;
    if (new Set(chosen.map((r) => r.runner)).size !== chosen.length)
      return "Name each runner once.";
    return { chosen, lanes, judgeOnRunners: judged && !coreGpus };
  };
  /** Sets up the runners a new rig chose and sends its Workers at a time; says what was refused. */
  const startRunners = async (
    c: Ctx,
    rig: string,
    placement: "machine" | "cluster",
    plan: Exclude<ReturnType<typeof runnersPlan>, string>,
  ) => {
    const refused = await addRigRunners(parts, rig, plan.chosen);
    if (plan.lanes !== undefined)
      void inBackground(
        store,
        placement,
        rig,
        "workers_given",
        giveWorkers(parts, rig, plan.lanes),
      );
    return c.redirect(
      `/ui/rigs/${encodeURIComponent(rig)}${refused ? `?error=${encodeURIComponent(`The rig is being set up, but a runner was not added: ${refused}`)}` : ""}`,
      303,
    );
  };
  app.post("/ui/rigs/add", async (c) => {
    const f = await c.req.parseBody({ all: true });
    const fail = (why: string) => c.redirect(`/ui/rigs/add?error=${encodeURIComponent(why)}`, 303);
    const rig = String(f.rig ?? "").trim();
    const place = String(f.place ?? (f.machine ? `machine:${String(f.machine)}` : ""));
    if (place.startsWith("cluster:")) return addClusterRigFrom(c, f, rig, place.slice(8), fail);
    if (place.startsWith("join:")) return addJoinedRigFrom(c, f, rig, place.slice(5), fail);
    const m = store.machines.get(place.startsWith("machine:") ? place.slice(8) : "");
    // The core's own GPUs: none from Add a rig, which makes each GPU a runner; an older form's
    // still count.
    const gpus = [f.gpus ?? []]
      .flat()
      .map((x) => Number(x))
      .sort((a, b) => a - b);
    const plan = runnersPlan(f, gpus.length);
    if (typeof plan === "string") return fail(plan);
    if (!parts.rigImages) return fail("Control has no rig images configured.");
    if (!parts.publicUrl) return fail("Control's address for rigs is not set.");
    if (!parts.rigBus) return fail(NO_RIG_BUS);
    if (!RIG_ID.test(rig)) return fail(RIG_ID_SENTENCE);
    if (rigTaken(parts, rig)) return fail(`There is a rig named ${rig} already.`);
    if (!m) return fail("Choose a machine.");
    const why = machineNotReady(m);
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
      judge_on_runners: plan.judgeOnRunners,
      created_by: "owner:ui",
    };
    store.machines.addRig(placed);
    store.rigHistory.add(rig, "enrolled", true);
    const r = store.machines.rig(rig) as MachineRig;
    void inBackground(store, "machine", rig, "deploy", deployRig(r, m, token.token));
    // Its runners (goal 206), which it takes once it reports.
    return startRunners(c, rig, "machine", plan);
  });
  const addClusterRigFrom = async (
    c: Ctx,
    f: Record<string, unknown>,
    rig: string,
    place: string,
    fail: (why: string) => Response,
  ) => {
    // cluster:<k>|<slot> for a slot, as Add a rig's rows send it; an older form sent the slot
    // and the core's size in fields named for the cluster, and its GPUs, which still count.
    const [name = "", slot] = place.split("|");
    const one = (key: string) => {
      const v = f[key] ?? f[`${key}__${name}`];
      return String(Array.isArray(v) ? v[0] : (v ?? "")).trim();
    };
    const num = (key: string, old: string) => {
      const v = one(key) || one(old);
      return v ? Number(v) : undefined;
    };
    const gpus = Number(one("k_gpus") || "0");
    const plan = runnersPlan(f, gpus);
    if (typeof plan === "string") return fail(plan);
    const r = await addClusterRig(
      parts,
      {
        rig,
        cluster: name,
        slot: slot || one("k_slot") || undefined,
        gpus,
        judgeGpus: one("k_judge") || undefined,
        mode: one("k_mode") || "device-plugin",
        deviceClass: one("k_class") || undefined,
        node: one("core_node") || one("k_node") || undefined,
        storageClass: one("k_storage") || undefined,
        // The CUDA harness the owner chose (goal 132), for a core with GPUs of its own.
        cuda: gpus > 0 ? (one("k_cuda") === "13" ? "13" : "12") : undefined,
        storageGi: num("core_disk", "k_size") ?? 100,
        cpus: num("core_cpus", "k_cpus"),
        memoryGi: num("core_mem", "k_mem"),
        judgeOnRunners: plan.judgeOnRunners,
      },
      "owner:ui",
    );
    if ("error" in r) return fail(r.error);
    return startRunners(c, r.rig, "cluster", plan);
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
