/**
 * A campaign's Agents' context in the browser (goal 070). CC_CORE_JS is the part that touches no
 * page, shared by the campaign's page, the Copy panel and New campaign, and run by the tests as
 * the browser runs it (tests/control/ui/campaigns/context.test.ts):
 * - `ccRead(windowText, pointText)`: the two fields as typed, `{cw, at, errs}` (null: empty), with
 *   control's words for a value it refuses (agentsContextRefusal);
 * - `ccApply(own, c)`: what a rig's workers get with the numbers, and the model that refuses a
 *   run there, as campaigns/context.ts's rigContext says it;
 * - `ccShort(c)`: the numbers in a few words, such as "131,072 tokens at 70%".
 *
 * CAMPAIGN_CONTEXT_JS is the campaign page's script (/ui/assets/campaign-context.js): it checks the
 * fields as you type, keeps "What applies on each rig", the request over REST, MCP and the command
 * line and the line beside Save in step, and turns Save off while nothing changes or a field is
 * refused. The form posts as it does without the script. Names become DOM text only.
 */
export const CC_CORE_JS = `
const CC_MIN = 4096, CC_MAX = 100000000, CC_AT_MIN = 50, CC_AT_MAX = 95, CC_AT_DEF = 80;
const ccFmt = (n) => Number(n).toLocaleString("en-US");
const ccNum = (s, pct) => {
  let t = String(s == null ? "" : s).trim().replace(/[,_\\s]/g, "");
  if (pct) t = t.replace(/%$/, "");
  return !t ? { empty: true } : /^\\d+$/.test(t) ? { n: Number(t) } : { bad: true };
};
const ccRead = (cwText, atText) => {
  const out = { cw: null, at: null, errs: [], cwBad: false, atBad: false };
  const w = ccNum(cwText);
  if (w.bad) { out.errs.push("Write the number of tokens in digits, such as 131072."); out.cwBad = true; }
  else if (!w.empty && (w.n < CC_MIN || w.n > CC_MAX)) { out.errs.push("A context window is a whole number of tokens from 4,096 to 100,000,000."); out.cwBad = true; }
  else if (!w.empty) out.cw = w.n;
  const a = ccNum(atText, true);
  if (a.bad || (!a.empty && (a.n < CC_AT_MIN || a.n > CC_AT_MAX))) { out.errs.push("The compaction point is a whole percent of the context window, from 50 to 95."); out.atBad = true; }
  else if (!a.empty) out.at = a.n;
  return out;
};
const ccApply = (own, c) => {
  const w = own.find((a) => a.agent === "workers");
  const rigWindow = w ? (w.cap && (w.listed <= 0 || w.cap < w.listed) ? w.cap : w.listed) : 0;
  const fromCampaign = !!(c.cw && (rigWindow <= 0 || c.cw <= rigWindow));
  const by = c.cw ? own.find((a) => a.listed > 0 && c.cw > a.listed) : undefined;
  return {
    window: fromCampaign ? c.cw : rigWindow || null,
    windowFrom: fromCampaign ? "campaign" : rigWindow ? "rig" : "none",
    at: c.at || (w ? w.at || CC_AT_DEF : null),
    atFrom: c.at ? "campaign" : w ? "rig" : "none",
    refused: by ? { model: by.model, listed: by.listed } : null,
  };
};
const ccShort = (c) => (c.cw && c.at ? ccFmt(c.cw) + " tokens at " + c.at + "%" : c.cw ? ccFmt(c.cw) + " tokens" : c.at ? "compact at " + c.at + "%" : "the rig's");
// A number in a cell, bold where it is the campaign's: as DOM nodes.
const ccCell = (value, campaign, unit) => {
  if (value === null) { const s = document.createElement("span"); s.className = "muted"; s.textContent = "the rig's"; return s; }
  const t = (unit === "%" ? value + "%" : ccFmt(value));
  if (!campaign) return document.createTextNode(t);
  const b = document.createElement("b"); b.textContent = t; return b;
};`;

export const CAMPAIGN_CONTEXT_JS = `
(() => {
  "use strict";
  ${CC_CORE_JS}
  const form = document.querySelector("form[data-cc-page]");
  if (!form) return;
  let d;
  try { d = JSON.parse(form.dataset.ccPage || "{}"); } catch { return; }
  const $ = (s) => form.querySelector(s);
  const cwIn = $("[data-cc-cw]"), atIn = $("[data-cc-ca]"), say = $("[data-cc-say]"), rows = $("[data-cc-rigs]");
  const save = $("[data-cc-save]"), chg = $("[data-cc-chg]"), json = $("[data-cc-json]"), cli = $("[data-cc-cli]");
  const saved = d.saved || { cw: null, at: null };
  const row = (rig, r) => {
    const tr = document.createElement("tr");
    tr.dataset.ccRow = rig;
    const td = (child, cls) => { const x = document.createElement("td"); if (cls) x.className = cls; x.append(child); tr.append(x); };
    const name = document.createElement("b"); name.textContent = rig; td(name);
    const st = document.createElement("span");
    if (r.refused) {
      tr.className = "bad";
      td("—", "num"); td("—", "num");
      st.className = "cc-st bad"; st.textContent = "can't start: " + r.refused.model + " takes at most " + ccFmt(r.refused.listed);
    } else {
      td(ccCell(r.window, r.windowFrom === "campaign", ""), "num");
      td(ccCell(r.at, r.atFrom === "campaign", "%"), "num");
      st.className = "cc-st ok"; st.textContent = "ok";
    }
    td(st);
    return tr;
  };
  const draw = () => {
    const s = ccRead(cwIn.value, atIn.value);
    cwIn.classList.toggle("bad", s.cwBad);
    atIn.classList.toggle("bad", s.atBad);
    say.className = "cc-say" + (s.errs.length ? " bad" : "");
    say.textContent = s.errs.join(" ");
    const c = s.errs.length ? saved : s;
    if (rows) rows.replaceChildren(...(d.rigs || []).map((r) => row(r.id, ccApply(r.own, c))));
    const body = {};
    if (s.cw) body.context_window = s.cw;
    if (s.at) body.compact_at = s.at;
    json.textContent = "POST /v1/campaigns/" + d.campaign + "/context\\n" + JSON.stringify(body, null, 2);
    cli.textContent = "Command line: thermite campaign context " + d.campaign + (s.cw ? " --context-window " + s.cw : "") + (s.at ? " --compact-at " + s.at : "") + ". MCP: set_campaign_context, with campaign: " + d.campaign + ". Without a number: the rig's.";
    const out = [];
    if (!s.errs.length) {
      if (s.cw !== saved.cw) out.push(!saved.cw ? "You set the window: " + ccFmt(s.cw) + " tokens." : !s.cw ? "You remove the window: each rig's applies." : "You change the window from " + ccFmt(saved.cw) + " to " + ccFmt(s.cw) + " tokens.");
      if (s.at !== saved.at) out.push(!saved.at ? "You set Compact at: " + s.at + "%." : !s.at ? "You remove Compact at: each rig's applies." : "You change Compact at from " + saved.at + "% to " + s.at + "%.");
      if (out.length) out.push("New runs take it.");
    }
    chg.textContent = s.errs.length ? "Not saved yet: fix the fields first." : out.length ? out.join(" ") : "Nothing changes.";
    chg.classList.toggle("bad", !!s.errs.length);
    save.disabled = !!s.errs.length || !out.length;
  };
  form.addEventListener("input", draw);
  form.addEventListener("submit", (e) => { if (save.disabled) e.preventDefault(); });
  draw();
})();
`;
