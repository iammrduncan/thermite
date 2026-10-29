import { NAME_PATTERN, NAME_WORDS, RIG_CHECK_PREFIX } from "../../../../core/ids.ts";
import { CC_CORE_JS } from "../context/index.ts";

/**
 * The Copy panel's script (goal 069), served from control (/ui/assets/copy.js; no inline script
 * runs under the dashboard's CSP). It checks the copy's name as you type, in control's words,
 * and offers a fixed name for one that is not valid; for a research campaign it keeps the MCP
 * servers' rows, their summary and "Use the servers of … again" in step; it shows the same
 * request over REST, MCP and the command line; and it turns Copy off until the copy can be made.
 * The form posts as it does without this script. Campaign and server names become DOM text
 * nodes only, never markup.
 */

/**
 * The panel's parts that touch no page, also run by the tests (tests/control/ui/campaigns/copy/client.test.ts):
 * - `nameCheck(value, taken, folderOnly)`: what the name field says, as control answers:
 *   `{ok, cls, say, fix}`, where `fix` is a valid, free name to offer for one that is not valid;
 * - `sameUses(a, b)`: whether two lists of servers are the same, as control compares them;
 * - `perAgent(uses, kinds, total)`: each kind of agent's tools, in words;
 * - `mcpProblems(uses)`: what stops the copy: a server with no agent, a kind with no tool.
 */
export const COPY_CORE_JS = `
const NAME_RX = new RegExp(${JSON.stringify(NAME_PATTERN.source)});
const ALL_KINDS = ["workers", "planner", "advisors"];
const fixName = (v) => {
  const f = String(v).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[^a-z0-9]+/, "").replace(/-+$/, "").slice(0, 64);
  return NAME_RX.test(f) ? f : "";
};
// Control's own checks, in its order and its words (campaigns/copy.ts).
const nameCheck = (value, taken, folderOnly) => {
  const v = String(value).trim();
  if (!v) return { ok: false, cls: "", say: "Write a name for the copy.", fix: "" };
  if (!NAME_RX.test(v)) {
    const f = fixName(v);
    return { ok: false, cls: "bad", say: "A campaign's name is ${NAME_WORDS}.", fix: f && !taken.includes(f) && !f.startsWith(${JSON.stringify(RIG_CHECK_PREFIX)}) ? f : "" };
  }
  if (v.startsWith(${JSON.stringify(RIG_CHECK_PREFIX)})) return { ok: false, cls: "bad", say: "A name that starts with ${RIG_CHECK_PREFIX} is for rig checks. Choose another name.", fix: "" };
  if (taken.includes(v)) return { ok: false, cls: "bad", say: "There is a campaign named " + v + " already." + (folderOnly.includes(v) ? " It has no runs now, but its collection is in the knowledge base." : "") + " Choose another name.", fix: "" };
  return { ok: true, cls: "ok", say: "✓ Free. Its runs are named " + v + "-1, " + v + "-2, and so on.", fix: "" };
};
// As canonicalUses: by name, each with its kinds and its narrowed tools in one order.
const canonUses = (uses) => JSON.stringify(uses.map((u) => [u.name, ALL_KINDS.filter((k) => u.agents.includes(k)), ALL_KINDS.filter((k) => u.tools && u.tools[k]).map((k) => [k, [...u.tools[k]].sort()])]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)));
const sameUses = (a, b) => canonUses(a) === canonUses(b);
const andList = (xs) => (xs.length > 1 ? xs.slice(0, -1).join(", ") + " and " + xs[xs.length - 1] : xs[0] || "");
// "The workers get 9 tools from gbrain (6 of 31) and paper-search; the advisors get none."
const perAgent = (uses, kinds, total) => {
  const t = kinds.map((k) => {
    const s = uses.filter((u) => u.agents.includes(k));
    if (!s.length) return "the " + k + " get none";
    const n = s.reduce((a, u) => a + (u.tools && u.tools[k] ? u.tools[k].length : total[u.name] || 0), 0);
    return "the " + k + " get " + n + " tool" + (n === 1 ? "" : "s") + " from " + andList(s.map((u) => u.name + (u.tools && u.tools[k] ? " (" + u.tools[k].length + " of " + (total[u.name] || 0) + ")" : "")));
  }).join("; ") + ".";
  return t.charAt(0).toUpperCase() + t.slice(1);
};
const mcpProblems = (uses) => {
  const out = [];
  for (const u of uses) {
    if (!u.agents.length) out.push("Choose the agents that get " + u.name + ", or untick it.");
    for (const k of u.agents) if (u.tools && u.tools[k] && !u.tools[k].length) out.push("The " + k + " get no tool of " + u.name + ": give them one, or untick " + k + ".");
  }
  return out;
};`;

export const COPY_JS = `
(() => {
  "use strict";
  ${COPY_CORE_JS}
  ${CC_CORE_JS}
  const form = document.querySelector("form[data-copy]");
  if (!form) return;
  const $ = (s, r = form) => r.querySelector(s);
  const $$ = (s, r = form) => [...r.querySelectorAll(s)];
  let d;
  try { d = JSON.parse(form.dataset.copy || "{}"); } catch { return; }
  const taken = d.taken || [], folderOnly = d.folderOnly || [], source = d.source || [];
  const KINDS = ["workers", "advisors"];
  const nameIn = $("[data-c-name]"), say = $("[data-c-name-say]"), go = $("[data-c-go]"), sum = $("[data-c-sum]");
  const pick = $("[data-c-mcp]"), mcpSum = $("[data-c-mcp-sum]"), reset = $("[data-c-mcp-reset]");
  const cc = $('[data-cc="copy"]'), ccSay = cc ? $("[data-cc-say]", cc) : null;
  const rows = () => (pick ? $$(".sopt[data-srv]", pick) : []);
  const total = {};
  for (const o of rows()) total[o.dataset.srv] = Number(o.dataset.tools || 0);
  const ownOf = (name) => source.find((u) => u.name === name);
  // The servers ticked now, as the server reads the form (postedUses): what the rows can't show
  // (the planner, the tools of a server whose tools are not read) stays as the source has it.
  const picked = () => rows().filter((o) => $("[data-srv-on]", o).checked).map((o) => {
    const own = ownOf(o.dataset.srv);
    const agents = ["workers", "planner", "advisors"].filter((k) => (k === "planner" ? !!own && own.agents.includes(k) : !!$('[data-who="' + k + '"]:checked', o)));
    const trs = $$("tr[data-tool]", o);
    const tools = {};
    for (const k of agents) {
      if (k === "planner" || !trs.length) { if (own && own.tools && own.tools[k]) tools[k] = own.tools[k].slice(); continue; }
      const on = trs.filter((tr) => $('[data-tool-who="' + k + '"]', tr).checked).map((tr) => tr.dataset.tool);
      if (on.length < trs.length) tools[k] = on;
    }
    return Object.keys(tools).length ? { name: o.dataset.srv, agents, tools } : { name: o.dataset.srv, agents };
  });
  // Ticks the rows as a list says ("Use the servers of … again").
  const restore = (list) => {
    for (const o of rows()) {
      const u = list.find((x) => x.name === o.dataset.srv);
      $("[data-srv-on]", o).checked = !!u;
      for (const k of KINDS) { const w = $('[data-who="' + k + '"]', o); if (w) w.checked = !!u && u.agents.includes(k); }
      for (const tr of $$("tr[data-tool]", o))
        for (const k of KINDS) {
          const only = u && u.tools && u.tools[k];
          const c = $('[data-tool-who="' + k + '"]', tr);
          if (c) c.checked = !only || only.includes(tr.dataset.tool);
        }
      const adv = $(".mcp-adv", o);
      if (adv) adv.open = false;
    }
  };
  const line = (cls, text) => { const s = document.createElement(cls === "bad" ? "b" : "span"); if (cls) s.className = cls; s.textContent = text; return s; };
  const draw = () => {
    // The copy's name.
    const n = nameCheck(nameIn.value, taken, folderOnly);
    nameIn.classList.toggle("bad", n.cls === "bad");
    say.className = "cp-say" + (n.cls ? " " + n.cls : "");
    say.replaceChildren(n.say);
    if (n.fix) {
      const b = document.createElement("button");
      b.type = "button"; b.className = "sm"; b.dataset.cFix = n.fix; b.textContent = "Use " + n.fix;
      say.append(" ", b);
    }
    // A research copy's servers.
    let uses = null, problems = [], changed = false;
    if (pick) {
      for (const o of rows()) {
        const on = $("[data-srv-on]", o).checked;
        $(".mcp-who", o).classList.toggle("off", !on);
        for (const x of $$("input[data-tool-who]", o)) {
          const w = $('[data-who="' + x.dataset.toolWho + '"]', o);
          x.disabled = !on || !w || !w.checked;
        }
      }
      uses = picked();
      problems = mcpProblems(uses);
      changed = !sameUses(uses, source);
      const lines = [line("", uses.length ? perAgent(uses, KINDS, total) : "No MCP server: the copy's agents have only Thermite's own tools.")];
      if (changed) {
        const s = document.createElement("span"), b = document.createElement("b");
        b.className = "warn"; b.textContent = "Not as " + d.from + ".";
        s.append(b, " The copy's contract names these servers, so its hash is its own. Its page says that its servers are not its source's.");
        lines.push(s);
      } else lines.push(line("ok", "✓ The same as " + d.from + "."));
      for (const p of problems) lines.push(line("bad", p));
      for (const u of uses) {
        const o = rows().find((r) => r.dataset.srv === u.name);
        if (o && o.dataset.missing === "1") lines.push(line("warn", u.name + " is not in Settings: add it in Settings › MCP servers, or untick it."));
        else if (o && o.dataset.bad === "1") lines.push(line("warn", u.name + " doesn't work now: fix it in Settings, or the agents go on without it."));
      }
      mcpSum.replaceChildren(...lines);
      if (reset) reset.hidden = !changed;
    }
    // The copy's Agents' context (goal 070): as the source's, or its own.
    let ctxErrs = [], ctxOwn = null;
    if (cc) {
      const s = ccRead($("[data-cc-cw]", cc).value, $("[data-cc-ca]", cc).value);
      $("[data-cc-cw]", cc).classList.toggle("bad", s.cwBad);
      $("[data-cc-ca]", cc).classList.toggle("bad", s.atBad);
      ctxErrs = s.errs;
      const src = d.context || { cw: null, at: null };
      const same = !s.errs.length && s.cw === src.cw && s.at === src.at;
      if (!s.errs.length && !same) ctxOwn = { cw: s.cw, at: s.at };
      ccSay.className = "cc-say" + (s.errs.length ? " bad" : same ? " ok" : " warn");
      ccSay.textContent = s.errs.length ? s.errs.join(" ") : same ? "✓ As " + d.from + "." : "Not as " + d.from + ": " + ccShort(s) + ".";
    }
    // The same request over REST, MCP and the command line.
    const name = nameIn.value.trim() || "NAME";
    const body = changed ? { name, mcp_servers: uses } : { name };
    if (ctxOwn) body.agents_context = ctxOwn.cw || ctxOwn.at ? Object.assign({}, ctxOwn.cw ? { context_window: ctxOwn.cw } : {}, ctxOwn.at ? { compact_at: ctxOwn.at } : {}) : null;
    $("[data-c-json]").textContent = "POST /v1/campaigns/" + d.from + "/copy\\n" + JSON.stringify(body, null, 2);
    $("[data-c-cli]").textContent = "Command line: thermite campaign copy " + d.from + " " + name + (changed ? " --mcp-servers-json servers.json" : "") + (ctxOwn && ctxOwn.cw ? " --context-window " + ctxOwn.cw : "") + (ctxOwn && ctxOwn.at ? " --compact-at " + ctxOwn.at : "") + ". MCP: copy_campaign, with from: " + d.from + "." + (ctxOwn && !ctxOwn.cw && !ctxOwn.at ? " The command line can't remove the context: use REST or MCP." : "");
    const ok = n.ok && !problems.length && !ctxErrs.length;
    go.disabled = !ok;
    go.textContent = "Copy";
    sum.textContent = ok ? "Copies " + d.what + ": the same contract" + (d.research ? "" : " and kit") + ", with the new name. No runs yet." : !n.ok ? "Choose a free name." : problems.length ? "Fix the MCP servers first." : "Fix the agents' context first.";
  };
  form.addEventListener("input", draw);
  form.addEventListener("change", (e) => {
    // A server just ticked goes to the workers until other agents are chosen.
    const s = e.target.closest && e.target.closest("[data-srv-on]");
    if (s && s.checked) { const o = s.closest(".sopt"); if (!$("[data-who]:checked", o)) { const w = $('[data-who="workers"]', o); if (w) w.checked = true; } }
    draw();
  });
  form.addEventListener("click", (e) => {
    const fix = e.target.closest && e.target.closest("[data-c-fix]");
    if (fix) { e.preventDefault(); nameIn.value = fix.dataset.cFix; draw(); nameIn.focus(); return; }
    if (e.target.closest && e.target.closest("[data-c-mcp-reset]")) { e.preventDefault(); restore(source); draw(); }
  });
  form.addEventListener("submit", (e) => {
    if (go.disabled) { e.preventDefault(); return; }
    go.textContent = "Copying…";
    sum.textContent = "Control checks the contract with the new name and saves it as version 1 of " + nameIn.value.trim() + ".";
  });
  // Back to this page from the copy's: the panel as it was, with Copy again.
  window.addEventListener("pageshow", draw);
  draw();
})();
`;
