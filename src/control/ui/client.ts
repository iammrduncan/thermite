import { NAV_COOKIE } from "./components/index.ts";

/**
 * The dashboard's only script, served from control itself (CSP script-src 'self'; nothing inline
 * runs). It streams the live view, from control's push of new lines (server-sent events, on
 * connect-src 'self'); pages never reload by themselves. Each line comes formatted and escaped
 * from control (ui/live.ts); a line the script makes itself is built with DOM text nodes only.
 */
export const CLIENT_JS = `
(() => {
  "use strict";
  const $ = (s, r = document) => r.querySelector(s);
  // ------------------------------------------------ the live view
  const tr = $("#transcript");
  if (tr) {
    // Where the page's new lines come from (control's push of them), and whose they are.
    const lines = tr.dataset.stream || "", source = tr.dataset.source || "", run = tr.dataset.run || "";
    let after = Number(tr.dataset.after || "0");
    let follow = true;
    const near = () => tr.scrollHeight - tr.scrollTop - tr.clientHeight < 120;
    tr.scrollTop = tr.scrollHeight;
    // A run's page shows one filter at a time: everyone, a lane, the planner, the judge, the
    // advisors or the owner's own messages (data-who on each line).
    const shows = (el) => {
      const w = tr.dataset.w || "all";
      const who = (el.dataset.who || "").split(" ");
      return w === "all" || who.includes(w) || who.includes("all");
    };
    const filter = () => { for (const el of tr.children) if (el.dataset && el.dataset.who !== undefined) el.hidden = !shows(el); };
    if (run) filter();
    // Each line comes formatted from control (ui/live.ts, escaped there). A result joins the
    // tool call before it: on a run's page, the open call of its own source.
    const add = (e) => {
      const open = run
        ? [...tr.querySelectorAll('[data-src="' + CSS.escape(e.src || "") + '"] details[data-open]')].pop()
        : (tr.lastElementChild && tr.lastElementChild.querySelector("details[data-open]"));
      if (e.kind === "result" && e.join && open) {
        open.removeAttribute("data-open");
        const hint = open.querySelector(".lv-hint");
        if (hint) hint.insertAdjacentHTML("beforeend", e.join.hint);
        open.insertAdjacentHTML("beforeend", e.join.body);
        return;
      }
      const empty = tr.querySelector(".empty");
      if (empty) empty.remove();
      tr.insertAdjacentHTML("beforeend", e.html);
      const el = tr.lastElementChild;
      if (run && el && el.dataset && el.dataset.who !== undefined) {
        el.hidden = !shows(el);
        // A lane that started after the page was drawn gets its own filter, after the others.
        for (const l of el.dataset.who.split(" ").filter((t) => /^lane-\\d+$/.test(t))) {
          if (document.querySelector('.lchip[data-w="' + l + '"]')) continue;
          const lanes = [...document.querySelectorAll(".lchip[data-w^='lane-']")];
          const before = lanes.find((c) => Number(c.dataset.w.slice(5)) > Number(l.slice(5)))
            || document.querySelector('.lchip[data-w="planner"], .lchip[data-w="judge"], .lchip[data-w="advisors"]');
          const u = new URL(location.href);
          u.searchParams.set("w", l);
          const a = document.createElement("a");
          a.className = "lchip";
          a.dataset.w = l;
          a.href = u.pathname + u.search;
          a.textContent = l;
          if (before) before.before(a);
        }
      }
    };
    // New lines are pushed as control gets them. The browser connects again on its own after a
    // drop, and control goes on after the last line the page has (its last event's id).
    const q = new URLSearchParams({ after: String(after) });
    // Lines waiting for their event, drawn again once control has it.
    const waiting = run ? [...tr.querySelectorAll("[data-recheck]")].map((el) => el.dataset.id).filter(Boolean).slice(-50) : [];
    if (waiting.length) q.set("recheck", waiting.join(","));
    if (!run && source) q.set("source", source);
    const pushed = lines && window.EventSource ? new EventSource(lines + "?" + q) : null;
    const said = (ev) => { try { return JSON.parse(ev.data); } catch { return {}; } };
    const stamp = () => {
      const st = $("#live-state .sub");
      if (st) st.textContent = "live · " + new Date().toISOString().slice(11, 19) + " UTC";
    };
    if (pushed) {
      // The status bar says when the page last heard from control: a line, or a quiet beat.
      pushed.addEventListener("open", stamp);
      pushed.addEventListener("beat", stamp);
      pushed.addEventListener("lines", (ev) => {
        const body = said(ev);
        const stick = follow && near();
        for (const e of body.entries || []) { if (e.id <= after) continue; add(e); after = e.id; }
        if (stick && (body.entries || []).length) tr.scrollTop = tr.scrollHeight;
        stamp();
      });
      pushed.addEventListener("redrawn", (ev) => {
        for (const r of said(ev).redrawn || []) {
          const old = tr.querySelector('[data-id="' + r.id + '"]');
          if (!old) continue;
          old.insertAdjacentHTML("afterend", r.html);
          const el = old.nextElementSibling;
          old.remove();
          if (el && el.dataset && el.dataset.who !== undefined) el.hidden = !shows(el);
        }
      });
      // The page fell behind: it keeps what it shows, and says how many lines it did not get.
      pushed.addEventListener("missed", (ev) => {
        const n = Number(said(ev).lines) || 0;
        if (!n) return;
        const row = document.createElement("div");
        row.className = "lv-div lv-missed";
        if (run) row.dataset.who = "all";
        const text = document.createElement("span");
        text.textContent = n + (n === 1 ? " line is" : " lines are") + " not shown here: they came faster than this page could take them.";
        row.append(text);
        tr.append(row);
      });
    }

    // The filters and the message box go together: the lane you watch is the one you write to.
    const box = $("form.lcomposer");
    const sel = box && box.querySelector("select[name=to]");
    const ta = box && box.querySelector("textarea");
    const pin = box && box.querySelector(".lpin");
    const hint = () => {
      const o = sel && sel.selectedOptions[0];
      if (ta && o) ta.placeholder = (o.dataset.hint || "") + " · ⌘↩ sends";
      // Only messages to everyone working or a lane can stay in force.
      if (pin && sel) pin.hidden = !(sel.value === "all" || sel.value.startsWith("lane-"));
    };
    hint();
    const view = (w) => {
      tr.dataset.w = w;
      document.querySelectorAll(".lchip[data-w]").forEach((c) => c.classList.toggle("on", c.dataset.w === w));
      const wi = box && box.querySelector("input[name=w]");
      if (wi) wi.value = w;
      filter();
      const u = new URL(location.href);
      if (w === "all") u.searchParams.delete("w"); else u.searchParams.set("w", w);
      history.replaceState(null, "", u);
      tr.scrollTop = tr.scrollHeight;
    };
    // One handler for every filter, including those added for lanes that start later.
    document.addEventListener("click", (ev) => {
      const c = ev.target instanceof Element ? ev.target.closest(".lchip[data-w]") : null;
      if (!c) return;
      ev.preventDefault();
      const w = c.dataset.w;
      view(w);
      if (sel && w !== "judge" && w !== "you") {
        const opt = [...sel.options].find((o) => o.value === w && !o.disabled);
        if (opt) { sel.value = w; hint(); }
      }
    });
    if (sel) sel.addEventListener("change", () => {
      hint();
      const t = sel.value;
      const w = ["advisors", "teachers", "auditor", "review_panel"].includes(t) ? "advisors" : t;
      if (document.querySelector('.lchip[data-w="' + CSS.escape(w) + '"]')) view(w);
    });
    const fb = $(".lfollow");
    if (fb) fb.addEventListener("click", () => { follow = !follow; fb.classList.toggle("on", follow); fb.setAttribute("aria-pressed", String(follow)); if (follow) tr.scrollTop = tr.scrollHeight; });
    // On the document: the run's header is drawn again when an action's outcome comes (goal 080).
    const wrap = $("#lwrap");
    if (wrap) document.addEventListener("click", (ev) => {
      if (ev.target.closest && ev.target.closest(".lnav-btn")) wrap.classList.toggle(matchMedia("(max-width: 1180px)").matches ? "open" : "closed");
    });
    if (ta) {
      const grow = () => { ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight + 2, 160) + "px"; };
      ta.addEventListener("input", grow);
      ta.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); box.requestSubmit(); }
      });
    }
  }

  // ------------------------------------------------ info icons: a label's description on hover
  const tip = document.createElement("div");
  tip.id = "tip";
  document.body.appendChild(tip);
  const showTip = (el) => {
    tip.textContent = el.dataset.tip || "";
    tip.style.display = "block";
    const r = el.getBoundingClientRect();
    let x = Math.min(r.left - 8, window.innerWidth - tip.offsetWidth - 12);
    if (x < 12) x = 12;
    let y = r.bottom + 8;
    if (y + tip.offsetHeight > window.innerHeight - 8) y = r.top - tip.offsetHeight - 8;
    tip.style.left = x + "px";
    tip.style.top = y + "px";
  };
  const hideTip = () => (tip.style.display = "none");
  // A mark with its reason (.tipped, such as withdrawn evidence) shows it the same way.
  const tipped = (t) => t.closest && t.closest(".ii, .tipped");
  document.addEventListener("mouseover", (ev) => { const i = tipped(ev.target); if (i) showTip(i); });
  document.addEventListener("mouseout", (ev) => { if (tipped(ev.target)) hideTip(); });
  document.addEventListener("focusin", (ev) => { const i = tipped(ev.target); if (i) showTip(i); });
  document.addEventListener("focusout", hideTip);

  // ------------------------------------------------ panels: open in place, close with Esc
  // Links with data-open show the panel without a reload (they still work as links without
  // this script); data-close hides it again.
  document.addEventListener("click", (ev) => {
    const open = ev.target.closest && ev.target.closest("[data-open]");
    if (open) {
      const el = $(open.dataset.open);
      if (el) { ev.preventDefault(); el.hidden = false; const f = el.querySelector("input:not([type=hidden]):not([disabled]), select, textarea"); if (f) f.focus(); }
      return;
    }
    const close = ev.target.closest && ev.target.closest("[data-close]");
    if (close) { const w = close.closest(".drawer-wrap"); if (w) { ev.preventDefault(); w.hidden = true; } }
    // A link out of a panel to a part of the same page: the panel closes, the part shows.
    const to = ev.target.closest && ev.target.closest("[data-close-to]");
    const part = to && $(to.dataset.closeTo);
    if (part) {
      const w = to.closest(".drawer-wrap");
      if (w) { ev.preventDefault(); w.hidden = true; part.scrollIntoView({ block: "start" }); const f = part.querySelector("input:not([type=hidden])"); if (f) f.focus({ preventScroll: true }); }
    }
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") document.querySelectorAll(".drawer-wrap:not([hidden])").forEach((w) => (w.hidden = true));
  });

  // ------------------------------------------------ Start a run: the model pick and the summary
  const start = $("form[data-start]");
  if (start) {
    const sum = start.querySelector("[data-start-sum]");
    const pick = start.querySelector("[data-model-pick]");
    const line = start.querySelector("[data-model-line]");
    const update = () => {
      const rig = start.querySelector("input[name=rig]:checked");
      const agents = (start.querySelector("input[name=agents]:checked") || {}).value !== "off";
      const has = rig ? rig.dataset.model : "";
      const chosen = start.querySelector("select[name=agents_model]");
      const picked = chosen && chosen.value ? decodeURIComponent(chosen.value.split("|")[1] || "") : "";
      if (pick) pick.hidden = !agents || !!has;
      // Experiments to copy and past research are for agents: a try (agents off) has no queue and
      // no brief. Hidden, their fields are not sent either.
      start.querySelectorAll("[data-agents-only]").forEach((el) => {
        el.hidden = !agents;
        el.querySelectorAll("input, select").forEach((i) => { i.disabled = !agents; });
      });
      if (line) line.textContent = has ? "The rig's agents, on " + has + "." : "This rig has no model for its agents yet: pick one below.";
      const past = start.querySelectorAll("input[name=past]:checked").length;
      if (sum) sum.textContent = rig ? "Starts a new run on " + rig.value + (agents ? ", with agents on " + (picked || has || "a model you pick") + "." + (past ? " It starts from " + past + " item" + (past === 1 ? "" : "s") + " of past research." : "") : ", as a try: the judge only.") : "Choose a rig.";
      // The campaign's Agents' context (goal 070): the chosen rig's line, and a run that control
      // refuses there is not sent.
      start.querySelectorAll("[data-cc-line]").forEach((el) => { el.hidden = !rig || el.dataset.ccLine !== rig.value; });
      const refused = !!rig && agents && rig.dataset.ccRefused !== undefined;
      if (sum) {
        sum.classList.toggle("bad", refused);
        if (refused) sum.textContent = "Not on " + rig.value + ": choose another rig, or lower this campaign's window.";
      }
      const go = start.querySelector("footer button.primary");
      if (go) go.disabled = refused;
    };
    start.addEventListener("change", update);
    update();
  }

  // ------------------------------------------------ Start a run: from past research (goal 065)
  // Searches the folders the campaign may read; ticked results stay while the owner searches
  // again. Results are agents' text: built with text nodes only.
  const past = $("[data-past]");
  if (past) {
    const qIn = past.querySelector("[data-past-q]");
    const list = past.querySelector("[data-past-list]");
    let timer = 0;
    let asked = 0;
    const row = (x) => {
      const l = document.createElement("label");
      l.className = "pastrow";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.name = "past";
      cb.value = String(x.id);
      const s = document.createElement("span");
      const b = document.createElement("b");
      b.textContent = x.label;
      const m = document.createElement("span");
      m.className = "muted";
      m.textContent = x.line;
      s.append(b, " · " + x.title, document.createElement("br"), m);
      const f = document.createElement("span");
      f.className = "muted xs";
      f.textContent = x.campaign;
      l.append(cb, s, f);
      return l;
    };
    const search = async () => {
      const mine = ++asked;
      try {
        const res = await fetch("/ui/kb/search.json?" + new URLSearchParams({ campaign: past.dataset.past, q: qIn.value }), { credentials: "same-origin" });
        if (!res.ok || mine !== asked) return;
        const body = await res.json();
        const kept = [...list.querySelectorAll(".pastrow")].filter((l) => l.querySelector("input:checked"));
        const have = new Set(kept.map((l) => l.querySelector("input").value));
        list.replaceChildren(...kept, ...(body.items || []).filter((x) => !have.has(String(x.id))).map(row));
        if (!list.children.length) {
          const d = document.createElement("div");
          d.className = "muted small";
          d.textContent = "Nothing found in these collections.";
          list.append(d);
        }
      } catch {}
    };
    if (qIn && list) {
      qIn.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(search, 300); });
      // Enter searches; it never starts the run.
      qIn.addEventListener("keydown", (ev) => { if (ev.key === "Enter") { ev.preventDefault(); clearTimeout(timer); search(); } });
    }
  }

  // ------------------------------------------------ a run's Journal: by writer, by kind, by words
  const jl = $("#jl");
  if (jl) {
    let jw = "all";
    let jk = "all";
    const words = $(".jsearch");
    const apply = () => {
      const q = words ? words.value.trim().toLowerCase() : "";
      jl.querySelectorAll(".jnote").forEach((e) => {
        e.hidden = !((jw === "all" || e.dataset.who === jw) && (jk === "all" || e.dataset.kind === jk) && (!q || e.textContent.toLowerCase().includes(q)));
      });
    };
    const chips = (sel, set) => document.querySelectorAll(sel).forEach((b) => b.addEventListener("click", () => {
      set(b);
      document.querySelectorAll(sel).forEach((x) => x.classList.toggle("on", x === b));
      apply();
    }));
    chips("#jf [data-jw]", (b) => (jw = b.dataset.jw));
    chips("#jk [data-jk]", (b) => (jk = b.dataset.jk));
    if (words) words.addEventListener("input", apply);
  }

  // ------------------------------------------------ the left navigation: open, or only its icons
  // This browser keeps the choice in a cookie control reads (NAV_COOKIE), so every page is drawn
  // as the navigation was left, before this script runs.
  const tog = $("#side-tog");
  if (tog) tog.addEventListener("click", () => {
    const app = $(".app");
    const rail = !app.classList.contains("rail");
    app.classList.toggle("rail", rail);
    const words = rail ? "Expand the navigation" : "Collapse the navigation";
    tog.setAttribute("aria-expanded", String(!rail));
    tog.setAttribute("aria-label", words);
    tog.title = words;
    document.querySelectorAll(".sidebar .nav a").forEach((a) => {
      const t = a.querySelector("span");
      if (rail && t) a.title = t.textContent; else a.removeAttribute("title");
    });
    document.cookie = ${JSON.stringify(NAV_COOKIE)} + "=" + (rail ? "rail" : "open") + "; path=/ui; max-age=31536000; samesite=strict";
  });

  // ------------------------------------------------ the navigation's campaigns and folders (goal 077)
  // A folder folds and opens, and this browser remembers which are folded. A campaign dragged
  // onto a folder, or onto "no folder", moves there with the same post as Move to folder on its
  // page; the row then moves in place. Without this script, every folder shows open.
  const sc = $("#side-camps");
  if (sc) {
    const KEY = "thermite.nav.folded";
    let folded = [];
    try { folded = JSON.parse(localStorage.getItem(KEY) || "[]"); } catch {}
    if (!Array.isArray(folded)) folded = [];
    sc.querySelectorAll("details.side-folder[data-fold]").forEach((d) => { if (folded.includes(d.dataset.fold)) d.open = false; });
    sc.addEventListener("toggle", (ev) => {
      const d = ev.target;
      if (!(d instanceof Element) || !d.matches("details.side-folder[data-fold]")) return;
      folded = folded.filter((x) => x !== d.dataset.fold);
      if (!d.open) folded.push(d.dataset.fold);
      try { localStorage.setItem(KEY, JSON.stringify(folded)); } catch {}
    }, true);
    const say = $("#side-say");
    const tell = (text, bad) => { if (!say) return; say.textContent = text; say.classList.toggle("bad", !!bad); };
    let dragged = null;
    // A folder takes the drop; "no folder", or a campaign in none, takes it out of its folder.
    const dropAt = (ev) => {
      const t = ev.target instanceof Element ? ev.target : null;
      if (!t) return null;
      const fold = t.closest(".side-fold");
      if (fold) return fold;
      if (t.closest(".side-drop") || t.closest(".side-row")) return sc.querySelector(".side-drop");
      return null;
    };
    const unmark = () => sc.querySelectorAll(".drop-over").forEach((x) => x.classList.remove("drop-over"));
    const done = () => { if (dragged) dragged.classList.remove("dragging"); dragged = null; sc.classList.remove("side-dragging"); unmark(); };
    const count = (fold) => {
      const d = fold.querySelector("details.side-folder");
      const n = d.querySelectorAll(".side-row").length;
      fold.querySelector("summary .n").textContent = String(n);
      const empty = d.querySelector(".side-empty");
      if (n && empty) empty.remove();
      // A folder that holds only archived campaigns says so, as control draws it.
      const shelved = Number(d.dataset.archived || "0");
      if (!n && !empty) { const e = document.createElement("div"); e.className = "side-empty"; e.textContent = shelved ? shelved + " archived " + (shelved === 1 ? "campaign" : "campaigns") + ", not shown." : "Empty. Drag a campaign here."; d.append(e); }
    };
    sc.addEventListener("dragstart", (ev) => {
      const r = ev.target instanceof Element ? ev.target.closest(".side-row[data-campaign]") : null;
      // With no folder there is nowhere to drop it.
      if (!r || !sc.querySelector(".side-fold")) return;
      dragged = r;
      ev.dataTransfer.effectAllowed = "move";
      ev.dataTransfer.setData("text/plain", r.dataset.campaign);
      requestAnimationFrame(() => { if (dragged) { dragged.classList.add("dragging"); sc.classList.add("side-dragging"); } });
    });
    sc.addEventListener("dragend", done);
    sc.addEventListener("dragover", (ev) => {
      if (!dragged) return;
      const t = dropAt(ev);
      if (!t) return;
      ev.preventDefault();
      if (!t.classList.contains("drop-over")) { unmark(); t.classList.add("drop-over"); }
    });
    sc.addEventListener("drop", async (ev) => {
      if (!dragged) return;
      const t = dropAt(ev);
      if (!t) return;
      ev.preventDefault();
      const row = dragged, from = row.closest(".side-fold");
      done();
      const folder = t.classList.contains("side-fold") ? t.dataset.folder : "";
      if ((from ? from.dataset.folder : "") === folder) return;
      const body = new URLSearchParams({ csrf: sc.dataset.csrf || "", folder });
      let out = null;
      try {
        const res = await fetch("/ui/campaigns/" + encodeURIComponent(row.dataset.campaign) + "/folder", { method: "POST", body, credentials: "same-origin", headers: { accept: "application/json" } });
        out = res.ok ? await res.json() : null;
      } catch {}
      if (!out || out.error) { tell((out && out.error) || "Not moved: control did not answer. Load the page again.", true); return; }
      if (folder) {
        const d = t.querySelector("details.side-folder");
        d.open = true;
        d.append(row);
        count(t);
      } else sc.insertBefore(row, sc.querySelector(".side-drop"));
      if (from) count(from);
      tell(out.said || "", false);
    });
  }

  // ------------------------------------------------ the experiment queue: drag to reorder
  // A dropped experiment's new place goes to the rig as a signed owner command (queue_move),
  // through the same form post as the buttons; the page then shows the rig's order.
  // On the document, so the list works after it is drawn again with the rig's order (goal 080).
  if ($("#qlist")) {
    let dragged = null;
    const csrfIn = $("form.qadd input[name=csrf]");
    const qi = (ev) => (ev.target.closest ? ev.target.closest("#qlist .qi") : null);
    const send = (el) => {
      const ql = $("#qlist");
      const pos = [...ql.querySelectorAll(".qi")].indexOf(el);
      const body = new URLSearchParams({ csrf: csrfIn ? csrfIn.value : "", rig: el.dataset.rig, run: el.dataset.run, kind: "queue_move", id: el.dataset.id, position: String(pos), back: location.pathname + location.search });
      ql.querySelectorAll(".qn").forEach((n, i) => (n.textContent = String(i + 1)));
      // The move is followed like a button's command, until the list shows the rig's order.
      fetch("/ui/commands", { method: "POST", body, credentials: "same-origin", headers: { accept: "application/json" } })
        .then((r) => r.json())
        .then((a) => document.dispatchEvent(new CustomEvent("fw:follow", { detail: a })))
        .catch(() => {});
    };
    document.addEventListener("dragstart", (ev) => { const el = qi(ev); if (el) { dragged = el; el.classList.add("drag"); } });
    document.addEventListener("dragend", (ev) => { const el = qi(ev); if (el) { el.classList.remove("drag"); document.querySelectorAll("#qlist .over").forEach((x) => x.classList.remove("over")); } });
    document.addEventListener("dragover", (ev) => { const el = qi(ev); if (el) { ev.preventDefault(); el.classList.add("over"); } });
    document.addEventListener("dragleave", (ev) => { const el = qi(ev); if (el) el.classList.remove("over"); });
    // Dropped on an item's lower half, it goes after that item (so also below the last one).
    document.addEventListener("drop", (ev) => {
      const el = qi(ev);
      if (!el) return;
      ev.preventDefault();
      el.classList.remove("over");
      if (!dragged || dragged === el || !dragged.isConnected) return;
      const box = el.getBoundingClientRect();
      el.parentElement.insertBefore(dragged, ev.clientY > box.top + box.height / 2 ? el.nextSibling : el);
      send(dragged);
    });
  }
  // The Tried table's filters, together: the result (chips), the direction and who added it.
  const qf = $("#qf");
  if (qf) {
    let want = ["all"];
    const qd = qf.querySelector("[data-qd]");
    const qb = qf.querySelector("[data-qb]");
    const apply = () => document.querySelectorAll("#qtried tr").forEach((t) => {
      t.hidden = !((want[0] === "all" || want.includes(t.dataset.r)) && (!qd || !qd.value || t.dataset.d === qd.value) && (!qb || !qb.value || t.dataset.b === qb.value));
    });
    qf.querySelectorAll("[data-qf]").forEach((b) => b.addEventListener("click", () => {
      want = b.dataset.qf.split(" ");
      qf.querySelectorAll("[data-qf]").forEach((x) => x.classList.toggle("on", x === b));
      apply();
    }));
    for (const s of [qd, qb]) if (s) s.addEventListener("change", apply);
  }

  // ------------------------------------------------ a message needs words: spaces alone are none
  document.querySelectorAll("textarea[data-words]").forEach((t) => {
    const check = () => t.setCustomValidity(t.value.trim() ? "" : "Write a message first.");
    t.addEventListener("input", check);
    check();
  });

  // ------------------------------------------------ typed confirmations: the button waits for the words
  const confirms = () => document.querySelectorAll("input[data-confirm]").forEach((i) => {
    const b = i.form && i.form.querySelector("button");
    if (b && !i.disabled) b.disabled = i.value.trim() !== i.dataset.confirm;
  });
  document.addEventListener("input", (ev) => { if (ev.target.matches && ev.target.matches("input[data-confirm]")) confirms(); });
  confirms();

  // ------------------------------------------------ a rig's history: everything, the pod, the runs or the judge
  const hf = $("#hf");
  if (hf) hf.querySelectorAll("[data-h]").forEach((b) => b.addEventListener("click", () => {
    const k = b.dataset.h;
    hf.querySelectorAll("[data-h]").forEach((x) => x.classList.toggle("on", x === b));
    document.querySelectorAll("#hist .tl-row").forEach((r) => (r.hidden = !(k === "all" || r.dataset.k === k)));
  }));

  // ------------------------------------------------ the Rigs list: a row opens its rig; its links go where they say
  document.addEventListener("click", (ev) => {
    const row = ev.target.closest && ev.target.closest("tr[data-href]");
    if (!row || ev.target.closest("a, button, input, select, .ii")) return;
    location.href = row.dataset.href;
  });

  // ------------------------------------------------ Metrics: today starts at midnight where the viewer is
  // Every link to Metrics carries the browser's time zone (tz); a Metrics page opened without one
  // loads again with it. Without this script, Metrics counts today from midnight UTC and says so.
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz) {
      for (const a of document.querySelectorAll('a[href^="/ui/metrics"]')) {
        const u = new URL(a.getAttribute("href"), location.href);
        if (!u.searchParams.has("tz")) { u.searchParams.set("tz", tz); a.setAttribute("href", u.pathname + u.search); }
      }
      if (location.pathname === "/ui/metrics" && !new URLSearchParams(location.search).has("tz")) {
        const u = new URL(location.href);
        u.searchParams.set("tz", tz);
        location.replace(u.pathname + u.search + u.hash);
      }
    }
  } catch {}

  // ------------------------------------------------ the composer: Cmd/Ctrl+Enter sends
  const ta = $(".composer textarea");
  if (ta) ta.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); ta.form && ta.form.requestSubmit(); }
  });
})();
`;
