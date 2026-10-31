/**
 * The dashboard's buttons that send something to a rig, in the browser (goal 080): a click says at
 * once that it took, then the page follows the action to its outcome, with no refresh.
 *
 * - A form that posts to /ui/commands, or has data-act, is sent with fetch. Its button turns into
 *   a disabled "Sending…". Control answers JSON: a Progress (command-progress.ts) with `follow`,
 *   the route that says how the action stands. A refusal comes back in words, and the button
 *   comes back.
 * - The page asks each follow route every 2 seconds (every 5 after two minutes). An element that
 *   waits for a rig names its own route (data-follow, with data-follow-state), so the page follows
 *   it from the start too.
 * - When a state changes, the page fetches itself again and draws its parts anew: the header, the
 *   status bar and each [data-part]. A part the owner is typing in waits until they leave it.
 * - `said` shows beside the form, or at the top of the page for a button in the header, an
 *   inline button, or a form that a redraw took away. Times in data-since count on each second.
 * - Start a run and Edit rig's Save post as before (the page they open follows the action), and
 *   their button says "Sending…" at once. A button with data-busy says that instead, such as the
 *   pod log's "Reading…"; a form with data-autoread is sent once as the page opens.
 *
 * FOLLOW_CORE_JS touches no page, and the tests run it as the browser does
 * (action-progress.test.ts). Without this script every form posts as before, and control answers
 * with a page that says "Sent".
 */
export const FOLLOW_CORE_JS = `
const fwElapsed = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return s + " s";
  const m = Math.floor(s / 60);
  if (m < 60) return m + " m " + (s % 60) + " s";
  return Math.floor(m / 60) + " h " + (m % 60) + " m";
};
// What the page does with a follow route's answer, given the one before: draw the parts again
// when the state changed, stop at the end (and load the page again when control says so), and
// what the button shows meanwhile.
const fwStep = (prev, a) => ({
  redraw: !prev || prev.state !== a.state,
  stop: !!a.final,
  reload: !!(a.final && a.reload),
  say: a.said || "",
  tone: a.tone || "",
  button: a.final ? "back" : "Sent",
});
// How long the page waits before it asks again.
const fwDelay = (followedMs) => (followedMs < 120000 ? 2000 : 5000);
// Control's answer to a form sent with fetch: a Progress, or a refusal in words. Control refuses
// in JSON (said); other refusals come as text, such as "refused: …" or a form token that ran out.
const fwAnswer = (status, text, signedOut) => {
  if (signedOut) return { state: "refused", final: true, tone: "bad", said: "Not sent: your session ended. Sign in again, then press the button again." };
  let a = null;
  try { a = JSON.parse(text); } catch {}
  if (a && typeof a === "object" && typeof a.state === "string") return a;
  let t = String((a && a.error) || text || "").trim().replace(/^refused:\\s*/, "");
  if (status === 403 && /form token/.test(t)) t = "This page is too old. Load it again, then press the button again.";
  if (!t) t = "Control answered " + status + ".";
  return { state: "refused", final: true, tone: "bad", said: "Not sent: " + t.charAt(0).toUpperCase() + t.slice(1) };
};`;

export const FOLLOW_JS = `
(() => {
  "use strict";
  ${FOLLOW_CORE_JS}
  const followed = new Map();
  const content = () => document.getElementById("content");

  // ---------------------------------------------------------- words beside a button, or at the top
  // The top of the page, or the place a page keeps for these words (data-fw-top, as on Live).
  const topLine = (url) => {
    const c = document.querySelector("[data-fw-top]") || content();
    if (!c) return null;
    let top = c.querySelector(":scope > .fw-top");
    if (!top) {
      top = document.createElement("div");
      top.className = "card sent-note fw-top";
      c.prepend(top);
    }
    let line = [...top.children].find((x) => x.dataset.fw === url);
    if (!line) {
      line = document.createElement("div");
      line.dataset.fw = url;
      top.append(line);
    }
    return line;
  };
  // The page's own place for the words (data-say) keeps its look; only the tone changes.
  const say = (o, url, text, tone) => {
    if (!text) return;
    let host = o.note && o.note.isConnected ? o.note : null;
    if (!host) {
      const f = o.form;
      if (f && f.isConnected && !f.closest(".topbar") && !f.classList.contains("inline")) {
        host = document.createElement("div");
        host.className = "fw-say";
        f.after(host);
      } else {
        host = topLine(url);
        if (host) host.className = "fw-line";
      }
      o.note = host;
    }
    if (!host) return;
    host.classList.remove("ok", "bad");
    if (tone) host.classList.add(tone);
    host.textContent = text;
  };
  const back = (o) => {
    if (o.btn && o.btn.isConnected) { o.btn.disabled = false; o.btn.innerHTML = o.label; }
  };

  // ---------------------------------------------------------- drawing the page's parts again
  // A part waits while the owner types in it or has a menu open in it.
  const busy = (el) => {
    const a = document.activeElement;
    if (a && el.contains(a) && a.matches("textarea, select, input:not([type=hidden]):not([type=checkbox]):not([type=radio])")) return true;
    for (const f of el.querySelectorAll("textarea, input:not([type=hidden])"))
      if (f.type === "checkbox" || f.type === "radio" ? f.checked !== f.defaultChecked : f.value !== f.defaultValue) return true;
    // A list's choice as the page came: the option marked selected, or else its first one.
    for (const s of el.querySelectorAll("select:not([multiple])")) {
      const opts = [...s.options];
      let d = -1;
      opts.forEach((x, i) => { if (x.defaultSelected) d = i; });
      if (d < 0) d = opts.findIndex((x) => !x.disabled);
      if (s.selectedIndex !== d) return true;
    }
    return !!el.querySelector("details.menu[open]");
  };
  const waiting = new Map();
  // A part drawn anew: it takes the place of the old one, and what in it waits is followed.
  const swap = (old, neu) => {
    if (!old) return;
    if (busy(old)) { waiting.set(old, neu); return; }
    waiting.delete(old);
    if (!neu) { old.remove(); return; }
    const n = document.importNode(neu, true);
    // What the owner opened stays open.
    for (const d of old.querySelectorAll("details[data-k][open]")) {
      const m = n.querySelector('details[data-k="' + CSS.escape(d.dataset.k) + '"]');
      if (m) m.open = true;
    }
    old.replaceWith(n);
    scan(n);
  };
  let drawing = null;
  let again = false;
  const redraw = async () => {
    if (drawing) { again = true; return drawing; }
    drawing = (async () => {
      try {
        const res = await fetch(location.href, { credentials: "same-origin" });
        if (!res.ok || /\\/ui\\/login/.test(res.url)) return;
        const doc = new DOMParser().parseFromString(await res.text(), "text/html");
        swap(document.querySelector(".topbar"), doc.querySelector(".topbar"));
        swap(document.querySelector(".statusbar"), doc.querySelector(".statusbar"));
        for (const el of [...document.querySelectorAll("[data-part]")])
          swap(el, doc.querySelector('[data-part="' + CSS.escape(el.dataset.part) + '"]'));
      } catch {}
    })();
    await drawing;
    drawing = null;
    if (again) { again = false; await redraw(); }
  };

  // ---------------------------------------------------------- following an action to its end
  const apply = async (url, f, a) => {
    const st = fwStep(f.prev, a);
    f.prev = a;
    for (const o of f.from) {
      say(o, url, st.say, st.tone);
      if (!st.stop && o.btn && o.btn.isConnected) o.btn.textContent = st.button;
    }
    if (st.redraw) await redraw();
    if (st.stop) {
      followed.delete(url);
      for (const o of f.from) back(o);
      if (st.reload) location.reload();
      return;
    }
    f.next = Date.now() + fwDelay(Date.now() - f.since);
  };
  const track = (url, from, state) => {
    let f = followed.get(url);
    if (!f) {
      f = { prev: state ? { state } : null, since: Date.now(), next: Date.now() + fwDelay(0), from: [] };
      followed.set(url, f);
    }
    if (from) f.from.push(from);
    return f;
  };
  // What waits for a rig in the page as it came, and in each part drawn anew. An element with
  // data-say shows the follow's words in it (or in its own [data-say]).
  function scan(root) {
    const els = [...root.querySelectorAll("[data-follow]")];
    if (root.matches && root.matches("[data-follow]")) els.unshift(root);
    for (const el of els) {
      if (followed.has(el.dataset.follow)) continue;
      const note = el.hasAttribute("data-say") ? el.querySelector("[data-say]") || el : null;
      track(el.dataset.follow, note ? { form: null, btn: null, label: "", note } : null, el.dataset.followState || "");
    }
  }
  let asking = false;
  const poll = async () => {
    if (asking || document.visibilityState !== "visible") return;
    asking = true;
    try {
      for (const [url, f] of [...followed]) {
        if (Date.now() < f.next) continue;
        try {
          const res = await fetch(url, { credentials: "same-origin" });
          if (res.status === 404) { followed.delete(url); continue; }
          if (res.ok && !/\\/ui\\/login/.test(res.url)) await apply(url, f, await res.json());
          else f.next = Date.now() + 5000;
        } catch { f.next = Date.now() + 5000; }
      }
    } finally { asking = false; }
  };

  // ---------------------------------------------------------- a click on a button that sends
  const send = async (form, submitter) => {
    const btn = submitter || form.querySelector("button:not([type=button])");
    if (btn && btn.disabled) return;
    let body;
    try { body = new URLSearchParams(new FormData(form, submitter || undefined)); }
    catch { body = new URLSearchParams(new FormData(form)); }
    const o = { form, btn, label: btn ? btn.innerHTML : "", note: null };
    if (btn) { btn.disabled = true; btn.textContent = btn.dataset.busy || "Sending…"; }
    let a;
    try {
      const res = await fetch(form.getAttribute("action"), { method: "POST", body, credentials: "same-origin", headers: { accept: "application/json" } });
      a = fwAnswer(res.status, await res.text(), /\\/ui\\/login/.test(res.url));
    } catch {
      a = { state: "refused", final: true, tone: "bad", said: "Not sent: control did not answer. Try again." };
    }
    if (!a.follow || a.final) {
      say(o, a.follow || "form:" + form.getAttribute("action"), a.said, a.tone);
      back(o);
      if (a.follow) await redraw();
      return;
    }
    // What was typed went with it; a menu it came from closes.
    form.reset();
    for (const t of form.querySelectorAll("textarea")) t.dispatchEvent(new Event("input", { bubbles: true }));
    const menu = form.closest("details.menu");
    if (menu) menu.open = false;
    const f = track(a.follow, o, "");
    await apply(a.follow, f, a);
  };
  document.addEventListener("submit", (ev) => {
    const form = ev.target;
    if (!(form instanceof HTMLFormElement) || ev.defaultPrevented) return;
    if (form.getAttribute("action") !== "/ui/commands" && !form.hasAttribute("data-act")) return;
    ev.preventDefault();
    send(form, ev.submitter);
  });
  // A form that leaves the page (Start a run, Edit rig's Save): its button says at once that the
  // click took, once the browser has taken the form's fields. Back in the history, it comes back.
  document.addEventListener("submit", (ev) => {
    const form = ev.target;
    if (!(form instanceof HTMLFormElement) || ev.defaultPrevented || !form.matches("form[data-start], form#edit-rig")) return;
    const btn = ev.submitter || form.querySelector("button:not([type=button])");
    if (!btn) return;
    btn.dataset.fwLabel = btn.innerHTML;
    setTimeout(() => { btn.disabled = true; btn.textContent = "Sending…"; }, 0);
  });
  window.addEventListener("pageshow", (ev) => {
    if (!ev.persisted) return;
    for (const b of document.querySelectorAll("button[data-fw-label]")) {
      b.disabled = false;
      b.innerHTML = b.dataset.fwLabel;
      delete b.dataset.fwLabel;
    }
  });
  // An action the page's other script sent itself (a queue item dragged to its place).
  document.addEventListener("fw:follow", (ev) => {
    const a = ev.detail;
    if (!a || typeof a.state !== "string") return;
    const o = { form: null, btn: null, label: "", note: null };
    if (!a.follow || a.final) { say(o, a.follow || "form:drag", a.said, a.tone); return; }
    apply(a.follow, track(a.follow, o, ""), a);
  });

  // ---------------------------------------------------------- each second: times, and waiting parts
  setInterval(() => {
    for (const [o, n] of [...waiting]) if (!o.isConnected) waiting.delete(o); else if (!busy(o)) swap(o, n);
    const now = Date.now();
    for (const el of document.querySelectorAll("[data-since]")) {
      const t = Date.parse(el.dataset.since);
      if (t) el.textContent = fwElapsed(now - t);
    }
    poll();
  }, 1000);
  scan(document);
  // A block read on demand that has nothing to show yet reads once as the page opens (a RunPod
  // rig's pod log before the rig reports).
  for (const f of document.querySelectorAll("form[data-act][data-autoread]")) send(f, null);
})();
`;
