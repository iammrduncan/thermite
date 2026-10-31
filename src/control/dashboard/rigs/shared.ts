import { judgeGpusByDefault } from "../../../core/hardware.ts";
import type { Progress } from "../../command-progress.ts";
import { newToken } from "../../credential.ts";
import { JOIN_HOURS, joinCommand, joinedCommands } from "../../join.ts";
import { controlImages, STEP_WORDS } from "../../rigs/index.ts";
import type { JoinedRig } from "../../store/index.ts";
import { ago, esc } from "../../ui/components/index.ts";
import { podRuns } from "../../ui/rigs/runpod.ts";
import type { RigPlace } from "../../ui/rigs/states.ts";
import type { Ctx, Dashboard } from "../context.ts";

/** How a rig's GPUs are used, in words: "2 for the judge, 2 for the agents", or shared. */
export const splitWords = (n: number, judge?: number | undefined) => {
  if (n < 2) return "shared by the judge and the agents";
  const j = judge ?? judgeGpusByDefault(n);
  return `${j} for the judge, ${n - j} for the agents`;
};
/** Which of a machine rig's GPUs are the judge's (the first ones) and which the agents'. */
export const gpuRoles = (gpus: number[], judge?: number | undefined) =>
  gpus
    .map((g, i) =>
      gpus.length < 2
        ? `GPU ${g} (shared)`
        : `GPU ${g} (${i < (judge ?? judgeGpusByDefault(gpus.length)) ? "judge" : "agents"})`,
    )
    .join(", ");
/**
 * A rig control set up, on a machine or a cluster, while a change to it is under way (goal 080):
 * its block follows the change's steps until it ends. Its buttons, but Remove, are sent by the
 * page's script (data-act).
 */
export const PLACE_BUSY = new Set(["deploying", "starting", "updating"]);
export const placeFollowUrl = (rig: string) => `/ui/rigs/${encodeURIComponent(rig)}/place.json`;
// For a place control can't connect to (join.ts): control mints a one-time join command; run
// there, it fetches the rig's files or manifest from /v1/join. Control keeps only its hash.
const hhmm = (ms: number) => new Date(ms).toISOString().slice(11, 16);
const JOIN_STATUS: Record<string, string> = {
  waiting: "waiting for you to run the join command",
  joining: "fetched its files; waiting for its first report",
  running: "running",
  failed: "no first report yet",
  retired: "retired",
};
export const updateFollowUrl = (rig: string) => `/ui/rigs/${encodeURIComponent(rig)}/update.json`;

/**
 * What the rigs' pages share: a rig's setup steps, the progress of a change to a rig control set
 * up, a joined rig's join command and block, where a rig runs, and its update's progress.
 */
export function rigHelpers(dash: Dashboard) {
  const { csrf, opts, page, parts, store, updates } = dash;
  const setupSteps = (rig: string) =>
    store.rigHistory
      .list(rig)
      .map(
        (e) =>
          `<div class="tl-row"><span class="muted small">${esc(ago(e.at, Date.now()))} ago</span><span class="${e.ok ? "ok" : "bad"}">${e.ok ? "✓" : "✕"}</span><span>${esc(STEP_WORDS[e.step] ?? e.step)}${e.detail ? ` <span class="muted small">· ${esc(e.detail)}</span>` : ""}</span></div>`,
      )
      .join("");
  const placeProgress = (rig: string): Progress => {
    const status = store.clusters.rig(rig)?.status ?? store.machines.rig(rig)?.status ?? "removed";
    return {
      state: `${status}:${store.rigHistory.list(rig).length}`,
      final: !PLACE_BUSY.has(status),
      said: "",
      tone: "",
    };
  };
  const mintJoin = (rig: string): string => {
    const t = newToken();
    const expires = Date.now() + JOIN_HOURS * 3_600_000;
    store.joinedRigs.setToken(rig, t.sha256, new Date(expires).toISOString(), "owner:ui");
    store.rigHistory.add(rig, "join_made", true, `works once, until ${hhmm(expires)} UTC`);
    return t.token;
  };
  /** A rig you join yourself: where, the join command, and the commands control can't run. */
  const joinedBlock = (r: JoinedRig, t: string, token?: string, reporting = false) => {
    const rName = encodeURIComponent(r.rig);
    const act = (action: string, label: string, extra = "", cls = "sm") =>
      `<form class="inline" method="post" action="/ui/rigs/${rName}/join/${action}"><input type="hidden" name="csrf" value="${t}">${extra}<button class="${cls}">${label}</button></form>`;
    const s = r.spec;
    const now = Date.now();
    const status =
      reporting && (r.status === "joining" || r.status === "failed") ? "running" : r.status;
    const expires = r.join_expires_at ? Date.parse(r.join_expires_at) : 0;
    const machine = r.form === "machine";
    const gpuList = machine ? (s.gpus as number[]) : [];
    const gpuCount = machine ? gpuList.length : (s.gpus as number);
    const gpus = machine
      ? gpuList.length
        ? gpuRoles(gpuList, s.judgeGpus)
        : "none: it measures on the CPU"
      : gpuCount
        ? `${gpuCount} through ${s.gpuMode === "dra" ? `DRA (${esc(s.deviceClass ?? "")})` : "NVIDIA's device plugin"}: ${splitWords(gpuCount, s.judgeGpus)}`
        : "none: it measures on the CPU";
    const cmd = token
      ? joinCommand(r.form, {
          controlUrl: parts.publicUrl ?? "",
          rig: r.rig,
          token,
          namespace: s.namespace,
        })
      : "";
    const joinCard =
      status === "retired"
        ? ""
        : token
          ? `<div class="card hl" style="margin-top:10px"><p class="sum">${machine ? "Run this on the machine, as the user the rig should run as. Root works too, but a user with rootless Podman is safer." : `Run this where kubectl reaches the cluster, with rights in the namespace ${esc(s.namespace)}.`}</p><pre class="json" style="white-space:pre-wrap;word-break:break-all">${esc(cmd)}</pre><div class="muted small">Shown once: copy it now. It works once, until ${hhmm(expires)} UTC. Control keeps only a hash of it, so it can't show it again; if you lose it, make a new one.</div></div>`
          : !r.join_used_at && expires > now
            ? `<div class="card" style="margin-top:10px"><div class="small">A join command waits, until ${hhmm(expires)} UTC. Control can't show it again.</div><div class="act" style="margin-top:8px">${act("new", "Make a new join command")}${act("revoke", "Revoke it")}</div></div>`
            : `<div class="card" style="margin-top:10px"><div class="small">${r.join_used_at ? `The join command was used ${esc(ago(r.join_used_at, now))} ago. To set the rig up again, remove it there first (below), then make a new one; its old token then stops working.` : r.join_expires_at ? "The join command expired unused." : "No join command waits."}</div><div class="act" style="margin-top:8px">${act("new", "Make a new join command")}</div></div>`;
    const needs = machine
      ? `<div class="small" style="margin-top:10px"><b>What the machine needs.</b> The command checks these first and writes nothing if one is missing.<ul style="margin:4px 0 0 18px"><li>Linux with systemd, and Podman 4.4 or later.</li><li>For a user: lingering on, so the rig's services outlive your login: <code>sudo loginctl enable-linger $USER</code>.</li>${gpuCount ? `<li>NVIDIA's container toolkit, with a CDI spec: <code>sudo nvidia-ctk cdi generate --output=/etc/cdi/nvidia.yaml</code>.</li>` : ""}<li>A way to control (${esc(parts.publicUrl ?? "")}) and to the image registry. Control never connects to the machine.</li></ul></div>`
      : `<div class="small" style="margin-top:10px"><b>What the namespace needs.</b><ul style="margin:4px 0 0 18px"><li>Your rights there to create deployments, services, secrets, volume claims and network policies${s.gpuMode === "dra" && gpuCount ? ", and resource claim templates" : ""}.</li><li>Its pods reach control (${esc(parts.publicUrl ?? "")}) and the image registry.</li></ul>The manifest has the rig's network rules: the harness reaches DNS and the internet, not the cluster, and only its supervisor reaches the harness.</div>`;
    const cmds = joinedCommands(r.form, r.rig, s);
    const pre = (label: string, text: string) =>
      `<div class="small" style="margin-top:8px">${label}</div><pre class="json" style="white-space:pre-wrap;word-break:break-all">${esc(text)}</pre>`;
    const yours =
      status === "waiting"
        ? ""
        : `<details style="margin-top:10px"><summary class="small">Stop, start, restart or remove it: you run these there</summary><div class="muted small" style="margin-top:6px">Control can't reach this place, so these are yours to run${machine ? `, as ${s.root ? "root" : "the user the rig runs as"}` : ""}. Remove deletes the rig's ${machine ? "units, files and volumes" : "objects in the namespace"}; results it has not exported are lost.</div>${pre("Stop", cmds.stop)}${pre("Start", cmds.start)}${pre("Restart", cmds.restart)}${pre("Remove", cmds.remove)}</details>`;
    const retire =
      status === "retired"
        ? ""
        : `<details style="margin-top:8px"><summary class="small">Retire it</summary><div class="small muted" style="margin:6px 0">Its token stops working at once, so it can't report or take commands, and any join command stops working. Its files stay there until you remove them with the command above.</div>${act("retire", "Retire the rig", `<input name="confirm" placeholder="type: retire ${esc(r.rig)}" style="margin-right:6px">`, "sm danger")}</details>`;
    return `<div class="block"><div class="head"><h2>You run it yourself</h2><span class="right">${esc(JOIN_STATUS[status] ?? status)}</span></div><div class="card"><dl class="facts"><dt>Where</dt><dd>${machine ? "a machine you set it up on" : `the namespace ${esc(s.namespace)}, applied by you`}</dd><dt>GPUs</dt><dd>${gpus}</dd>${machine ? "" : `<dt>Storage</dt><dd>${s.storageGi} GB${s.storageClass ? ` · ${esc(s.storageClass)}` : ""}</dd>`}<dt>Images</dt><dd class="mono small">${esc(s.images.harness)}<br>${esc(s.images.supervisor)}</dd></dl>${joinCard}
<div class="tl" style="margin-top:10px">${setupSteps(r.rig) || `<div class="muted small">No step yet.</div>`}</div>${status === "waiting" ? needs : ""}${yours}${retire}</div></div>`;
  };
  /** The page of a joined rig that has not reported yet. */
  const joinedPage = (c: Ctx, r: JoinedRig, flash: string, token?: string) =>
    page(
      c,
      {
        title: r.rig,
        crumbs: [{ href: "/ui/rigs", text: "Rigs" }],
        summary: `you run it yourself · ${esc(JOIN_STATUS[r.status] ?? r.status)}`,
        active: "rigs",
        // A page showing the join command never reloads itself: the command is shown once.
      },
      `<p class="run-said">${
        r.status === "retired"
          ? `${esc(r.rig)} is retired.`
          : r.join_used_at
            ? `${esc(r.rig)} fetched its files from control ${esc(ago(r.join_used_at, Date.now()))} ago. Its page fills in once it reports for the first time.`
            : `Run the join command ${r.form === "machine" ? "on the machine" : "against the cluster"}. It fetches the rig's ${r.form === "machine" ? "files and services" : "objects"} from control and starts it; the page fills in once the rig reports for the first time.`
      }</p>${flash}${joinedBlock(r, csrf(c), token)}`,
    );
  /** Where a rig runs, and what control can do there: update it, check it, restart it. */
  const placeOf = (rig: string): RigPlace => {
    const r = encodeURIComponent(rig);
    const m = store.machines.rig(rig);
    if (m && m.status !== "removed") {
      const known = store.machines.get(m.machine);
      const images = controlImages(parts, m.gpus.length);
      const noUpdate = !known
        ? `The machine ${m.machine} is no longer in Settings › Providers, so control can't reach it.`
        : typeof images === "string"
          ? images
          : !parts.publicUrl
            ? "Control's address for rigs is not set (THERMITE_CONTROL_PUBLIC_URL): the rig would no longer know where to report."
            : m.status === "deploying"
              ? `${rig} is still being set up.`
              : undefined;
      return {
        kind: "machine",
        words: `${m.machine}, a machine over SSH · Podman · systemd`,
        update: !noUpdate,
        noUpdate,
        check: Boolean(known),
        checkWhat: "its machine",
        restart: known ? `/ui/rigs/${r}/machine/restart` : null,
      };
    }
    const k = store.clusters.rig(rig);
    if (k && k.status !== "removed") {
      const known = store.clusters.get(k.cluster);
      const images = controlImages(parts, k.spec.gpus);
      const noUpdate = !known
        ? `The cluster ${k.cluster} is no longer in Settings › Providers, so control can't reach it.`
        : typeof images === "string"
          ? images
          : !parts.publicUrl
            ? "Control's address for rigs is not set (THERMITE_CONTROL_PUBLIC_URL): the rig would no longer know where to report."
            : k.status === "deploying"
              ? `${rig} is still being set up.`
              : undefined;
      return {
        kind: "cluster",
        words: `${k.cluster}, namespace ${k.namespace}`,
        update: !noUpdate,
        noUpdate,
        check: Boolean(known),
        checkWhat: "the cluster",
        restart: known ? `/ui/rigs/${r}/cluster/restart` : null,
      };
    }
    const pod = opts.runpodRigs?.view(rig);
    if (pod)
      return {
        kind: "runpod",
        words: `RunPod, pod ${pod.pod}${pod.datacenter ? ` in ${pod.datacenter}` : ""}`,
        update: false,
        check: false,
        checkWhat: "its pod",
        restart: pod.active && podRuns(pod) ? `/ui/rigs/${r}/runpod/restart` : null,
      };
    if (store.joinedRigs.get(rig))
      return {
        kind: "joined",
        words: "a place you set it up on yourself",
        update: false,
        check: false,
        checkWhat: "where it runs",
        restart: null,
      };
    return {
      kind: "other",
      words: "",
      update: false,
      check: false,
      checkWhat: "where it runs",
      restart: opts.driver ? `/ui/rigs/${r}/restart` : null,
    };
  };
  /**
   * How an update stands, for the page's script (goal 080): a new state with each step, so the
   * rig's page draws its steps as they come; final once it ended.
   */
  const updateProgress = (rig: string): Progress => {
    const waiting = updates.waiting(rig);
    const steps = store.rigHistory.list(rig);
    const from = steps.map((s) => s.step).lastIndexOf("update_started");
    const n = from < 0 ? 0 : steps.length - from;
    return { state: `${n}:${waiting ?? "ended"}`, final: !waiting, said: "", tone: "" };
  };
  return { joinedBlock, joinedPage, mintJoin, placeOf, placeProgress, setupSteps, updateProgress };
}
