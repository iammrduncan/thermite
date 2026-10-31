import { judgeGpusByDefault } from "../../../../core/hardware.ts";

/**
 * The Edit rig page's script, served from control (/ui/assets/edit-rig.js; no inline script runs
 * under the dashboard's CSP). It shows each switch's state and lists, in short sentences, what
 * Save changes. In "2 · The agents" (goals 070, 073 and 074) it keeps every line's Runs in, its
 * Context cell and its refusals in step with its model, as control checks them: a harness that
 * cannot run the model, a window above the model's or outside 4,096 to 100,000,000 tokens, a
 * compaction point outside 50 to 95. It shows and hides the second teacher and its merged by
 * line, says in the two fields' info icons what the line's harness does at the compaction point,
 * and counts the agents on each subscription. Save is off while a line is refused. A line with no
 * model shows, and its sentences say, what its agent uses then: the words the page gives each
 * line (data-fb-ctx, data-fb-say, data-fb-off; goal 074). The synthesizer and the final writer with
 * no model follow the Teachers line (data-follows, data-fb-runs; goal 166), as the planner follows
 * the workers. For a rig control set up on a cluster
 * (goal 118), its GPUs, CPUs and memory are said with the restart of its pods (data-moves,
 * data-moves-say), and GPUs for the judge follows a new number of GPUs. Without the script the
 * form still posts, and control checks the same.
 */
export const EDIT_RIG_JS = `
(() => {
  "use strict";
  const form = document.getElementById("edit-rig");
  if (!form) return;
  const $ = (s, r = form) => r.querySelector(s);
  const $$ = (s, r = form) => [...r.querySelectorAll(s)];
  const table = $("[data-agents]");
  const inTable = (el) => !!table && table.contains(el);
  const after = (el) => !!table && !!(table.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);

  // ---------------------------------------------------------------- parts, numbers and choices
  const start = new Map();
  for (const el of form.elements) if (el.name && !inTable(el)) start.set(el, el.type === "checkbox" || el.type === "radio" ? el.checked : el.value);
  const label = (el) => {
    if (el.dataset.label) return el.dataset.label;
    const lb = el.closest(".fd") && el.closest(".fd").querySelector(".lb");
    return lb ? lb.firstChild.textContent.trim().toLowerCase() : el.name;
  };
  // A rig control set up on a cluster (goal 118): its GPUs, CPUs and memory. A new number of GPUs
  // takes GPUs for the judge as the judge's share of them: the field then fits the new number,
  // and hides for one GPU. Its pods restart with the change, said once.
  const gpusEl = $('[name="k_gpus"]');
  const judgeEl = $('[name="judge_gpus"]');
  const gpusMoved = () => !!gpusEl && gpusEl.value !== start.get(gpusEl);
  const fitJudge = () => {
    if (!gpusEl || !judgeEl) return;
    const n = Number(gpusEl.value), moved = gpusMoved();
    const field = judgeEl.closest("[data-judge-field]"), now = $("[data-judge-now]");
    if (!moved) { judgeEl.max = String(Math.min(8, Number(start.get(gpusEl)) - 1)); if (field) field.hidden = false; if (now) now.hidden = false; return; }
    if (!Number.isInteger(n) || n < 1) return;
    const top = Math.min(8, n - 1);
    judgeEl.max = String(Math.max(1, top));
    if (field) field.hidden = n < 2;
    if (now) now.hidden = true;
    const j = Number(judgeEl.value);
    if (n >= 2 && (!Number.isInteger(j) || j < 1 || j > top || n - j > 8)) judgeEl.value = String(Math.min(top, Math.max(n - 8, (${judgeGpusByDefault})(n))));
  };
  if (gpusEl) { gpusEl.addEventListener("input", fitJudge, true); gpusEl.addEventListener("change", fitJudge, true); }
  const general = (later) => {
    const out = [];
    let moves = false;
    for (const [el, was] of start) {
      if (after(el) !== later) continue;
      if (el.type === "checkbox" && el.dataset.part !== undefined) {
        const st = el.closest(".pt").querySelector(".pt-state");
        st.textContent = el.checked ? "on" : "off"; st.className = "pt-state " + (el.checked ? "on" : "off");
        if (el.checked !== was) out.push("You turn " + (el.checked ? "on" : "off") + " the " + el.dataset.name.toLowerCase() + ".");
      } else if (el.type === "radio") {
        if (el.checked && !was) out.push("You change when a change becomes the champion: " + el.closest("label").querySelector("b").textContent.toLowerCase() + ".");
      } else if (el.tagName === "SELECT" || el.type === "number") {
        // With a new number of GPUs, the judge's share is said with them.
        if (el === judgeEl && gpusMoved()) continue;
        if (el.value !== was) out.push("You change " + label(el) + " to " + (el.value === "" ? el.dataset.empty || "no limit" : el.options ? el.options[el.selectedIndex].textContent : el.value + (el.dataset.unit || "")) + ".");
        if (el.value !== was && el.dataset.restarts !== undefined) out.push("The rig's harness restarts to regroup its GPUs: running trials and judge jobs start again.");
        if (el.value !== was && el.dataset.moves !== undefined) moves = true;
      }
    }
    if (moves) {
      const n = gpusEl ? Number(gpusEl.value) : 0;
      if (gpusMoved() && n >= 2) {
        const j = judgeEl ? Number(judgeEl.value) : (${judgeGpusByDefault})(n);
        out.push("The judge gets " + j + " of the " + n + " GPUs, the agents " + (n - j) + (judgeEl ? "." : ": half each, rounded up for the judge."));
      }
      const say = $("[data-moves-say]");
      if (say) out.push(say.dataset.movesSay);
    }
    return out;
  };

  // ---------------------------------------------------------------- the agents
  const HN = { pi: "Pi", opencode: "OpenCode v2", "claude-code": "Claude Code", codex: "Codex" };
  const fmt = (n) => n.toLocaleString("en-US");
  const up = (t) => t.charAt(0).toUpperCase() + t.slice(1);
  const MIN = 4096, MAX = 100000000, AT_MIN = 50, AT_MAX = 95, AT_DEF = 80, CLAUDE_FLOOR = 100000, CODEX_LAST = 90;
  const num = (s, pct) => {
    let t = String(s).trim().replace(/[,_\\s]/g, "");
    if (pct) t = t.replace(/%$/, "");
    return !t ? { empty: true } : /^\\d+$/.test(t) ? { n: Number(t) } : { bad: true };
  };
  const optText = (sel) => (sel.selectedOptions[0] ? sel.selectedOptions[0].textContent : "");
  const escH = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  // What a line with no model uses, in a sentence: the page's words (goal 074).
  const modelSay = (x) => (x.m.value ? optText(x.m) : x.line.dataset.fbSay || optText(x.m));
  const effortSay = (x) => (x.e.value ? optText(x.e) : "the model's default");
  const R = {};
  for (const line of table ? $$("[data-line]", table) : []) {
    const id = line.dataset.line, p = $('[data-ctx="' + id + '"]');
    const r = { id, kind: line.dataset.kind, who: line.dataset.who, poss: line.dataset.poss, s: line.dataset.s, sub: line.dataset.sub || "", follows: line.dataset.follows || "" };
    const x = (R[id] = {
      r, line, p, m: $('[data-role="' + id + '"]'), e: $('[data-effort="' + id + '"]'), h: $('[data-runs-in="' + id + '"]'),
      sum: $('[data-ctx-sum="' + id + '"]'), say: $('[data-row-say="' + id + '"]'),
      cw: $("[data-cap]", p), ca: $("[data-at]", p), msg: $("[data-ctx-msg]", p), tips: p.querySelectorAll(".ii"),
    });
    // A line the page shows emptied (the second teacher's, after ×) says the model it had.
    x.model0 = x.m.dataset.was !== undefined ? x.m.dataset.was : x.m.value; x.e0 = x.e.value; x.h0 = x.h.value;
    x.cap0 = num(x.cw.value).n || null; x.at0 = num(x.ca.value, true).n || null;
  }
  if (!R.workers) {
    const say0 = () => { const out = [...general(false), ...general(true)]; const ul = document.getElementById("chg"); ul.replaceChildren(); for (const t of out.length ? out : ["Nothing changes."]) { const li = document.createElement("li"); li.textContent = t; ul.append(li); } document.getElementById("save").disabled = !out.length; };
    form.addEventListener("change", say0); form.addEventListener("input", say0); say0();
    return;
  }
  const SUBS = ["second_teacher", "merged_by"];
  const addLine = $("[data-t2-addline]");

  // The teachers: one, or two with a merged by model. With two, the first is teacher 1.
  let two = !R.second_teacher.line.hidden;
  const two0 = !!R.second_teacher.model0;
  const nameTeachers = () => {
    const t = R.teachers.r;
    t.who = two ? "teacher 1" : "the teacher";
    t.poss = two ? "teacher 1's" : "the teacher's";
    for (const id of ["teachers", ...SUBS]) {
      const x = R[id];
      x.m.dataset.label = x.r.poss + " model";
      x.m.setAttribute("aria-label", x.r.poss + " model");
      x.e.dataset.label = x.r.poss + " effort";
      x.h.dataset.label = "where " + x.r.who + " runs";
    }
  };
  const setTwo = (v) => {
    two = v;
    for (const id of SUBS) {
      const x = R[id];
      x.line.hidden = !v;
      if (!v) { x.m.value = ""; x.e.value = ""; x.h.value = ""; x.cw.value = ""; x.ca.value = ""; x.say.hidden = true; }
    }
    nameTeachers();
  };
  nameTeachers();

  // Runs in: what each harness can run, in control's words (rigs/model.ts's harnessRefusal).
  const harnessErr = (opt, h, r) => {
    const kind = opt.dataset.kind, codex = !!opt.dataset.codex;
    if (kind === "claude" && h !== "claude-code") return "A Claude subscription runs only in Claude Code: choose Claude Code for " + r.who + ", or another model.";
    if (h === "claude-code" && kind !== "claude") return "Claude Code runs only with a Claude subscription here: choose " + (codex ? "Pi, OpenCode v2 or Codex" : "Pi or OpenCode v2") + " for this provider.";
    if (h === "codex" && !codex) return "Codex runs only with a ChatGPT subscription or an OpenAI-compatible provider: choose Pi or OpenCode v2 for this provider.";
    if (h !== "opencode" && kind === "opencode") return "OpenCode's free models run only in OpenCode: choose OpenCode v2 for " + r.who + ", or another model.";
    return "";
  };
  // A model just chosen takes the harness it needs: a Claude subscription Claude Code, OpenCode's
  // own models OpenCode v2. In the capture phase, before the sentences, so that they say it. The
  // first teacher with no model (the advisors file's) takes the second teacher away.
  form.addEventListener("change", (e) => {
    const sel = e.target.closest && e.target.closest("[data-role]");
    if (!sel || !R[sel.dataset.role]) return;
    const x = R[sel.dataset.role], opt = sel.selectedOptions[0];
    if (!sel.value) {
      if (x.r.kind !== "workers") x.h.value = "";
      if (x.r.id === "teachers" && two) setTwo(false);
      return;
    }
    const kind = opt.dataset.kind;
    if (kind === "claude") x.h.value = "claude-code";
    else if (kind === "opencode") x.h.value = "opencode";
    else if (!x.h.value || harnessErr(opt, x.h.value, x.r)) x.h.value = x.h0 && !harnessErr(opt, x.h0, x.r) ? x.h0 : "pi";
  }, true);

  // What a line means now: its model, its harness, the cap and the point (null: none), errors.
  const state = (x) => {
    const r = x.r, opt = x.m.selectedOptions[0];
    const s = { x, model: "", listed: 0, h: x.h.value, hErr: "", cap: null, at: null, P: AT_DEF, win: 0, point: 0, errs: [], cwErr: "", caErr: "", same: false, off: "" };
    if (x.line.hidden) { s.off = "absent"; return s; }
    if (opt && opt.value) { s.model = opt.dataset.model; s.listed = Number(opt.dataset.window || 0); }
    if (!s.model) {
      if (r.sub === "teacher2") { s.off = "pick"; s.errs.push("Choose its model, or remove it."); return s; }
      s.off = r.kind === "workers" ? "own" : r.kind === "planner" ? "follows" : r.follows ? "teacher" : "default";
      return s;
    }
    s.hErr = harnessErr(opt, s.h, r);
    if (s.hErr) s.errs.push(s.hErr);
    const L = s.listed, p = num(x.cw.value);
    if (p.empty) {}
    else if (p.bad) s.cwErr = "Write the number of tokens in digits, such as 131072.";
    else if (p.n < MIN || p.n > MAX) s.cwErr = "A context window is a whole number of tokens from 4,096 to 100,000,000.";
    else if (L && p.n > L) s.cwErr = s.model + " takes at most " + fmt(L) + " tokens.";
    else if (L && p.n === L) s.same = true;
    else s.cap = p.n;
    if (s.cwErr) s.errs.push(s.cwErr);
    s.win = s.cap || L;
    const a = num(x.ca.value, true);
    if (a.empty) {}
    else if (a.bad || a.n < AT_MIN || a.n > AT_MAX) s.caErr = "The compaction point is a whole percent of the context window, from 50 to 95.";
    else if (a.n !== AT_DEF) s.at = a.n;
    if (s.caErr) s.errs.push(s.caErr);
    s.P = s.at || AT_DEF;
    s.point = s.win ? Math.floor((s.win * s.P) / 100) : 0;
    return s;
  };

  // What the line's harness does at the point: the words of the Compact at info icon.
  const harnessTip = (s) => {
    const r = s.x.r, W = s.win, T = s.point, P = s.P, adv = r.kind === "advisor";
    if (s.hErr) return "Fix Runs in first: " + s.hErr;
    const shows = adv ? "" : " History and Live show each compaction.";
    if (s.h === "pi") {
      if (!W) return r.kind === "workers" ? "In Pi, with no window, Thermite compacts only when the provider says the context is full." : "In Pi, with no window, Thermite does not compact " + (adv ? "the advisor's" : "the planner's") + " conversation. Type a window to have it compacted.";
      if (adv) return "In Pi, at " + fmt(T) + " tokens, Thermite keeps the whole conversation in the supervisor, with the advisor's round. Then the same model writes a summary, and " + r.who + " continue" + r.s + ". Live shows each compaction.";
      return "In Pi, at " + fmt(T) + " tokens, Thermite keeps the whole conversation in the run's research folder, as compactions/" + (r.kind === "workers" ? "<trial>" : "planner-<id>") + "-<n>.md. Then the same model writes a summary, and " + (r.kind === "workers" ? "the worker continues with it and its most recent turns" : "the planner continues its call") + "." + shows;
    }
    if (s.h === "opencode") return W ? "OpenCode v2 compacts on its own at " + fmt(T) + " tokens: Thermite gives it the window and tells it to keep " + fmt(W - T) + " tokens free." + shows : "OpenCode v2 compacts only when it knows the window, and the provider lists none. Type a window.";
    if (s.h === "codex") return "Codex compacts on its own" + (W ? " at " + fmt(Math.floor((W * Math.min(P, CODEX_LAST)) / 100)) + " tokens: at 90% of the window at the latest." : ", with its own window and point: the provider lists no window.") + shows;
    return "Claude Code compacts on its own at " + P + "% of the window, less the room it keeps for a reply. It counts a window below 100,000 tokens as 100,000." + shows;
  };
  const NEVER = {
    workers: "A trial never ends, and no worker is told to submit, because its conversation grew.",
    planner: "A planner call never ends because its conversation grew.",
    advisor: "An advisor's call never ends because its conversation grew.",
  };
  const winTip = (s) => {
    const r = s.x.r, L = s.listed;
    return (r.kind === "workers"
      ? "The most the workers' model reads in one request, in tokens: from 4,096 up to the provider's window. Use it to compare two models at the same window. When the planner follows the workers, it gets the same."
      : "The most " + r.poss + " model reads in one request, in tokens: from 4,096 up to the provider's window." + (r.kind === "advisor" ? " Thermite cuts what the advisor reads (recent trials and past research) to fit." : "")) +
      " Empty: " + (L ? "the provider's window, " + fmt(L) + " tokens." : "no window, as the provider lists none.") + " A campaign can set a smaller window for its runs.";
  };
  const atTip = (s) => "When " + s.x.r.poss + " conversation is compacted: a percent of the context window, from 50 to 95. Empty: 80, which leaves a fifth of the window for the summary and the next reply. " + harnessTip(s) + " " + NEVER[s.x.r.kind];
  // One short line under the two fields: an error, a warning, or where the conversation compacts.
  const msgOf = (s) => {
    if (s.hErr) return ["bad", "Fix Runs in first."];
    if (s.cwErr) return ["bad", s.cwErr];
    if (s.caErr) return ["bad", s.caErr];
    if (s.h === "opencode" && !s.win) return ["warn", "OpenCode v2 compacts only with a window."];
    if (s.h === "codex" && s.win && s.P > CODEX_LAST) return ["warn", "Codex compacts at 90% at the latest: " + fmt(Math.floor((s.win * CODEX_LAST) / 100)) + " tokens."];
    if (s.h === "claude-code" && s.win && s.win < CLAUDE_FLOOR) return ["warn", "Claude Code counts this window as 100,000 tokens."];
    if (s.same) return ["", "That is the provider's window: no cap."];
    return ["", s.win ? "It compacts at " + fmt(s.point) + " tokens." : "No window: the provider lists none."];
  };
  // The Context cell: the window and the point in short. Bold: set on this rig.
  const sumHtml = (s, S) => {
    if (s.off === "own" || s.off === "default") return '<span class="muted">' + escH(s.x.line.dataset.fbCtx || "") + "</span>";
    if (s.off === "pick" || s.off === "absent") return '<span class="muted">—</span>';
    if (s.off === "follows") {
      const w = S.workers;
      return '<span class="muted">as the workers' + (w.model && !w.cwErr && !w.caErr ? ": " + (w.win ? fmt(w.win) : "no window") + " · " + w.P + "%" : "") + "</span>";
    }
    // The first teacher's context; with no model on its line, the advisors file's first teacher.
    if (s.off === "teacher") {
      const t = S.teachers;
      if (!t.model) return '<span class="muted">' + escH(s.x.line.dataset.fbCtx || "") + "</span>";
      return '<span class="muted">as the first teacher' + (!t.cwErr && !t.caErr ? ": " + (t.win ? fmt(t.win) : "no window") + " · " + t.P + "%" : "") + "</span>";
    }
    if (s.cwErr || s.caErr) return '<span class="bad">✕ not valid</span>';
    const win = s.win ? fmt(s.win) : "no window";
    return (s.cap ? "<b>" + win + "</b>" : win) + " · " + (s.at ? "<b>" + s.P + "%</b>" : s.P + "%");
  };
  const draw = (x, s, S) => {
    const r = x.r, off = !!s.off;
    const first = x.h.querySelector('option[value=""]');
    if (first) {
      first.hidden = first.disabled = !off;
      if (r.kind === "planner") first.textContent = "as the workers" + (S.workers.model ? " (" + HN[S.workers.h] + ")" : "");
      if (r.follows) first.textContent = S.teachers.model ? "as the first teacher (" + HN[S.teachers.h] + ")" : x.line.dataset.fbRuns || "";
    }
    x.h.disabled = off;
    x.h.classList.toggle("bad", !!s.hErr);
    x.say.hidden = !s.hErr;
    x.say.textContent = s.hErr;
    x.p.classList.toggle("off", off);
    x.p.classList.toggle("ctx-bad", !off && !!(s.cwErr || s.caErr));
    if (off) x.p.open = false;
    x.sum.innerHTML = sumHtml(s, S);
    x.cw.disabled = x.ca.disabled = off;
    x.cw.classList.toggle("bad", !!s.cwErr);
    x.ca.classList.toggle("bad", !!s.caErr);
    x.cw.placeholder = s.listed ? fmt(s.listed) : "none";
    if (off) return;
    const [c, t] = msgOf(s);
    x.msg.className = "ctx-msg" + (c ? " " + c : "");
    x.msg.textContent = t;
    if (x.tips[0]) x.tips[0].dataset.tip = winTip(s);
    if (x.tips[1]) x.tips[1].dataset.tip = atTip(s);
  };

  // Each change to a line, in short sentences, for What changes when you save.
  const sentences = (s, S) => {
    const x = s.x, r = x.r, out = [];
    if (s.off === "absent" || s.off === "pick" || r.sub) return out;
    const newModel = x.m.value !== x.model0;
    if (newModel) out.push("You change " + r.poss + " model to " + modelSay(x) + ".");
    if (x.e.value !== x.e0) out.push("You change " + r.poss + " effort to " + effortSay(x) + ".");
    if (s.model && x.h.value !== x.h0) out.push("You change where " + r.who + " run" + r.s + " to " + HN[x.h.value] + ".");
    if (!s.model) {
      if (x.cap0 || x.at0) out.push("The context set for " + r.poss + " old model goes with it.");
      return out;
    }
    const capWas = newModel ? null : x.cap0, atWas = newModel ? null : x.at0;
    if (newModel && x.cap0 && !s.cap) out.push("The cap of " + fmt(x.cap0) + " tokens on " + r.poss + " context window goes with the old model.");
    if (newModel && x.at0 && !s.at) out.push("The compaction point of " + x.at0 + "% goes with the old model: " + r.who + " compact" + r.s + " at 80%.");
    const at = s.win ? " (" + fmt(s.point) + " tokens)" : "";
    let capSaid = "", atSaid = "";
    if (s.cap !== capWas) {
      if (s.cap && !capWas) capSaid = "You cap " + r.poss + " context window at " + fmt(s.cap) + " tokens; " + (s.listed ? (newModel ? s.model : "the provider") + " allows " + fmt(s.listed) + "." : "the provider lists no window.");
      else if (!s.cap) capSaid = "You remove the cap on " + r.poss + " context window: " + r.who + " get" + r.s + " " + (s.listed ? fmt(s.listed) + " tokens again." : "no window again.");
      else capSaid = "You change the cap on " + r.poss + " context window from " + fmt(capWas) + " to " + fmt(s.cap) + " tokens.";
    }
    if (s.at !== atWas) {
      if (s.at && !atWas) atSaid = up(r.who) + " compact" + r.s + " at " + s.at + "%" + at + ", not at 80%.";
      else if (!s.at) atSaid = up(r.who) + " compact" + r.s + " at 80% again" + at + ".";
      else atSaid = up(r.who) + " compact" + r.s + " at " + s.at + "%" + at + ", not at " + atWas + "%.";
    } else if (capSaid && s.win) capSaid += " " + up(r.who) + " compact" + r.s + " at " + fmt(s.point) + " tokens (" + s.P + "%).";
    if (r.kind === "workers" && (capSaid || atSaid) && S.planner.off) {
      if (atSaid) atSaid += " The planner follows the workers.";
      else capSaid += " The planner follows the workers.";
    }
    if (capSaid) out.push(capSaid);
    if (atSaid) out.push(atSaid);
    if (newModel && !x.model0 && r.kind !== "workers" && !capSaid && !atSaid)
      out.push(up(r.who) + " then " + (r.s ? "has" : "have") + " " + (r.s ? "its" : "their") + " own context: " + (s.listed ? fmt(s.listed) + " tokens" : "no window") + ", compacted at " + s.P + "%.");
    return out;
  };
  // The second teacher and the merged by model, said as one change where they can be.
  const subSentences = (S) => {
    const t2 = R.second_teacher, mb = R.merged_by, out = [];
    if (two0 && !two) return ["You remove the second teacher and its merged-by model."];
    if (!two) return mb.model0 && !mb.m.value ? ["You remove the merged-by model."] : out;
    if (!two0) {
      if (t2.m.value) out.push("You add a second teacher: " + optText(t2.m) + " in " + HN[t2.h.value] + ". " + (mb.m.value ? "The merged-by model joins the two teachers' suggestions: " + optText(mb.m) + " in " + HN[mb.h.value] : mb.line.dataset.fbOff ? "With no merged-by model, the first review that comes back is the set" : "The merged-by model joins the two teachers' suggestions: " + modelSay(mb)) + ".");
      return out;
    }
    for (const x of [t2, mb]) {
      if (x.m.value !== x.model0) out.push("You change " + x.r.poss + " model to " + modelSay(x) + ".");
      if (x.e.value !== x.e0) out.push("You change " + x.r.poss + " effort to " + effortSay(x) + ".");
      if (x.m.value && x.h.value !== x.h0) out.push("You change where " + x.r.who + " runs to " + HN[x.h.value] + ".");
      const s = S[x.r.id];
      if (!x.m.value || s.off) continue;
      const cap = x.m.value !== x.model0 ? null : x.cap0, at = x.m.value !== x.model0 ? null : x.at0;
      if (s.cap !== cap) out.push(s.cap ? "You cap " + x.r.poss + " context window at " + fmt(s.cap) + " tokens." : "You remove the cap on " + x.r.poss + " context window.");
      if (s.at !== at) out.push(up(x.r.who) + " compacts at " + s.P + "%.");
    }
    return out;
  };
  // The subscription call-out: each worker is one session, the review panel three.
  const share = () => {
    const lanes = Number((form.querySelector('[name="lanes"]') || {}).value) || 1;
    const kindOf = (x) => (!x.line.hidden && x.m.selectedOptions[0] && x.m.selectedOptions[0].dataset.kind) || "";
    const wKind = kindOf(R.workers);
    let claude = 0, chatgpt = 0;
    for (const id in R) {
      const x = R[id], kind = kindOf(x) || (id === "planner" ? wKind : x.r.follows ? kindOf(R.teachers) : "");
      const n = id === "workers" ? lanes : id === "review_panel" ? 3 : 1;
      if (kind === "claude") claude += n;
      if (kind === "chatgpt") chatgpt += n;
    }
    const el = document.getElementById("share");
    if (!el) return;
    const parts = [];
    if (claude) parts.push(claude + (claude === 1 ? " agent" : " agents") + " on a Claude subscription");
    if (chatgpt) parts.push(chatgpt + (chatgpt === 1 ? " agent" : " agents") + " on a ChatGPT subscription");
    el.hidden = !parts.length;
    el.textContent = parts.length ? "Up to " + parts.join(" and ") + " at once on this rig. When a plan is full, they wait." : "";
  };

  const all = () => { const S = {}; for (const id in R) S[id] = state(R[id]); return S; };
  const ul = document.getElementById("chg"), save = document.getElementById("save");
  const update = () => {
    const S = all();
    for (const id in R) draw(R[id], S[id], S);
    if (addLine) addLine.hidden = two || !R.teachers.m.value;
    share();
    const errs = [];
    for (const id in R) for (const e of S[id].errs) errs.push("Not saved yet (" + R[id].r.who + "): " + e);
    const said = [];
    if (!errs.length) {
      said.push(...general(false));
      for (const id of ["workers", "planner", "teachers"]) said.push(...sentences(S[id], S));
      said.push(...subSentences(S));
      for (const id of ["auditor", "review_panel", "synthesizer", "final_writer"]) if (R[id]) said.push(...sentences(S[id], S));
      said.push(...general(true));
      const movesSay = ($("[data-moves-say]") || { dataset: {} }).dataset.movesSay;
      if (said.length && said[said.length - 1] !== movesSay) said[said.length - 1] += " The rig takes it within a minute.";
    }
    ul.replaceChildren();
    for (const [cls, t] of errs.length ? errs.map((t) => ["bad", t]) : said.length ? said.map((t) => ["", t]) : [["", "Nothing changes."]]) {
      const li = document.createElement("li");
      if (cls) li.className = cls;
      li.textContent = t;
      ul.append(li);
    }
    save.disabled = !!errs.length || !said.length;
  };
  form.addEventListener("input", update);
  form.addEventListener("change", update);

  // A Context cell opens its line's fields, one line at a time; + second teacher and × add and
  // remove the second teacher's lines in place (their links do it without the script).
  const close = (but) => { for (const id in R) if (R[id] !== but) R[id].p.open = false; };
  for (const id in R) {
    const x = R[id];
    x.p.querySelector("summary").addEventListener("click", (e) => { if (x.p.classList.contains("off")) e.preventDefault(); });
    x.p.addEventListener("toggle", () => { if (x.p.open) { close(x); x.cw.focus(); } });
  }
  form.addEventListener("click", (e) => {
    const t = e.target.closest ? e.target : null;
    if (!t) return;
    if (t.closest("[data-t2-add]")) { e.preventDefault(); setTwo(true); update(); R.second_teacher.m.focus(); return; }
    if (t.closest("[data-t2-x]")) { e.preventDefault(); setTwo(false); update(); R.teachers.m.focus(); }
  });
  document.addEventListener("click", (e) => { if (!(e.target.closest && e.target.closest(".ctx-w"))) close(null); });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const o = Object.values(R).find((x) => x.p.open);
    if (o) { o.p.open = false; o.p.querySelector("summary").focus(); }
  });
  form.addEventListener("submit", (e) => { if (save.disabled) e.preventDefault(); });
  update();
})();
`;
