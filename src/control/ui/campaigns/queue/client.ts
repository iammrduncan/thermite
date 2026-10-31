import { DIRECTION_TOKEN_SOURCE } from "../../../../core/directions.ts";

/**
 * The Planner tab's script (goal 066), served from control (/ui/assets/planner.js; no inline
 * script runs under the dashboard's CSP). In Tell the planner, typing `:` opens a picker of the
 * run's directions, as emoji pickers do: letters filter it, Up and Down move, Enter or Tab picks,
 * Esc closes. A name the run doesn't have is offered last as new: the planner designs it. Below
 * the box, a line says which directions the message names. The examples fill the box. Without
 * this script the box is a plain text area that posts the same message.
 * Rig data (the directions' names and figures) becomes DOM text nodes only, never markup.
 */

/**
 * The picker's parts that touch no page, also run by the tests (tests/control/ui/campaigns/queue/client.test.ts):
 * - `nameOf(text)`: a direction's name, as control's directionName makes it, or "" for none;
 * - `pickContext(value, caret)`: the name being typed after a `:`, and where its colon is;
 * - `pickItems(dirs, q)`: the run's directions that hold `q`, then a new one, in order;
 * - `pickChoose(value, caret, ctx, name)`: the text with the typed name replaced by `:name: `;
 * - `tokensIn(text)`: each `:name:` in a text, as a direction or as one too long to be one;
 * - `figures(d)`: a direction's figures in words.
 */
export const PICKER_CORE_JS = String.raw`
const TOKEN_SOURCE = ${JSON.stringify(DIRECTION_TOKEN_SOURCE)};
// Lowercase words joined by dashes, 2 to 41 letters, digits and dashes: :Split k: is split-k.
const nameOf = (text) => {
  const t = String(text).trim();
  const m = /^:(.*):$/.exec(t);
  const inner = m ? m[1].trim() : t;
  if (!/^[A-Za-z0-9][A-Za-z0-9 -]*$/.test(inner)) return "";
  const id = inner.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+/, "").replace(/-+$/, "");
  return /^[a-z0-9][a-z0-9-]{1,40}$/.test(id) ? id : "";
};
// Spaces and dashes are the same in a name: :split-k: and :split k: are one direction.
const norm = (s) => String(s).toLowerCase().replace(/[\s-]+/g, " ").trim();
// The name being typed: a colon that stands on its own (at the start, or after anything but a
// letter, a digit or a colon), then up to 40 letters, digits, spaces and dashes up to the caret.
// A closing colon, a comma or a full stop ends it.
const pickContext = (value, caret) => {
  const before = String(value).slice(0, caret);
  const m = /(?:^|[^A-Za-z0-9:]):([A-Za-z0-9][A-Za-z0-9 -]{0,39}|)$/.exec(before);
  return m ? { start: before.length - m[1].length - 1, q: m[1] } : null;
};
// The run's directions whose name holds the letters typed: those that start with them first,
// then the busiest. A name the run doesn't have comes last, as new, once it can be a name and
// while no direction of the run starts with it (a closing colon makes it anyway).
const pickItems = (dirs, q) => {
  const n = norm(q);
  const busy = (d) => d.tried + d.queued + d.lanes.length;
  const items = dirs
    .filter((d) => norm(d.name).includes(n))
    .sort((a, b) => (norm(b.name).startsWith(n) - norm(a.name).startsWith(n)) || busy(b) - busy(a) || a.name.localeCompare(b.name))
    .map((d) => ({ name: d.name, d }));
  const typed = String(q).trim().replace(/\s+/g, " ").toLowerCase();
  if (n.length >= 2 && nameOf(typed) && !dirs.some((d) => norm(d.name).startsWith(n)))
    items.push({ name: typed, fresh: true });
  return items;
};
// The typed letters, and the rest of the word after the caret, become :name: and a space.
const pickChoose = (value, caret, ctx, name) => {
  const v = String(value);
  const rest = v.slice(caret).replace(/^[A-Za-z0-9-]*:?/, "");
  const ins = ":" + name + ":" + (/^\s/.test(rest) ? "" : " ");
  return { value: v.slice(0, ctx.start) + ins + rest, caret: ctx.start + ins.length };
};
const tokensIn = (text) => {
  const out = [];
  for (const m of String(text).matchAll(new RegExp(TOKEN_SOURCE, "g"))) {
    const name = nameOf(m[0]);
    out.push(name ? { name } : { bad: m[0] });
  }
  return out;
};
const figures = (d) => d.new
  ? "new: the planner designs it at its next round"
  : [d.tried ? d.tried + " tried" : "not tried yet", d.wins ? d.wins + " win" + (d.wins === 1 ? "" : "s") : "", d.queued ? d.queued + " up next" : "", d.lanes.length ? d.lanes.join(", ") + " on it now" : ""].filter(Boolean).join(" · ");
`;

export const PLANNER_JS = `
(() => {
  "use strict";
  ${PICKER_CORE_JS}
  const box = document.querySelector("textarea[data-dpick]");
  if (!box) return;
  // The run's directions, as control drew them on the box (JSON).
  const dirs = JSON.parse(box.dataset.dirs || "[]");
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  const tok = (name, fresh) => { const s = el("span", "dtok" + (fresh ? " new" : "")); s.append(el("i", "", ":"), name, el("i", "", ":")); return s; };
  const find = (name) => dirs.find((d) => norm(d.name) === norm(name));

  // ------------------------------------------------ the picker
  const pick = el("div", "dpick");
  pick.hidden = true;
  pick.setAttribute("role", "listbox");
  document.body.appendChild(pick);
  let ctx = null, items = [], at = 0, shut = false;
  // Where the caret is on the page: a hidden copy of the box, up to the colon.
  const caretAt = () => {
    const cs = getComputedStyle(box), d = el("div");
    for (const p of ["fontFamily", "fontSize", "fontWeight", "letterSpacing", "lineHeight", "paddingTop", "paddingLeft", "paddingRight", "borderTopWidth", "borderLeftWidth", "boxSizing", "width", "tabSize"]) d.style[p] = cs[p];
    Object.assign(d.style, { position: "absolute", visibility: "hidden", top: "0", left: "-9999px", whiteSpace: "pre-wrap", overflowWrap: "break-word" });
    d.textContent = box.value.slice(0, ctx ? ctx.start : box.selectionStart);
    const s = el("span", "", "\\u200b");
    d.appendChild(s);
    document.body.appendChild(d);
    const r = box.getBoundingClientRect(), lh = parseFloat(cs.lineHeight) || 18;
    const x = s.offsetLeft - box.scrollLeft, y = s.offsetTop - box.scrollTop;
    d.remove();
    return { x: r.left + Math.min(x, r.width - 20), y: r.top + y + lh + 4, top: r.top };
  };
  const draw = () => {
    items = pickItems(dirs, ctx.q);
    if (at >= items.length) at = Math.max(0, items.length - 1);
    pick.replaceChildren();
    const typed = ctx.q.trim();
    pick.append(el("div", "dh", "The run's directions" + (typed ? " · matching “" + typed + "”" : "")));
    if (items.length) {
      const list = el("div", "dl");
      items.forEach((it, i) => {
        const row = el("div", "dr" + (i === at ? " on" : "") + (it.fresh ? " fresh" : ""));
        row.dataset.i = String(i);
        row.setAttribute("role", "option");
        row.append(el("span", "n", ":" + it.name + ":"));
        const right = el("span", "r");
        if (it.fresh || it.d.new) right.append(el("span", "chip info", "new"));
        else for (const k of it.d.rules) right.append(el("span", "qkind " + k, k));
        row.append(right, el("span", "s", it.fresh ? "Not in this run yet. The planner designs this direction when it reads your message." : figures(it.d)));
        list.append(row);
      });
      pick.append(list);
    } else pick.append(el("div", "dnone", dirs.length ? "No direction matches yet. Type more of the name." : "This run has no directions yet. Type a name: the planner designs it."));
    const foot = el("div", "df");
    foot.append(el("kbd", "", "↑"), " ", el("kbd", "", "↓"), " move · ", el("kbd", "", "Enter"), " or ", el("kbd", "", "Tab"), " picks · ", el("kbd", "", ":"), " ends the name · ", el("kbd", "", "Esc"), " closes");
    pick.append(foot);
    pick.hidden = false;
    const c = caretAt(), h = pick.offsetHeight;
    let x = Math.min(c.x - 10, innerWidth - pick.offsetWidth - 12);
    if (x < 12) x = 12;
    let y = c.y;
    if (y + h > innerHeight - 8) y = c.top - h - 6;
    pick.style.left = x + "px";
    pick.style.top = y + "px";
    const on = pick.querySelector(".dr.on");
    if (on) on.scrollIntoView({ block: "nearest" });
  };
  const close = () => { pick.hidden = true; ctx = null; };
  const choose = (i) => {
    const it = items[i];
    if (!it || !ctx) return;
    const out = pickChoose(box.value, box.selectionStart, ctx, it.name);
    box.value = out.value;
    box.setSelectionRange(out.caret, out.caret);
    close();
    box.dispatchEvent(new Event("input", { bubbles: true }));
    box.focus();
  };
  const update = () => {
    if (shut) return;
    ctx = pickContext(box.value, box.selectionStart);
    if (ctx) draw(); else close();
  };
  box.addEventListener("input", (e) => { if (e.isTrusted) shut = false; update(); });
  box.addEventListener("click", () => { shut = false; update(); });
  box.addEventListener("keydown", (e) => {
    if (pick.hidden) return;
    if (e.key === "ArrowDown") { e.preventDefault(); at = (at + 1) % Math.max(1, items.length); draw(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); at = (at - 1 + items.length) % Math.max(1, items.length); draw(); }
    else if ((e.key === "Enter" || e.key === "Tab") && items.length) { e.preventDefault(); choose(at); }
    else if (e.key === "Escape") { e.preventDefault(); shut = true; close(); }
  });
  box.addEventListener("blur", () => setTimeout(() => { if (document.activeElement !== box) close(); }, 120));
  pick.addEventListener("mousedown", (e) => { const r = e.target.closest(".dr"); if (r) { e.preventDefault(); choose(Number(r.dataset.i)); } });
  pick.addEventListener("mousemove", (e) => {
    const r = e.target.closest(".dr");
    if (!r || Number(r.dataset.i) === at) return;
    at = Number(r.dataset.i);
    pick.querySelectorAll(".dr").forEach((x) => x.classList.toggle("on", Number(x.dataset.i) === at));
  });
  window.addEventListener("scroll", () => { if (!pick.hidden) draw(); }, true);

  // ------------------------------------------------ what the message names, as you type
  const prev = document.getElementById("qmsg-prev");
  const base = prev ? [...prev.childNodes].map((n) => n.cloneNode(true)) : [];
  const said = () => {
    if (!prev) return;
    const v = box.value.trim();
    if (!v) { prev.replaceChildren(...base.map((n) => n.cloneNode(true))); return; }
    const lines = [];
    const found = tokensIn(v), seen = new Set(), named = [];
    for (const t of found) { const k = t.name || t.bad; if (!seen.has(k)) { seen.add(k); named.push(t); } }
    if (named.length) {
      const line = [el("b", "", "Named exactly: ")];
      named.forEach((t, i) => {
        if (i) line.push(" · ");
        if (t.bad) { line.push(el("span", "dtok bad", t.bad), " ", el("span", "muted xs", "too long for a direction's name: the planner reads it as plain words")); return; }
        const d = find(t.name);
        if (d && !d.new) line.push(tok(d.name, false), " ", el("span", "muted xs", figures(d)));
        else line.push(tok(t.name, true), " ", el("span", "chip info", "new"), " ", el("span", "muted xs", "not in this run: the planner designs it"));
      });
      lines.push(line);
    }
    // Plain words: whole words of a direction's name, with or without dashes.
    const words = v.replace(new RegExp(TOKEN_SOURCE, "g"), " ");
    if (/[A-Za-z]{3,}/.test(words)) {
      const t = " " + norm(words.replace(/[^A-Za-z0-9 -]/g, " ")) + " ";
      const match = dirs.filter((d) => !d.new && t.includes(" " + norm(d.name) + " ")).map((d) => d.name);
      const line = [el("b", "", "In plain words: "), "the planner reads them and makes any rule from them. Each rule it makes names a direction: one of the run's, or a new one it designs."];
      if (match.length) { line.push(" Your words match "); match.forEach((n, i) => { if (i) line.push(", "); line.push(tok(n, false)); }); line.push("."); }
      lines.push(line);
    }
    prev.replaceChildren();
    lines.forEach((l, i) => { if (i) prev.append(el("br")); prev.append(...l); });
  };
  box.addEventListener("input", said);
  said();

  // ------------------------------------------------ examples
  const fill = (text) => {
    box.value = text;
    box.scrollIntoView({ block: "center" });
    box.focus();
    box.setSelectionRange(box.value.length, box.value.length);
    said();
  };
  document.addEventListener("click", (e) => {
    const x = e.target.closest("[data-example]");
    if (!x) return;
    e.preventDefault();
    fill(x.dataset.example || "");
  });
})();
`;
