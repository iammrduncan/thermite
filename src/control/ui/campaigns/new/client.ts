/**
 * The new-campaign page's script, served from control (/ui/assets/new-campaign.js; no inline
 * script runs under the dashboard's CSP). It moves between the steps, keeps the choices, asks
 * control to look up the project, and on submit gathers the answers into one draft (JSON) for
 * control to check and build. It reads what the owner typed and builds text with DOM text
 * nodes or escaped strings only.
 */

import { BRIEF_CORE_JS, BRIEF_PAGE_JS } from "../brief.ts";
import { CC_CORE_JS } from "../context/index.ts";

/**
 * The page-free part for an uploaded kit's MCP servers (goal 068), as the browser runs it: the
 * list the page sends keeps the kit's own entries that the page can't show. A server Settings
 * lacks stays in it (the page says so, and control refuses the start until Settings has it), and
 * a tool narrowing stays for a server whose tools Settings has not read, since the page then shows
 * no tools to change it. `ticked`: the servers ticked on the page, as picked() reads them; `own`:
 * the kit's list; `known`: the servers Settings has; `listed`: those whose tools it has read.
 */
export const KIT_MCP_CORE_JS = `
function keepKitMcp(ticked, own, known, listed) {
  const out = ticked.map((x) => {
    const k = own.find((o) => o.name === x.name);
    if (!k || !k.tools || listed.includes(x.name)) return x;
    const tools = {};
    for (const a of x.agents) if (k.tools[a]) tools[a] = k.tools[a];
    return Object.keys(tools).length ? Object.assign({}, x, { tools }) : x;
  });
  for (const k of own) if (!known.includes(k.name)) out.push(k);
  return out;
}`;

export const NEW_CAMPAIGN_JS = `
(() => {
  "use strict";
  ${KIT_MCP_CORE_JS}
  ${CC_CORE_JS}
  ${BRIEF_CORE_JS}
  const form = document.getElementById("nc");
  if (!form) return;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const val = (name) => (form.elements[name] ? String(form.elements[name].value).trim() : "");
  const lines = (name) => val(name).split("\\n").map((x) => x.trim()).filter(Boolean);
  const words = (name) => val(name).split(/[\\s,]+/).filter(Boolean);
  const choice = {};
  $$(".ch.on[data-group]").forEach((c) => (choice[c.dataset.group] = c.dataset.value));

  // ------------------------------------------------ steps
  const order = () => $$("#steps li").filter((li) => !li.hidden).map((li) => li.dataset.step);
  let cur = "aim";
  const go = (id) => {
    cur = id;
    const o = order(), at = o.indexOf(id);
    $$("#steps li").forEach((li) => {
      li.classList.toggle("on", li.dataset.step === id);
      li.classList.toggle("done", o.indexOf(li.dataset.step) > -1 && o.indexOf(li.dataset.step) < at);
    });
    $$(".pane").forEach((p) => (p.hidden = p.dataset.pane !== id));
    window.scrollTo({ top: 0 });
  };
  $("#steps").addEventListener("click", (e) => { const li = e.target.closest("li"); if (li) go(li.dataset.step); });

  // ------------------------------------------------ choices, rows, placeholders
  form.addEventListener("click", (e) => {
    if (e.target.closest(".ii")) { e.preventDefault(); return; }
    const c = e.target.closest(".ch[data-group]");
    if (c && !c.classList.contains("dis")) {
      $$('.ch[data-group="' + c.dataset.group + '"]').forEach((x) => x.classList.toggle("on", x === c));
      choice[c.dataset.group] = c.dataset.value;
      update();
    }
    const nav = e.target.closest("[data-next],[data-back]");
    if (nav) { e.preventDefault(); const o = order(), i = o.indexOf(cur); go(o[i + (nav.hasAttribute("data-next") ? 1 : -1)] || cur); }
    const add = e.target.closest("[data-add]");
    if (add) {
      e.preventDefault();
      const body = $(add.dataset.add + " tbody"), tpl = body.querySelector("tr");
      const row = tpl.cloneNode(true);
      row.querySelectorAll("input").forEach((i) => (i.value = ""));
      body.appendChild(row);
    }
    const del = e.target.closest("[data-del]");
    if (del) { e.preventDefault(); const tr = del.closest("tr"); if (tr.parentElement.children.length > 1) tr.remove(); update(); }
    const ph = e.target.closest("[data-ph]");
    if (ph) { e.preventDefault(); const t = form.elements[ph.dataset.into]; t.value = (t.value + " " + ph.dataset.ph).trim(); update(); }
    const sug = e.target.closest("[data-path]");
    if (sug) { e.preventDefault(); const t = form.elements.editable_paths; if (!lines("editable_paths").includes(sug.dataset.path)) t.value = (t.value.trim() + "\\n" + sug.dataset.path).trim(); update(); }
  });
  form.addEventListener("input", () => update());
  form.addEventListener("change", () => update());
${BRIEF_PAGE_JS}

  // ------------------------------------------------ the project: control looks it up
  let found = null;
  // The project's folder in its repository, as a path from the top: "./" and outer "/" go.
  const folder = () => val("project_folder").replace(/^(\\.\\/)+|^\\/+|\\/+$/g, "");
  const probe = async () => {
    const out = $("#probe-out");
    const url = val("project_url"), ref = val("project_ref") || "HEAD";
    if (!url) return;
    out.textContent = "Looking it up…";
    try {
      const body = new URLSearchParams({ csrf: form.elements.csrf.value, url, ref, access: val("project_access"), folder: folder() });
      const res = await fetch("/ui/campaigns/new/probe", { method: "POST", body, credentials: "same-origin" });
      const j = await res.json();
      if (!res.ok) { found = null; out.textContent = j.error || "Control could not read it."; update(); return; }
      found = j;
      out.textContent = "";
      const b = document.createElement("b"); b.textContent = ref;
      out.append("Found: ", b, " is at ", j.commit.slice(0, 7), " · " + j.files + " file" + (j.files === 1 ? "" : "s") + (folder() ? " in " + folder() : "") + ". Rigs fetch it from there.");
      const sug = $("#suggest"); sug.replaceChildren();
      for (const p of j.suggest) { const btn = document.createElement("button"); btn.className = "sm"; btn.dataset.path = p; btn.textContent = p; sug.append(btn); }
      update();
    } catch { out.textContent = "Control could not reach the repository."; }
  };
  $("#probe")?.addEventListener("click", (e) => { e.preventDefault(); probe(); });

  // ------------------------------------------------ the draft
  const repoName = (url) => (url.replace(/\\.git$/, "").split(/[/:]/).pop() || "project").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[^a-z0-9]+/, "").slice(0, 64) || "project";
  const files = [];
  const inputs = [];
  const asBase64 = (f) => new Promise((ok) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(",")[1] || ""); r.readAsDataURL(f); });
  $("#input-files")?.addEventListener("change", async (e) => {
    for (const f of e.target.files) inputs.push({ name: f.name, content_base64: await asBase64(f) });
    $("#input-files-list").textContent = inputs.map((f) => f.name).join(", ");
    const dl = $("#nc-inputs"); dl.replaceChildren();
    for (const f of inputs) { const o = document.createElement("option"); o.value = f.name; dl.append(o); }
    e.target.value = "";
    update();
  });
  // A list of cases pasted at once: one per line, its name and then its arguments.
  $("#paste-cases")?.addEventListener("click", (e) => {
    e.preventDefault();
    if ($("#paste-box")) return;
    const box = document.createElement("div");
    box.id = "paste-box";
    const ta = document.createElement("textarea");
    ta.className = "mono";
    ta.style.cssText = "width:100%;height:90px;margin-top:8px";
    ta.placeholder = "light --users 10\\nheavy --users 500";
    const add = document.createElement("button");
    add.className = "sm primary";
    add.textContent = "Add these cases";
    box.append(ta, add);
    e.target.closest(".act").after(box);
    add.addEventListener("click", (ev) => {
      ev.preventDefault();
      const body = $("#cases tbody"), tpl = body.querySelector("tr");
      for (const line of ta.value.split("\\n").map((l) => l.trim()).filter(Boolean)) {
        const at = line.search(/\\s/), row = tpl.cloneNode(true);
        row.querySelectorAll("input").forEach((i) => { if (i.type === "checkbox") i.checked = false; else i.value = ""; });
        const [name, args] = [...row.querySelectorAll("input")];
        name.value = at < 0 ? line : line.slice(0, at);
        args.value = at < 0 ? "" : line.slice(at + 1).trim();
        body.appendChild(row);
      }
      box.remove();
      update();
    });
  });
  $("#kit-files")?.addEventListener("change", async (e) => {
    for (const f of e.target.files) {
      const b64 = await new Promise((ok) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(",")[1] || ""); r.readAsDataURL(f); });
      files.push({ name: f.name, content_base64: b64, run: $("#kit-files-run").checked });
    }
    const list = $("#kit-files-list"); list.textContent = files.map((f) => f.name + (f.run ? " (the run reads it)" : "")).join(", ");
    e.target.value = "";
  });
  // ------------------------------------------------ MCP servers for the agents (goal 068)
  const WHO = ["workers", "planner", "advisors"];
  const research = () => (choice.mode || "hill_climb") === "research";
  const repoKitOn = () => !research() && (choice.kit || "here") === "repo";
  const blockOf = (prefix) => $('[data-mcp-block="' + prefix + '"]');
  const mcpBlock = () => blockOf(research() ? "r" : "k");
  // A kit in a repository: the servers its kit.json names, as control read them (null: not read).
  let repoKit = { key: "", list: null, said: "" };
  const rowOf = (blk, name) => $$(".sopt[data-srv]", blk).find((o) => o.dataset.srv === name);
  /** The servers ticked in a block: each with its agents and, only when narrowed, their tools. */
  const picked = (blk) => (blk ? $$(".sopt[data-srv]", blk) : []).filter((o) => $("[data-srv-on]", o).checked).map((o) => {
    const agents = WHO.filter((k) => $('[data-who="' + k + '"]', o).checked);
    const rows = $$("tr[data-tool]", o);
    const tools = {};
    for (const k of agents) {
      if (!rows.length) continue;
      const on = rows.filter((tr) => $('[data-tool-who="' + k + '"]', tr).checked).map((tr) => tr.dataset.tool);
      if (on.length < rows.length) tools[k] = on;
    }
    return { name: o.dataset.srv, agents, ...(Object.keys(tools).length ? { tools } : {}) };
  });
  // An uploaded kit: the servers its kit.json names (or the list sent last time), which the page
  // keeps where it can't show them (keepKitMcp).
  let kitOwn = null;
  const uploadKitOn = () => !research() && choice.kit === "upload";
  const blockList = (blk) => {
    const list = picked(blk);
    if (!blk || blk.dataset.mcpBlock !== "k" || !uploadKitOn() || !kitOwn) return list;
    const rows = $$(".sopt[data-srv]", blk);
    return keepKitMcp(list, kitOwn, rows.map((o) => o.dataset.srv), rows.filter((o) => $$("tr[data-tool]", o).length).map((o) => o.dataset.srv));
  };
  const mcpList = () => (repoKitOn() ? repoKit.list : blockList(mcpBlock()));
  /** Ticks a block's servers, agents and tools as a list says (a draft sent back, an uploaded kit). */
  const restoreMcp = (blk, list) => {
    if (!blk || !Array.isArray(list)) return;
    for (const o of $$(".sopt[data-srv]", blk)) {
      const u = list.find((x) => x.name === o.dataset.srv);
      $("[data-srv-on]", o).checked = !!u;
      for (const k of WHO) $('[data-who="' + k + '"]', o).checked = !!u && u.agents.includes(k);
      for (const tr of $$("tr[data-tool]", o))
        for (const k of WHO) {
          const only = u && u.tools && u.tools[k];
          $('[data-tool-who="' + k + '"]', tr).checked = !only || only.includes(tr.dataset.tool);
        }
    }
  };
  const andList = (xs) => (xs.length > 1 ? xs.slice(0, -1).join(", ") + " and " + xs[xs.length - 1] : xs[0] || "");
  const line = (cls, text) => { const s = document.createElement(cls === "bad" ? "b" : "span"); s.className = cls; s.textContent = text + " "; return s; };
  const mcpUpdate = () => {
    for (const blk of $$("[data-mcp-block]")) {
      const repo = blk.dataset.mcpBlock === "k" && repoKitOn();
      $$("[data-mk-kit]", blk).forEach((el) => (el.hidden = el.dataset.mkKit !== (repo ? "repo" : "here")));
      for (const o of $$(".sopt[data-srv]", blk)) {
        const on = $("[data-srv-on]", o).checked;
        $(".mcp-who", o).classList.toggle("off", !on);
        for (const x of $$("input[data-tool-who]", o)) x.disabled = !on || !$('[data-who="' + x.dataset.toolWho + '"]', o).checked;
      }
      const list = repo ? repoKit.list : blockList(blk);
      const known = (n) => !!rowOf(blk, n);
      const toolsOf = (n) => Number((rowOf(blk, n) || { dataset: {} }).dataset.tools || 0);
      const bad = (n) => (rowOf(blk, n) || { dataset: {} }).dataset.bad === "1";
      const part = (k) => {
        const s = (list || []).filter((x) => x.agents.includes(k) && known(x.name));
        const n = s.reduce((t, x) => t + (x.tools && x.tools[k] ? x.tools[k].length : toolsOf(x.name)), 0);
        const get = k === "planner" ? " gets " : " get ";
        return s.length ? "the " + k + get + n + " tool" + (n === 1 ? "" : "s") + " from " + andList(s.map((x) => x.name)) : "the " + k + get + "none";
      };
      const sum = $("[data-mcp-sum]", blk);
      sum.replaceChildren();
      if (list === null) sum.textContent = repoKit.said;
      else if (!list.length) sum.textContent = "No MCP server: the agents have only Thermite's own tools.";
      else {
        const t = WHO.map(part).join("; ");
        sum.append(t.charAt(0).toUpperCase() + t.slice(1) + ". ");
        for (const x of list) {
          if (!known(x.name)) sum.append(line("bad", x.name + " is not in Settings: this campaign can't start until it is." + (blk.dataset.mcpBlock === "k" && uploadKitOn() ? " The uploaded kit names it: add it in Settings, or upload the kit without it." : "")));
          else if (bad(x.name)) sum.append(line("warn", x.name + " doesn't work now: fix it in Settings, or the agents go on without it."));
          if (!x.agents.length) sum.append(line("bad", "Choose the agents that get " + x.name + ", or untick it."));
          for (const k of x.agents) if (x.tools && x.tools[k] && !x.tools[k].length) sum.append(line("bad", "The " + k + (k === "planner" ? " gets" : " get") + " no tool of " + x.name + ": give " + (k === "planner" ? "it" : "them") + " one, or untick " + k + "."));
        }
      }
      $("[data-mcp-json]", blk).textContent = JSON.stringify({ mcp_servers: list || [] }, null, 2);
      const box = $("[data-mcp-repo-list]", blk);
      if (!box) continue;
      box.replaceChildren();
      $("[data-mcp-repo-said]", blk).textContent = repoKit.list
        ? "Read from the kit's kit.json at commit " + repoKit.key.split("@").pop().slice(0, 7) + ". To change them, change kit.json in the kit's repository."
        : "Fill in the kit's repository and its commit: control reads the servers from its kit.json. To change them, change kit.json in the kit's repository.";
      for (const x of repoKit.list || []) {
        const found = known(x.name);
        const row = document.createElement("div"); row.className = "ck";
        const res = document.createElement("span"); res.className = "ck-res";
        const chip = document.createElement("span"); chip.className = "chip " + (found ? "ok" : "bad"); chip.textContent = found ? "✓ found" : "✕ missing"; res.append(chip);
        const main = document.createElement("span"); main.className = "ck-main";
        const head = document.createElement("span"); const b = document.createElement("b"); b.textContent = x.name;
        const who = document.createElement("span"); who.className = "muted small"; who.textContent = " for the " + x.agents.join(", ");
        head.append(b, who);
        const st = document.createElement("span"); st.className = "ck-sum" + (found ? "" : " bad");
        st.textContent = found ? "In Settings · " + toolsOf(x.name) + " tools" + (bad(x.name) ? " · it doesn't work now" : "") : "Not in Settings. Add an MCP server named " + x.name + " in Settings, or this campaign can't start.";
        main.append(head, st);
        const act = document.createElement("span");
        if (!found) { const a = document.createElement("a"); a.className = "btn sm"; a.href = "/ui/settings#add-mcp"; a.textContent = "Add it in Settings"; act.append(a); }
        row.append(res, main, act); box.append(row);
      }
    }
  };
  // A server ticked now goes to the workers until other agents are chosen.
  form.addEventListener("change", (e) => {
    const s = e.target.closest && e.target.closest("[data-srv-on]");
    if (s && s.checked) { const o = s.closest(".sopt"); if (!$("[data-who]:checked", o)) $('[data-who="workers"]', o).checked = true; update(); }
  });
  // A kit in a repository: control reads its kit.json once the repository and commit are given.
  const readRepoKit = async () => {
    const url = val("kit_url"), commit = val("kit_commit"), key = url + "@" + commit;
    if (!url || !/^[0-9a-f]{40}$/.test(commit) || key === repoKit.key) return;
    repoKit = { key, list: null, said: "Reading the kit's kit.json…" };
    update();
    try {
      const body = new URLSearchParams({ csrf: form.elements.csrf.value, url, commit, access: val("kit_access") });
      const res = await fetch("/ui/campaigns/new/kit-repo", { method: "POST", body, credentials: "same-origin" });
      const j = await res.json();
      repoKit = res.ok ? { key, list: j.mcp_servers, said: "" } : { key, list: null, said: j.error || "Control could not read the kit's kit.json." };
    } catch { repoKit = { key, list: null, said: "Control could not reach the kit's repository." }; }
    update();
  };
  for (const n of ["kit_url", "kit_commit", "kit_access"]) form.elements[n]?.addEventListener("change", readRepoKit);

  // ------------------------------------------------ an uploaded kit: control checks it and says what it holds
  let upKit = null;
  const option = (value, text) => { const o = document.createElement("option"); o.value = value; o.textContent = text; return o; };
  const showKit = (j, pick) => {
    upKit = j;
    // Its MCP servers, as its kit.json names them, ticked here: control keeps the kit, so they can
    // change. What the page can't show stays as the kit has it (keepKitMcp).
    if (!pick) {
      kitOwn = j.mcp_servers || [];
      restoreMcp(blockOf("k"), kitOwn);
    }
    form.elements.kit_upload.value = j.id;
    $("#up-kit").hidden = false;
    const n = j.cells.length;
    $("#up-summary").textContent = j.name + ": measures on " + j.target + ", " + n + " case" + (n === 1 ? "" : "s") + ", scores " + Object.keys(j.metrics).join(", ") + ".";
    const body = $("#up-cases tbody"); body.replaceChildren();
    for (const c of j.cells) {
      const name = document.createElement("td"); name.className = "mono"; name.textContent = c;
      const sel = document.createElement("select"); sel.dataset.cell = c; sel.setAttribute("aria-label", "use of " + c);
      sel.append(option("measure", "Measured"), option("hidden", "Hidden test"), option("skip", "Not used"));
      if (pick) sel.value = (pick.held_out || []).includes(c) ? "hidden" : (pick.cells || []).includes(c) ? "measure" : "skip";
      const use = document.createElement("td"); use.append(sel);
      const tr = document.createElement("tr"); tr.append(name, use); body.append(tr);
    }
    const ms = form.elements.up_metric; ms.replaceChildren();
    for (const [m, about] of Object.entries(j.metrics)) ms.append(option(m, m + ": " + about.about));
    $("#up-verifiers").textContent = j.verifiers.length
      ? "The kit's own checks, for goals checked by the kit's own check: " + j.verifiers.join(", ") + "."
      : "This kit has no checks of its own: check its goals by the check passing on cases, or by the score.";
    update();
  };
  $("#kit-archive")?.addEventListener("change", async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const out = $("#kit-archive-out");
    out.textContent = "Checking " + f.name + "…";
    const body = new FormData();
    body.append("csrf", form.elements.csrf.value);
    body.append("archive", f);
    try {
      const res = await fetch("/ui/campaigns/new/kit", { method: "POST", body, credentials: "same-origin" });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { out.textContent = j.error || "Control could not read it."; return; }
      out.textContent = f.name + ": checked.";
      showKit(j);
    } catch { out.textContent = "Control could not take the upload."; }
    e.target.value = "";
  });
  const num = (name) => { const n = Number(val(name)); return Number.isFinite(n) && val(name) !== "" ? n : undefined; };
  const draft = () => {
    const mode = choice.mode || "hill_climb";
    const d = { mode, campaign: val("campaign"), title: val("title"), lanes: Number(val("lanes") || 2), limits: {} };
    // The brief (goal 078): the additional information, the ideas (hill climb and goal) and the hypotheses.
    Object.assign(d, briefDraft(mode, briefFieldsNow()));
    for (const k of ["trial_minutes", "run_rss_mib", "workspace_mib"]) { const n = num(k); if (n !== undefined) d.limits[k] = n; }
    if (num("wall_hours")) d.wall_hours = num("wall_hours");
    // Ideas kept ready (goal 081): the queue's target, for hill climbs and goals.
    if (mode !== "research" && num("queue_target") !== undefined) d.queue_target = num("queue_target");
    // The campaign's own Agents' context (goal 070): numbers out of range go as typed, so that
    // control refuses them in its words; the submit stops on what is not a number.
    const cw = ccNum(val("context_window")), ca = ccNum(val("compact_at"), true);
    if (cw.n || ca.n) d.agents_context = Object.assign({}, cw.n ? { context_window: cw.n } : {}, ca.n ? { compact_at: ca.n } : {});
    // The owner's additions to the mode's roles (goal 166): each box filled, by its role's id.
    const adds = {};
    for (const el of $$('[name^="addition_"]')) if (!el.closest("[hidden]") && el.value.trim()) adds[el.name.slice(9)] = el.value;
    if (Object.keys(adds).length) d.role_additions = adds;
    if (mode === "research") {
      d.research = { topic: val("topic"), questions: briefList(blItems("questions")), seeds: briefLinks(form.elements.links ? form.elements.links.value : "").links, min_duration: val("min_duration") };
      // The floor of verified claims before the answer check (goal 112): left out when empty.
      if (num("min_verified_claims") !== undefined) d.research.min_verified_claims = num("min_verified_claims");
      d.mcp_servers = picked(blockOf("r"));
      return d;
    }
    // The kit's MCP servers: ticked here, or read from a kit in a repository.
    const servers = mcpList();
    if (servers) d.mcp_servers = servers;
    const url = val("project_url");
    d.project = { url, ...(val("project_access") ? { access: val("project_access") } : {}), ref: val("project_ref") || undefined, commit: found ? found.commit : undefined, repo: repoName(url), ...(folder() ? { folder: folder() } : {}), editable_paths: lines("editable_paths"), forbidden_patterns: lines("forbidden_patterns") };
    if ((choice.kit || "here") === "here") {
      const timed = (choice.score || "time") === "time";
      const cases = $$("#cases tbody tr").map((tr) => {
        const [name, args, input, work, hidden] = [...tr.querySelectorAll("input")];
        return {
          name: name.value.trim(),
          ...(args.value.trim() ? { args: args.value.trim() } : {}),
          ...(input.value.trim() ? { input: input.value.trim() } : {}),
          ...(timed && work.value.trim() ? { work: Number(work.value.trim()) } : {}),
          ...(hidden.checked ? { hidden: true } : {}),
        };
      }).filter((c) => c.name);
      d.kit = { source: "here", build: val("build") || "true", outputs: words("outputs"), cases, inputs, run: val("run"), check: val("check"), files, runs_per_case: Number(val("runs_per_case") || 3) };
    } else if (choice.kit === "upload") {
      const use = $$("#up-cases select");
      d.kit = { source: "upload", upload: val("kit_upload"), cells: use.filter((s) => s.value !== "skip").map((s) => s.dataset.cell), held_out: use.filter((s) => s.value === "hidden").map((s) => s.dataset.cell) };
    } else {
      d.kit = { source: "repo", url: val("kit_url"), ...(val("kit_access") ? { access: val("kit_access") } : {}), commit: val("kit_commit"), repo: repoName(val("kit_url")), cells: words("kit_cells"), held_out: words("held_out_repo") };
    }
    d.score = (choice.kit || "here") === "repo"
      ? { name: val("repo_metric") || "rate", direction: val("direction") || "max", min_effect: (num("min_effect") ?? 5) / 100 }
      : choice.kit === "upload"
        ? { name: val("up_metric") || undefined, direction: val("up_direction") || "max", min_effect: (num("up_min_effect") ?? 5) / 100 }
        : (choice.score || "time") === "check"
        ? { kind: "check", field: val("score_field") || undefined, unit: val("score_unit"), direction: val("direction") || "max", min_effect: (num("min_effect") ?? 5) / 100 }
        : { kind: "time", min_effect: (num("min_effect") ?? 5) / 100 };
    if (mode === "goal") {
      d.goals = $$("#goals tbody tr").map((tr, i) => {
        const [desc, detail] = [...tr.querySelectorAll("input")].map((x) => x.value.trim());
        const kind = tr.querySelector("select").value;
        const id = (desc.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "goal") + "-" + (i + 1);
        if (kind === "check") return { id, description: desc, verify: { type: "check", cells: detail.split(/[\\s,]+/).filter(Boolean) } };
        if (kind === "verifier") return { id, description: desc, verify: { type: "verifier", verifier: detail } };
        if (kind === "review") return { id, description: desc, verify: { type: "review", criteria: detail.split(";").map((x) => x.trim()).filter(Boolean) } };
        const m = /^(>=|<=|>|<)\\s*([-+0-9.eE]+)\\s+on\\s+(.+)$/.exec(detail);
        return { id, description: desc, verify: m ? { type: "metric", op: m[1], value: Number(m[2]), cells: m[3].split(/[\\s,]+/).filter(Boolean) } : { type: "metric", op: ">=", value: NaN, cells: [] } };
      }).filter((g) => g.description);
    }
    return d;
  };

  // ------------------------------------------------ the Agents' context (goal 070)
  // What the first run's workers get on the chosen rig, with the model chosen here or the rig's,
  // and the model that would refuse the run there.
  const ccSec = $("[data-cc-rigs]", form);
  let ccRigs = {};
  try { ccRigs = JSON.parse((ccSec && ccSec.dataset.ccRigs) || "{}"); } catch {}
  const ccUpdate = () => {
    if (!ccSec) return { errs: [] };
    const cc = $('[data-cc="new"]', ccSec), sayEl = $("[data-cc-say]", cc);
    const s = ccRead(val("context_window"), val("compact_at"));
    form.elements.context_window.classList.toggle("bad", s.cwBad);
    form.elements.compact_at.classList.toggle("bad", s.atBad);
    sayEl.className = "cc-say" + (s.errs.length ? " bad" : "");
    sayEl.replaceChildren();
    if (s.errs.length) { sayEl.textContent = s.errs.join(" "); return s; }
    const rig = choice.rig || "";
    if (!rig) return s;
    const research = (choice.mode || "hill_climb") === "research";
    let own = (ccRigs[rig] || []).filter((a) => !research || ["workers", "teachers", "second_teacher", "merged_by", "synthesizer", "final_writer"].includes(a.agent));
    const mSel = form.elements.agents_model;
    if (mSel && mSel.value) {
      const opt = mSel.selectedOptions[0], model = decodeURIComponent(mSel.value.split("|")[1] || "");
      const had = own.find((a) => a.agent === "workers");
      const same = !!had && had.model === model;
      own = [{ agent: "workers", model, listed: Number(opt.dataset.window || 0), cap: same ? had.cap : null, at: same ? had.at : null }, ...own.filter((a) => a.agent !== "workers")];
    }
    const r = ccApply(own, s);
    if (r.refused) {
      sayEl.className = "cc-say bad";
      sayEl.textContent = r.refused.model + " takes at most " + ccFmt(r.refused.listed) + " tokens: a run on " + rig + " can't start with this window.";
      return s;
    }
    sayEl.append("On " + rig + ", the first run's workers get ", r.window === null ? "the rig's window" : ccCell(r.window, r.windowFrom === "campaign", ""), r.window === null ? "" : " tokens", " and compact at ", ccCell(r.at, r.atFrom === "campaign", "%"), ".");
    return s;
  };

  // ------------------------------------------------ what the page says back
  const update = () => {
    mcpUpdate();
    briefUpdate();
    const cc = ccUpdate();
    const mode = choice.mode || "hill_climb";
    $$("[data-modes]").forEach((el) => (el.hidden = !el.dataset.modes.split(" ").includes(mode)));
    $$("[data-kit]").forEach((el) => (el.hidden = el.dataset.kit !== (choice.kit || "here")));
    $$("[data-score]").forEach((el) => (el.hidden = el.dataset.score !== (choice.score || "time")));
    $$("option[data-kits]").forEach((o) => { o.hidden = !o.dataset.kits.split(" ").includes(choice.kit || "here"); });
    // An uploaded kit's time score is better lower, whatever was chosen.
    const kind = upKit?.metrics[val("up_metric")]?.kind;
    if (form.elements.up_direction) {
      if (kind === "time") form.elements.up_direction.value = "min";
      form.elements.up_direction.disabled = kind === "time";
    }
    const rig = choice.rig || "", lanes = val("lanes") || "2";
    const score = choice.kit === "upload" ? (val("up_metric") || "the kit's score") + " " + (val("up_direction") === "min" ? "lower" : "higher") : (choice.score || "time") === "check" ? (val("score_field") || "its score") + " " + (val("direction") === "min" ? "lower" : "higher") : "its runs faster";
    const aim = { hill_climb: "make " + score + ", keeping only changes the judge confirms are at least " + (val(choice.kit === "upload" ? "up_min_effect" : "min_effect") || "5") + "% better", goal: "reach its goals, each checked by the judge", research: "research " + (val("topic") || "its topic") + " and report checked findings" }[mode];
    const proj = mode === "research" ? "" : " on " + repoName(val("project_url") || "the project") + (folder() ? " (the folder " + folder() + ")" : "") + (found ? " at " + found.commit.slice(0, 7) : "") + ", changing only " + (lines("editable_paths").join(", ") || "(no files yet)");
    const ctx = cc.errs.length ? "" : cc.cw ? " Its agents get at most " + ccFmt(cc.cw) + " tokens" + (cc.at ? " and compact at " + cc.at + "%." : ".") : cc.at ? " Each of its agents compacts at " + cc.at + "%." : "";
    // The brief in a few words (goal 078).
    const bf = briefFieldsNow(), bd = briefDraft(mode, bf);
    const qs = mode === "research" ? briefList(blItems("questions")).length : 0, nl = briefLinks(bf.links).links.length;
    const count = (n, one, many) => n.toLocaleString("en-US") + " " + (n === 1 ? one : many);
    const bparts = [qs ? count(qs, "question", "questions") : "", bd.notes ? count(bd.notes.length, "character", "characters") + " of additional information" : "", nl ? count(nl, "starting link", "starting links") : "", bd.ideas ? count(bd.ideas.length, "idea", "ideas") + " to try" : "", bd.hypotheses ? count(bd.hypotheses.length, "hypothesis", "hypotheses") : ""].filter(Boolean);
    // Only a brief with something in it is said: an empty one adds nothing to the sentence.
    const brief = bparts.length ? " Its brief: " + bparts.join(", ") + "." : "";
    const s = (val("campaign") || "The campaign") + " will " + aim + proj + ". " + lanes + (Number(lanes) === 1 ? " agent works" : " agents work") + " on " + (rig || "(no rig chosen)") + "." + ctx + brief;
    for (const el of $$("[data-summary]")) el.textContent = s;
    $("#draft-preview") && ($("#draft-preview").textContent = JSON.stringify(draft(), null, 2));
  };

  form.addEventListener("submit", (e) => {
    // A context window or point that is not a number: back to step 4, where it says why.
    const badW = ccNum(val("context_window")).bad, badP = ccNum(val("compact_at"), true).bad;
    if (badW || badP) { e.preventDefault(); go("where"); update(); form.elements[badW ? "context_window" : "compact_at"].focus(); return; }
    form.elements.draft.value = JSON.stringify(draft());
    form.elements.rig.value = choice.rig || "";
    if (e.submitter && e.submitter.name === "start") form.elements.start_value.value = e.submitter.value;
  });

  // A page sent back with mistakes keeps what was typed (the server echoes the draft).
  const back = form.dataset.draft ? JSON.parse(form.dataset.draft) : null;
  if (back) {
    const set = (n, v) => { if (form.elements[n] && v !== undefined && v !== null) form.elements[n].value = Array.isArray(v) ? v.join(n === "editable_paths" || n === "forbidden_patterns" || n === "links" ? "\\n" : " ") : v; };
    set("campaign", back.campaign); set("title", back.title); set("notes", back.notes); set("lanes", back.lanes); set("queue_target", back.queue_target);
    // The brief's lists, one box for each entry (goal 078).
    blFill("ideas", back.ideas); blFill("hypotheses", back.hypotheses);
    set("links", back.mode === "research" ? back.research && back.research.seeds : back.links);
    if (back.project) { set("project_access", back.project.access); set("project_url", back.project.url); set("project_ref", back.project.ref); set("project_folder", back.project.folder); set("editable_paths", back.project.editable_paths); set("forbidden_patterns", back.project.forbidden_patterns); }
    if (back.kit && back.kit.source === "here") { for (const k of ["build", "run", "check"]) set(k, back.kit[k]); set("outputs", back.kit.outputs); set("runs_per_case", back.kit.runs_per_case); }
    if (back.score) {
      set("score_field", back.score.field); set("score_unit", back.score.unit); set("direction", back.score.direction); set("min_effect", back.score.min_effect * 100);
      choice.score = back.score.kind || "time";
      $$('.ch[data-group="score"]').forEach((c) => c.classList.toggle("on", c.dataset.value === choice.score));
    }
    if (back.kit && back.kit.source === "repo") { set("kit_url", back.kit.url); set("kit_access", back.kit.access); set("kit_commit", back.kit.commit); set("kit_cells", back.kit.cells); set("held_out_repo", back.kit.held_out); if (back.score) set("repo_metric", back.score.name); }
    if (back.kit && back.kit.source) choice.kit = back.kit.source;
    if (back.kit && back.kit.source === "upload" && back.kit.upload) {
      fetch("/ui/campaigns/new/kit/" + encodeURIComponent(back.kit.upload), { credentials: "same-origin" })
        .then((r) => r.json().then((j) => ({ ok: r.ok, j })))
        .then(({ ok, j }) => {
          if (!ok) { $("#kit-archive-out").textContent = j.error || "Upload the kit again."; return; }
          $("#kit-archive-out").textContent = "Uploaded before and kept on control. Choose another archive to replace it.";
          // The servers as they were sent, those the page can't show among them.
          kitOwn = Array.isArray(back.mcp_servers) ? back.mcp_servers : j.mcp_servers || [];
          showKit(j, back.kit);
          if (back.score) { set("up_metric", back.score.name); set("up_direction", back.score.direction); set("up_min_effect", back.score.min_effect * 100); }
          update();
        })
        .catch(() => {});
    }
    if (back.agents_context) { set("context_window", back.agents_context.context_window); set("compact_at", back.agents_context.compact_at); }
    if (back.research) { set("topic", back.research.topic); blFill("questions", back.research.questions); set("min_duration", back.research.min_duration); set("min_verified_claims", back.research.min_verified_claims); }
    $$('.ch[data-group="mode"]').forEach((c) => { c.classList.toggle("on", c.dataset.value === back.mode); });
    choice.mode = back.mode;
    // The MCP servers as they were chosen (a kit in a repository: as its kit.json named them).
    if (back.kit && back.kit.source === "repo") repoKit = Array.isArray(back.mcp_servers) ? { key: back.kit.url + "@" + back.kit.commit, list: back.mcp_servers, said: "" } : repoKit;
    else restoreMcp(blockOf(back.mode === "research" ? "r" : "k"), back.mcp_servers);
  }
  go(form.dataset.step || "aim");
  update();
})();
`;
