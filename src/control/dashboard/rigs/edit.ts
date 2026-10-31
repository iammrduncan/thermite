import type { Hono } from "hono";
import {
  COMPACT_AT_DEFAULT,
  COMPACT_AT_MAX,
  COMPACT_AT_MIN,
  compactAtRefusal,
} from "../../../core/compaction.ts";
import { MAX_LANES } from "../../../core/contract.ts";
import {
  PROGRAM_MODE_DEFAULT,
  PROGRAM_MODES,
  type ProgramMode,
  type RigSettingsChange,
} from "../../../core/rig-settings.ts";
import {
  asksNothing,
  type ClusterFacts,
  type ClusterResourcesRequest,
  leastRigSize,
  MODE_WORDS,
  prepareResize,
  SUPERVISOR_SHARE,
} from "../../clusters/index.ts";
import { issueCommand } from "../../issue/index.ts";
import { MAX_RIG_GPUS } from "../../machines/index.ts";
import { contextCapRefusal, isOpencodeOwn } from "../../providers/index.ts";
import {
  type AgentModelPlan,
  advisorsFileOf,
  applyAgentModel,
  checkAgentModel,
  clearRigModel,
  giveRigModel,
  neededHarness,
  opencodeOnly,
  PROGRAM_MODE_TIP,
  programModeField,
  QUIET_TIP,
  quietField,
  type RigPart,
  rigSettingsChange,
  SPLIT_RESTARTS,
  settingsCount,
} from "../../rigs/index.ts";
import {
  AGENT_ROLES,
  type AgentRole,
  type ClusterRig,
  codexTakes,
  EFFORTS,
  type Effort,
  HARNESSES,
  harnessOf,
  type ModelProvider,
} from "../../store/index.ts";
import { infoLabel } from "../../ui/campaigns/new/index.ts";
import { esc, hardwareLine } from "../../ui/components/index.ts";
import {
  type AgentLineId,
  type AgentLineNow,
  type AgentModelGroup,
  type AgentModelOption,
  agentsTable,
  EDIT_RIG_JS,
} from "../../ui/rigs/edit/index.ts";
import { listText } from "../../ui/words/index.ts";
import { programModeOf } from "../../views/index.ts";
import type { Dashboard } from "../context.ts";
import { modelPrefix } from "../settings/shared.ts";

/** Edit rig: its page and its form. */
export function editRigRoutes(app: Hono, dash: Dashboard): void {
  const { csrf, opts, page, parts, store, views } = dash;

  // ---------------------------------------------------------------- Edit rig
  // What runs on a rig and how, from its page: parts on or off, workers at once, limits, the
  // workers' model, the promotion policy. The harness parts go as one signed owner command
  // (rig_settings) with only what changed; the rig reports the settings it runs with.
  /** What the place of a rig control set up on a cluster allows it, as control last read it. */
  const clusterLimits = (r: ClusterRig): string => {
    const f = store.clusters.get(r.cluster)?.facts as ClusterFacts | null | undefined;
    const s = r.spec;
    const n = (x: number) => String(Math.round(x * 1000) / 1000);
    if (r.placement === "slot") {
      const q = f?.slots.find((x) => x.namespace === r.namespace)?.quota;
      const devices = s.deviceClass ? q?.devices?.[s.deviceClass] : undefined;
      const allows = [
        q?.cpus !== undefined ? `${n(q.cpus)} CPUs` : "",
        q?.memoryGi !== undefined ? `${n(q.memoryGi)} GiB of memory` : "",
        s.gpus === 0
          ? ""
          : s.gpuMode === "dra"
            ? devices !== undefined
              ? `${devices} device${devices === 1 ? "" : "s"} of the class ${s.deviceClass}`
              : ""
            : q?.gpus !== undefined
              ? `${q.gpus} GPU${q.gpus === 1 ? "" : "s"}`
              : "",
      ].filter(Boolean);
      return allows.length
        ? `The slot's quota allows ${listText(allows)}, as control last read it. Save reads it again first.`
        : "Control read no limit for this in the slot's quota: the cluster's own rules decide.";
    }
    if (s.gpus > 0 && s.gpuMode !== "dra" && f?.nodes.length) {
      const nodes = f.nodes.filter((x) => !s.node || x.name === s.node);
      const most = Math.max(0, ...nodes.map((x) => x.gpus));
      return `${s.node ? `The node ${s.node}` : "Its largest node"} offers ${most} GPU${most === 1 ? "" : "s"} through the device plugin, as control last read the cluster.`;
    }
    return "";
  };
  /**
   * Edit rig's fields for a rig control set up on a cluster (goal 118): its GPUs (a GPU rig only:
   * none and some don't mix), its CPUs and its memory, with what its place allows. Save changes
   * them as set_cluster_rig_resources does. The supervisor's share of the memory follows how the
   * rig's agent programs run (`mode`, goal 169). The field's least is the headless one, so that a
   * Save that also sets the rig headless can give it that; the server checks the mode's.
   */
  const clusterSizeFields = (r: ClusterRig, mode: ProgramMode): string => {
    if (r.status === "removed" || r.status === "deploying") return "";
    const s = r.spec;
    const way =
      s.gpuMode === "dra"
        ? `DRA, the device class ${s.deviceClass ?? ""}`
        : "NVIDIA's device plugin";
    const gpus = s.gpus
      ? `<label class="fd">${infoLabel("GPUs", `How many GPUs the rig's harness pod asks for, through ${way}: 1 to ${MAX_RIG_GPUS}. With two or more, some are the judge's and the rest the agents': half each, rounded up for the judge, unless you set GPUs for the judge below. A rig on GPUs can't move to none: add a rig on the CPU for that.`)}<input name="k_gpus" type="number" min="1" max="${MAX_RIG_GPUS}" step="1" value="${s.gpus}" data-label="its GPUs" data-moves></label>`
      : "";
    const limits = clusterLimits(r);
    const moves =
      "Its pods restart with the new GPUs, CPUs and memory, on the images it runs. A rig at work drains first: running trials and the judge's job finish, and it starts nothing new meanwhile. Its volume, tokens, runs and results stay.";
    return `<div class="g3" style="margin-top:10px" data-moves-say="${esc(moves)}">${gpus}
<label class="fd">${infoLabel("CPUs", "The rig's CPUs: the supervisor gets half a CPU, the harness the rest. At least 1.5. Empty, with Memory empty too: the namespace's defaults apply.")}<input name="k_cpus" type="number" min="1.5" step="any" value="${s.resources?.cpus ?? ""}" placeholder="the namespace's defaults" data-label="its CPUs" data-empty="the namespace's defaults" data-moves></label>
<label class="fd">${infoLabel("Memory (GiB)", memoryTip(mode))}<input name="k_mem" type="number" min="${leastRigSize("headless").memoryGi}" step="any" value="${s.resources?.memoryGi ?? ""}" placeholder="the namespace's defaults" data-label="its memory" data-unit=" GiB" data-empty="the namespace's defaults" data-moves></label>
</div><div class="muted small" style="margin-top:6px">${s.gpus ? "" : "It measures on the CPU: a rig on the CPU can't take GPUs, so add a rig with GPUs for that. "}${limits ? `${esc(limits)} ` : ""}A change here restarts its pods; a rig at work drains first.</div>`;
  };
  /** The Memory field's description: the supervisor's share for how the rig's agent programs run. */
  const memoryTip = (mode: ProgramMode): string => {
    const other: ProgramMode = mode === "terminal" ? "headless" : "terminal";
    return `The rig's memory: the supervisor gets ${SUPERVISOR_SHARE[mode].memoryGi} GiB while its agent programs run ${MODE_WORDS[mode]} (${SUPERVISOR_SHARE[other].memoryGi} GiB ${MODE_WORDS[other]}), the harness the rest. At least ${leastRigSize(mode).memoryGi} GiB. A new Agent programs run, under Advanced, moves the supervisor's share and restarts the pods too. Empty, with CPUs empty too: the namespace's defaults apply, and no share is set.`;
  };
  /** A model as a form's choice names it: "provider|model", each part URI-encoded. */
  const modelValue = (provider: string, model: string) =>
    `${encodeURIComponent(provider)}|${encodeURIComponent(model)}`;
  const PARTS: { id: RigPart; name: string; does: string; off: string }[] = [
    {
      id: "judge",
      name: "Judge",
      does: "It builds and measures each change that the agents submit, and it does the goal checks. Agents cannot change it.",
      off: "Changes wait in its queue. Nothing is measured, thus no change becomes the champion.",
    },
    {
      id: "workers",
      name: "Workers",
      does: "They change the code, one trial each, and submit each change to the judge.",
      off: "No new trial starts. A trial that runs at this time continues to its end.",
    },
    {
      id: "planner",
      name: "Planner",
      does: "It picks what each worker tries next.",
      off: "Lanes take queued experiments in order, by the fixed rules. Rules that name a direction still apply; free-word rules need the planner's model.",
    },
    {
      id: "teachers",
      name: "Teachers",
      does: "One or two models read recent trials and suggest next steps. Used only if the rig has them.",
      off: "The planner works without their suggestions.",
    },
    {
      id: "auditor",
      name: "Auditor",
      does: "It checks a win before it is kept, when the campaign asks for an audit. Used only if the rig has one.",
      off: "Audits wait for you in Needs you.",
    },
    {
      id: "review",
      name: "Review panel",
      does: "It scores goals that code can't measure. Used only if the rig has one.",
      off: "Those goals stay open: a goal that needs judgement is met only when the Review panel passes it and you accept it.",
    },
    {
      id: "exports",
      name: "Exports",
      does: "Every hour, the rig writes its results for the supervisor to send to the results repository, or to control when the rig has none.",
      off: "Results stay on the rig only. If the rig is lost, its results are lost.",
    },
  ];
  app.get("/ui/assets/edit-rig.js", (c) =>
    c.body(EDIT_RIG_JS, 200, {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "no-cache",
    }),
  );
  app.get("/ui/rigs/:rig/edit", (c) => {
    const vs = views();
    const u = vs.find((x) => x.id === c.req.param("rig"));
    if (!u)
      return page(
        c,
        { title: "Not found", active: "rigs" },
        `<div class="card"><div class="empty">No such rig.</div></div>`,
        vs,
      );
    const s = u.settings;
    const t = csrf(c);
    const rName = encodeURIComponent(u.id);
    const providers = store.modelProviders.list().filter((p) => p.models.length);
    const want = store.agentModels.byRig()[u.id];
    const sw = (p: (typeof PARTS)[number]) => `<div class="pt">
<label class="sw"><input type="checkbox" name="${p.id}" value="1" data-part data-name="${esc(p.name)}"${s?.[p.id] ? " checked" : ""}${s ? "" : " disabled"}><span class="knob"></span></label>
<div><div><b>${esc(p.name)}</b> <span class="pt-state ${s?.[p.id] ? "on" : "off"}">${s ? (s[p.id] ? "on" : "off") : "?"}</span></div><div class="muted small">${esc(p.does)}</div><div class="small pt-off"><b>When it is off:</b> ${esc(p.off)}</div>${p.id === "workers" ? `<label class="fd" style="max-width:220px;margin-top:8px">${infoLabel("Workers at a time", `How many agents work at the same time: 1 to ${MAX_LANES}. Each one uses its own CPUs, memory and disk, and the same model.`)}<input name="lanes" type="number" min="1" max="${MAX_LANES}" value="${s?.lanes ?? 1}"${s ? "" : " disabled"}></label>` : ""}</div></div>`;
    /** Where a provider's model runs: a subscription in Claude Code, OpenCode's own only in OpenCode. */
    const kindOf = (p: ModelProvider, model: string): AgentModelOption["kind"] =>
      p.type === "claude"
        ? "claude"
        : p.type === "chatgpt"
          ? "chatgpt"
          : opencodeOnly(p, model)
            ? "opencode"
            : "key";
    const groups: AgentModelGroup[] = providers.map((p) => ({
      label: `${p.name}${p.type === "claude" ? " (Claude subscription: runs in Claude Code)" : p.type === "chatgpt" ? " (ChatGPT subscription)" : isOpencodeOwn(p) && (p.type === "opencode" || !p.key_sealed) ? " (OpenCode's own free models: OpenCode only)" : ""}`,
      options: p.models.map((m) => ({
        value: modelValue(p.name, m.id),
        label: `${modelPrefix(p.type)}${m.id}`,
        provider: p.name,
        model: m.id,
        kind: kindOf(p, m.id),
        codex: codexTakes(p.type),
        window: m.context_window ?? 0,
      })),
    }));
    const roles = store.agentModels.byRole(u.id);
    const none: AgentLineNow = { picked: "", effort: null, harness: null, cap: null, at: null };
    const roleNow = (role: AgentRole): AgentLineNow => {
      const r = roles[role];
      if (!r) return none;
      const p = store.modelProviders.get(r.provider);
      return {
        picked: modelValue(r.provider, r.model),
        effort: r.effort,
        harness: r.harness ?? (p ? neededHarness(p, r.model) : "pi"),
        cap: r.contextCap ?? null,
        at: r.compactAt ?? null,
      };
    };
    const now = Object.fromEntries(AGENT_ROLES.map((r) => [r, roleNow(r)])) as Record<
      AgentLineId,
      AgentLineNow
    >;
    now.workers = want
      ? {
          picked: modelValue(want.provider, want.model),
          effort: want.effort ?? null,
          harness: want.harness,
          cap: want.contextCap ?? null,
          at: want.compactAt ?? null,
        }
      : { ...none, harness: u.model?.harness ?? "pi" };
    // The second teacher's lines: shown with a second teacher, or after "+ second teacher"; after
    // ×, shown emptied, so that Save removes them (goal 074).
    const second = c.req.query("teachers");
    const hasSecond = Boolean(roles.teachers && roles.second_teacher);
    if (second === "1")
      for (const r of ["second_teacher", "merged_by"] as const)
        if (now[r].picked) now[r] = { ...none, was: now[r].picked };
    const agents = agentsTable({
      groups,
      now,
      two: second === "2" || (second !== "1" && hasSecond),
      href: `/ui/rigs/${rName}/edit`,
      // What an agent with no model uses (goal 074): the rig's own model, as its harness reports
      // it, and its advisors file, as its supervisor reports it.
      defaults: {
        workers:
          u.model?.source === "environment"
            ? (u.model.model ?? undefined)
            : u.model?.source === "none"
              ? null
              : undefined,
        advisors: advisorsFileOf(u.supervisor),
      },
    });
    const placed = store.machines.rig(u.id) ?? store.clusters.rig(u.id);
    const where = placed
      ? "machine" in placed
        ? `The machine ${esc(placed.machine)}, set up by control. Stop, start or remove it from the rig's page.`
        : `The cluster ${esc(placed.cluster)}, namespace ${esc(placed.namespace)}, set up by control.`
      : "Set up outside control (for example by your own infrastructure tooling). Its GPUs and version change with a roll.";
    const mode = programModeOf(store, u.id);
    const sized = placed && !("machine" in placed) ? clusterSizeFields(placed, mode) : "";
    // On a rig set up on a cluster with its CPUs and memory set, a new mode restarts its pods.
    const modeMoves = !!placed && !("machine" in placed) && placed.spec.resources !== undefined;
    return page(
      c,
      {
        title: `Edit ${u.id}`,
        crumbs: [
          { href: "/ui/rigs", text: "Rigs" },
          { href: `/ui/rigs/${rName}`, text: u.id },
        ],
        active: "rigs",
      },
      `<p class="run-said">Change what ${esc(u.id)} runs. Control sends the change to the rig as a signed command, and the rig takes it in less than one minute. A part that you turn off keeps all its data.</p>
${s ? "" : `<div class="card warn" style="margin-bottom:16px">This rig's harness is older: it does not report its settings and cannot take them. They work after its next roll. The workers' model works at this time.</div>`}
<form id="edit-rig" method="post" action="/ui/rigs/${rName}/edit"><input type="hidden" name="csrf" value="${t}">
<div class="sec"><h2>1 · Parts of the rig</h2><div class="card flat">${PARTS.map(sw).join("")}
<div class="pt locked"><label class="sw"><input type="checkbox" checked disabled><span class="knob"></span></label><div><div><b>Supervisor</b> <span class="pt-state on">on</span></div><div class="muted small">It relays reports to control, fetches projects and kits, and does all git work for the rig.</div><div class="small pt-off"><b>Always on.</b> It connects the rig to control. Without it, control cannot see or steer the rig.</div></div></div></div></div>
<div class="sec" id="agents"><h2>2 · The agents</h2><p class="lead">Each agent runs in the harness you choose, with its own context. With no model here, the workers use the rig's own settings, the planner uses the workers' model, and the synthesizer and the final writer use the first teacher's. Another advisor uses the model in the rig's advisors file. If the file has none, that advisor is off.</p>
<div class="card">${agents}</div>
<div class="g3" style="margin-top:14px">
<label class="fd">${infoLabel("One trial lasts (minutes)", "How long a worker can work on one idea before it must submit, when the campaign sets no limit. Empty: no limit; a trial lasts until the worker submits or stops.")}<input name="trial_minutes" type="number" min="1" value="${s?.trial_minutes ?? ""}" placeholder="no limit"${s ? "" : " disabled"}></label>
<label class="fd">${infoLabel("Turns per trial", "How many model turns a worker can take in one trial. Empty: no limit.")}<input name="max_turns" type="number" min="1" value="${s?.max_turns ?? ""}" placeholder="no limit"${s ? "" : " disabled"}></label>
<label class="fd">${infoLabel("Ask me after a quiet spell of (minutes)", QUIET_TIP)}${quietField(u, s?.quiet_minutes ?? null)}</label>
</div>
<details class="adv"><summary>Advanced</summary><div class="g3"><label class="fd">${infoLabel("Agent programs run", PROGRAM_MODE_TIP)}${programModeField(u, s?.program_mode ?? PROGRAM_MODE_DEFAULT, modeMoves)}</label></div></details></div>
<div class="sec"><h2>3 · When a change becomes the champion</h2><div class="g2">
<label class="ch${s?.promotion === "auto" ? " on" : ""}"><input type="radio" name="promotion" value="auto"${s?.promotion === "auto" ? " checked" : ""}${s ? "" : " disabled"} style="margin:2px 8px 0 0"><span><b>Automatically</b><br><span class="muted small">The judge confirms the change on new runs, and it becomes the champion with no step of yours. When the campaign calls for an audit and this rig has an auditor, the auditor's clear comes first; its block stops the change. A run can still ask you about some changes (Ask me first, when you start it).</span></span></label>
<label class="ch${s?.promotion === "owner_approval" ? " on" : ""}"><input type="radio" name="promotion" value="owner_approval"${s?.promotion === "owner_approval" ? " checked" : ""}${s ? "" : " disabled"} style="margin:2px 8px 0 0"><span><b>Ask me for each change</b><br><span class="muted small">Each confirmed change waits for you in Needs you.</span></span></label>
</div><div class="muted small" style="margin-top:6px">A campaign can set its own rule when it starts; that rule comes first for its runs.</div></div>
<div class="sec"><h2>4 · Where it runs</h2><div class="card"><dl class="facts"><dt>Place</dt><dd>${where}</dd>${u.hardware ? `<dt>Hardware</dt><dd>${hardwareLine(u.hardware)}</dd>` : ""}</dl>${sized}${
        u.gpu_split && u.gpu_split.set >= 2
          ? `<label class="fd" style="max-width:260px;margin-top:10px" data-judge-field>${infoLabel("GPUs for the judge", `How many of the rig's ${u.gpu_split.set} GPUs the judge measures on; the rest are the agents' for their own test runs. More judge GPUs check more changes at once; more agent GPUs let more lanes test at once. A campaign started on this rig can set it too.${sized ? " With a new number of GPUs above, it is the judge's share of the new ones." : ""}`)}<input name="judge_gpus" type="number" min="1" max="${Math.min(8, u.gpu_split.set - 1)}" value="${u.gpu_split.judge}" data-restarts></label><div class="muted small" data-judge-now>Now: ${u.gpu_split.judge} for the judge, ${u.gpu_split.set - u.gpu_split.judge} for the agents. ${SPLIT_RESTARTS}</div>`
          : ""
      }</div></div>
<div class="card hl" style="margin-top:16px"><b>What changes when you save</b><ul class="chg" id="chg"><li>Nothing changes.</li></ul><div class="act"><button class="primary big" id="save">Save changes</button><a class="btn" href="/ui/rigs/${rName}">Cancel</a></div></div>
</form>
<script src="/ui/assets/edit-rig.js" defer></script>`,
      vs,
    );
  });
  app.post("/ui/rigs/:rig/edit", async (c) => {
    const rig = c.req.param("rig");
    const u = views().find((x) => x.id === rig);
    const back = (k: "ok" | "error", msg: string) =>
      c.redirect(`/ui/rigs/${encodeURIComponent(rig)}?${k}=${encodeURIComponent(msg)}`, 303);
    if (!u) return back("error", "No such rig.");
    const f = await c.req.parseBody();
    const said: string[] = [];
    const effortOf = (k: string): Effort | undefined =>
      EFFORTS.find((e) => e === String(f[k] ?? ""));
    // Every line is checked before anything is saved, and the settings before any model: a
    // refusal changes nothing.
    // A line's window or point as typed (goal 070): undefined without its field (a form without
    // it keeps what control has), null when empty, else the number; "" when it is not one.
    const typed = (k: string, pct: boolean): number | null | undefined | "" => {
      if (!(k in f)) return undefined;
      let t = String(f[k] ?? "")
        .trim()
        .replace(/[,_\s]/g, "");
      if (pct) t = t.replace(/%$/, "");
      if (!t) return null;
      return /^\d+$/.test(t) ? Number(t) : "";
    };
    /** The window its provider lists for a choice's model, in tokens (0: none). */
    const listedOf = (choice: string) => {
      const [pRaw, mRaw] = choice.split("|");
      try {
        const model = decodeURIComponent(mRaw ?? "");
        return (
          store.modelProviders
            .get(decodeURIComponent(pRaw ?? ""))
            ?.models.find((m) => m.id === model)?.context_window ?? 0
        );
      } catch {
        return 0;
      }
    };
    /**
     * A line's cap and point as the form gives them: the provider's own window is no cap, and 80%
     * no point of its own (the default), as the line's Context cell says; or why not, in words.
     */
    const contextOf = (
      id: AgentLineId,
      choice: string,
    ): { cap: number | null | undefined; at: number | null | undefined } | { error: string } => {
      const cap = typed(id === "workers" ? "context_workers" : `context_${id}`, false);
      const at = typed(id === "workers" ? "compact_workers" : `compact_${id}`, true);
      if (cap === "") return { error: "write the number of tokens in digits, such as 131072." };
      if (at === "")
        return {
          error: `the compaction point is a whole percent of the context window, from ${COMPACT_AT_MIN} to ${COMPACT_AT_MAX}.`,
        };
      return {
        cap: typeof cap === "number" && cap === listedOf(choice) ? null : cap,
        at: at === COMPACT_AT_DEFAULT ? null : at,
      };
    };
    /** Each line's name, as the page shows it, for its refusals. */
    const twoTeachers = String(f.role_second_teacher ?? "") !== "";
    const LINE: Record<AgentLineId, string> = {
      workers: "Workers",
      planner: "Planner",
      teachers: twoTeachers ? "Teacher 1" : "Teachers",
      second_teacher: "Teacher 2",
      merged_by: "Merged by",
      auditor: "Auditor",
      review_panel: "Review panel",
      synthesizer: "Synthesizer",
      final_writer: "Final writer",
    };
    const refuse = (id: AgentLineId, why: string) => back("error", `${LINE[id]}: ${why}`);

    // The other agents' lines (goals 070, 073 and 074): each one's model, effort, harness, window
    // and point. Only the lines the form has: a line it lacks keeps its model. The first teacher
    // with no model (the advisors file's) takes the second teacher and the merged by model with
    // it, as set_rig_model's clear does; a second teacher needs a first.
    const roles = store.agentModels.byRole(rig);
    const noTeachers = "role_teachers" in f && !String(f.role_teachers ?? "");
    if (noTeachers && twoTeachers)
      return refuse(
        "second_teacher",
        "a second teacher needs a first. Choose the first teacher's model, or remove the second teacher.",
      );
    const plans: AgentModelPlan[] = [];
    for (const role of AGENT_ROLES) {
      if (noTeachers && (role === "second_teacher" || role === "merged_by")) {
        if (roles[role]) plans.push({ role, clear: true });
        continue;
      }
      if (!(`role_${role}` in f)) continue;
      const raw = String(f[`role_${role}`] ?? "");
      const cur = roles[role];
      if (!raw && !cur) continue;
      const roleEffort = effortOf(`effort_${role}`);
      const picked = HARNESSES.find((h) => h === String(f[`harness_${role}`] ?? ""));
      const ctx = contextOf(role, raw);
      if ("error" in ctx) return refuse(role, ctx.error);
      if (cur && raw === modelValue(cur.provider, cur.model)) {
        const p = store.modelProviders.get(cur.provider);
        const curHarness = cur.harness ?? (p ? neededHarness(p, cur.model) : "pi");
        if (
          (roleEffort ?? null) === cur.effort &&
          (picked === undefined || picked === curHarness) &&
          (ctx.cap === undefined || ctx.cap === (cur.contextCap ?? null)) &&
          (ctx.at === undefined || ctx.at === (cur.compactAt ?? null))
        )
          continue;
      }
      const plan = checkAgentModel(store, rig, role, raw, roleEffort, picked, ctx.cap, ctx.at);
      if ("error" in plan) return refuse(role, plan.error);
      plans.push(plan);
    }

    // The workers' line: as in Providers, with its own window and point.
    const choice = String(f.choice ?? "");
    const want = store.agentModels.byRig()[rig];
    // A form without the harness (the line had no model) keeps the one control has.
    const harness = "harness" in f ? harnessOf(f.harness) : (want?.harness ?? "pi");
    const effort = effortOf("effort");
    const wCtx = contextOf("workers", choice);
    if ("error" in wCtx) return refuse("workers", wCtx.error);
    const workersChange =
      choice !== (want ? modelValue(want.provider, want.model) : "") ||
      (choice !== "" &&
        (harness !== want?.harness ||
          (effort ?? null) !== (want?.effort ?? null) ||
          (wCtx.cap !== undefined && wCtx.cap !== (want?.contextCap ?? null)) ||
          (wCtx.at !== undefined && wCtx.at !== (want?.compactAt ?? null))));
    // Checked now, given below with the rest: the window and the point as giveRigModel checks them.
    if (workersChange && choice) {
      const [, mRaw] = choice.split("|");
      const why =
        (typeof wCtx.cap === "number"
          ? contextCapRefusal(decodeURIComponent(mRaw ?? ""), listedOf(choice), wCtx.cap)
          : undefined) ?? (typeof wCtx.at === "number" ? compactAtRefusal(wCtx.at) : undefined);
      if (why) return refuse("workers", why);
    }

    // A rig control set up on a cluster: its GPUs, CPUs and memory (goal 118), checked here with
    // the rest, against the slot's quota read again, and changed last. With a new number of GPUs,
    // GPUs for the judge is the judge's share of them, not a split of the old ones.
    const onCluster = store.clusters.rig(rig);
    let resize: Awaited<ReturnType<typeof prepareResize>> | undefined;
    let gpusMoved = false;
    // A new mode for its agent programs moves the supervisor's share of set CPUs and memory
    // (goal 169), so it is checked and applied with the size.
    const modeTo = PROGRAM_MODES.find(
      (m) => m === f.program_mode && m !== u.settings?.program_mode,
    );
    if (onCluster && ("k_gpus" in f || "k_cpus" in f || "k_mem" in f || modeTo)) {
      const field = (k: string) => {
        if (!(k in f)) return undefined;
        const v = String(f[k] ?? "").trim();
        return v === "" ? null : Number(v);
      };
      const cur = onCluster.spec;
      const want: ClusterResourcesRequest = {};
      const gpus = field("k_gpus");
      if (typeof gpus === "number" && gpus !== cur.gpus) {
        want.gpus = gpus;
        gpusMoved = true;
        const judge = u.gpu_split ? field("judge_gpus") : undefined;
        if (typeof judge === "number") want.judgeGpus = judge;
      }
      const cpus = field("k_cpus");
      const memoryGi = field("k_mem");
      if (
        cpus !== undefined &&
        memoryGi !== undefined &&
        (cpus !== (cur.resources?.cpus ?? null) || memoryGi !== (cur.resources?.memoryGi ?? null))
      ) {
        want.cpus = cpus;
        want.memoryGi = memoryGi;
      }
      // With the namespace's defaults and no new size, a new mode moves nothing.
      if (modeTo && (cur.resources || !asksNothing(want))) want.programMode = modeTo;
      if (!asksNothing(want)) {
        resize = await prepareResize(parts, rig, want, "owner:ui", { owner: true });
        if ("error" in resize) return back("error", `Not saved: ${resize.error}`);
      }
    }

    // The harness's settings: only what changed, checked here (as REST's and MCP's twins check
    // them: rigs/settings.ts) and sent below as one signed command. An empty Workers at a time
    // keeps what the rig has; an empty One trial lasts or Turns per trial is no limit.
    const s = u.settings;
    let settings: RigSettingsChange | undefined;
    if (s) {
      const num = (k: string) => {
        const v = String(f[k] ?? "").trim();
        return v === "" ? null : Number(v);
      };
      const out = rigSettingsChange(rig, s, u.gpu_split, {
        ...Object.fromEntries(PARTS.map((p) => [p.id, f[p.id] === "1"])),
        lanes: num("lanes") ?? undefined,
        // Empty: no limit (goal 079).
        trial_minutes: num("trial_minutes"),
        max_turns: num("max_turns"),
        quiet_minutes: num("quiet_minutes"),
        // Off on a rig that reports none (programModeField): then the form has no value.
        program_mode: typeof f.program_mode === "string" ? f.program_mode : undefined,
        promotion: String(f.promotion ?? s.promotion),
        // The field shows only on a rig with a GPU set. With a new number of GPUs, it goes with
        // the change to them.
        judge_gpus: u.gpu_split && !gpusMoved ? (num("judge_gpus") ?? undefined) : undefined,
      });
      if ("error" in out) return back("error", out.error);
      settings = out.change;
    }

    // Everything is checked: save the models, then send the settings.
    if (workersChange) {
      if (!choice) {
        clearRigModel(store, rig);
        said.push("its own model settings");
      } else {
        const given = giveRigModel(
          store,
          rig,
          choice,
          harness,
          effort,
          "owner:ui",
          wCtx.cap,
          wCtx.at,
        );
        if ("error" in given) return refuse("workers", given.error);
        said.push("a new model");
      }
    }
    const teachersCleared = plans.some((p) => p.role === "teachers" && p.clear);
    for (const plan of plans) {
      const ok = applyAgentModel(store, rig, plan).ok;
      // The teachers back to the advisors file: said once, for their three models.
      if (!(teachersCleared && plan.clear && plan.role !== "teachers")) said.push(ok);
    }
    let sent: string | undefined;
    if (settings) {
      sent = issueCommand(store, opts.privateKeyPem, {
        rig,
        kind: "rig_settings",
        payload: settings,
        issuedBy: "owner:ui",
      }).id;
      said.push(settingsCount(Object.keys(settings).length));
    }
    // Last, its GPUs, CPUs and memory: its pods restart (or it drains first).
    let resized = "";
    if (resize && !("error" in resize)) {
      const done = "go" in resize ? await resize.go() : resize;
      if ("error" in done)
        return back(
          "error",
          `${said.length ? `Control sent ${said.join(" and ")} to ${rig}, but its` : "Its"} GPUs, CPUs and memory did not change: ${done.error}`,
        );
      resized = done.ok;
    }
    if (!said.length) return back("ok", resized || "Nothing changed.");
    // The rig's page follows the settings' command, and the rig as it takes a model (goal 080).
    return c.redirect(
      `/ui/rigs/${encodeURIComponent(rig)}?ok=${encodeURIComponent(`Control sent ${said.join(" and ")} to ${rig}. The rig takes the change in less than one minute.${resized ? ` ${resized}` : ""}`)}${sent ? `&cmd=${encodeURIComponent(sent)}` : ""}`,
      303,
    );
  });
}
