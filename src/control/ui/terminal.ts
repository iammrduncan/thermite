import {
  CONFIRM_FIRST,
  TERMINAL_KEYS,
  TERMINAL_TEXT_MAX,
  type TerminalKey,
} from "../../core/terminal-input.ts";
import { esc } from "./components/index.ts";

/** The Pi view's commands, as every Pi view takes them (src/agents/pi-view/). */
const PI_VIEW_COMMANDS = "/status, /compact, /mcp, /mcp reconnect [server] and /skill:NAME";

/**
 * A trial's terminal on its Live page (goal 169), for the owner: the agent's program's screen,
 * drawn read-only by xterm.js at the agent's size from the frames control pushes while the page
 * watches, and under it the console that types into it (terminal_input), with each input's
 * outcome. The screen is the program's own drawing: the page escapes nothing in it because it
 * never becomes HTML; xterm.js draws it, with its links and clipboard writes off. A worker in Pi's
 * screen is its Pi view (the frame says so): the console then shows its commands and the choice
 * to give the words as a follow-up.
 */

/** Each named key's button: its label, and what it means where it is not plain. */
const KEY_LABELS: Record<TerminalKey, string> = {
  enter: "Enter",
  esc: "Esc",
  tab: "Tab",
  up: "↑",
  down: "↓",
  left: "←",
  right: "→",
  "page-up": "PgUp",
  "page-down": "PgDn",
  "0": "0",
  "1": "1",
  "2": "2",
  "3": "3",
  "4": "4",
  "5": "5",
  "6": "6",
  "7": "7",
  "8": "8",
  "9": "9",
};

/** The console's styles beside xterm.js's own; the page carries both, as CSP allows. */
const TERM_STYLE = `
.term [hidden], .term-tabs [hidden] { display: none !important; }
.term-tabs { display: flex; gap: 2px; padding: 0 12px; border-bottom: 1px solid var(--border); background: var(--muted); min-width: 0; }
.term-tab { display: block; flex: 0 1 auto; min-width: 0; max-width: 320px; height: auto; border: 0; border-radius: 0; background: none; padding: 8px 12px; cursor: pointer; font-size: 13px; color: var(--muted-foreground); border-bottom: 2px solid transparent; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.term-tab[data-term-split] { flex: none; }
.term-tab.on { color: var(--foreground); border-bottom-color: var(--primary); font-weight: 600; }
.term-tabs .grow, .term-bar .grow { flex: 1; }
.term-area { display: grid; grid-template-columns: minmax(0, 1fr); grid-auto-rows: minmax(0, 1fr); flex: 1; min-height: 0; }
.term-area.one { min-height: 70vh; }
.term-area.split { grid-template-columns: repeat(var(--cols, 2), minmax(0, 1fr)); gap: 1px; background: var(--border); }
@media (max-width: 900px) { .term-area.split { grid-template-columns: minmax(0, 1fr); grid-auto-rows: minmax(300px, 1fr); overflow-y: auto; } }
.term-area:not(.split):not(.one) > .term:not(.on) { display: none; }
.term-area:not(.split):not(.one) .term-bar > b { display: none; }
.term { display: flex; flex-direction: column; min-width: 0; min-height: 0; background: #0b0d10; }
.term-bar { display: flex; gap: 10px; align-items: center; padding: 4px 12px; font-size: 12px; color: #8b949e; background: #0b0d10; min-width: 0; }
.term-bar b { color: #e6e6e6; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 45%; }
.term-state { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.term-newest { flex: none; height: 22px; border: 0; background: var(--primary); color: var(--primary-foreground); border-radius: 999px; padding: 0 10px; font-size: 12px; cursor: pointer; }
.term-menu { flex: none; }
.term-menu > summary { list-style: none; cursor: pointer; color: #c9d1d9; } .term-menu > summary::-webkit-details-marker { display: none; }
.term-menu .menu-pop { top: 24px; right: 0; left: auto; width: min(420px, 86vw); color: var(--foreground); }
.term-held { padding: 6px 12px; font-size: 12.5px; background: var(--warning-surface); color: var(--warning-foreground); }
.term-view { flex: 1; min-height: 0; padding: 4px 8px 6px; overflow: hidden; outline: none; }
.term-view:focus-within { box-shadow: inset 0 0 0 1px var(--primary); }
.term-view:empty::before { content: "No screen yet."; color: #8b949e; font-size: 12px; }
.term-console { display: flex; flex-direction: column; gap: 4px; padding: 6px 12px; background: var(--card); border-top: 1px solid var(--border); }
.term-row { display: flex; gap: 6px; align-items: center; }
.term-row input[name=text] { flex: 1; min-width: 0; font-family: var(--mono, ui-monospace, monospace); }
.term-row .menu-pop { bottom: 36px; top: auto; right: 0; left: auto; }
.term-keys { display: flex; flex-wrap: wrap; gap: 4px; width: 260px; } .term-keys button { min-width: 34px; }
.term-confirm { font-size: 12.5px; }
.term-inputs { font-size: 12.5px; }
.term-inputs ol { list-style: none; margin: 0; padding: 0; display: grid; gap: 3px; }
.term-inputs code { white-space: pre-wrap; }
.term-inputs .bad { color: var(--destructive); }
`;

/** One of the owner's inputs as the console lists it: when, what, and what became of it. */
export interface TermInputRow {
  at: string;
  /** The text, or the keys by name. */
  words: string;
  keys: boolean;
  outcome: string;
  tone: "" | "ok" | "warn" | "bad";
}

/**
 * The inputs' list: newest first, a part of the page drawn again as each command moves. A page
 * with several terminals names each list's part after its trial.
 */
export function termInputsHtml(rows: readonly TermInputRow[], part = "term-inputs"): string {
  const row = (r: TermInputRow) =>
    `<li><span class="muted">${esc(r.at.slice(11, 19))} UTC</span> ${r.keys ? esc(r.words) : `<code>${esc(r.words)}</code>`} · <span class="${r.tone}">${esc(r.outcome)}</span></li>`;
  return `<div class="term-inputs" data-part="${esc(part)}">${
    rows.length
      ? `<div class="muted">Your inputs, newest first:</div><ol>${rows.map(row).join("")}</ol>`
      : `<div class="muted">Nothing typed yet. Each input is a signed command, recorded word for word with what became of it.</div>`
  }</div>`;
}

/** A terminal's inputs: its frames' address, where its console posts, its run and trial. */
export interface TerminalPane {
  stream: string;
  action: string;
  /** Where the keys pressed into it go (goal 187); empty for one that takes typed lines only. */
  keys: string;
  csrf: string;
  run: string;
  trial: string;
  ended: boolean;
  inputs: readonly TermInputRow[];
  /** Why the last input was not sent. */
  error?: string | undefined;
  /** Its heading on a page of several terminals (goal 181), such as the lane and its direction. */
  title?: string | undefined;
}

/** What every page with a terminal carries once: xterm.js's styles and the console's, the scripts. */
const terminalAssets = (xtermCss: string) =>
  `<style>${xtermCss}${TERM_STYLE}</style><script src="/ui/assets/xterm.js" defer></script><script src="/ui/assets/terminal.js" defer></script>`;

/**
 * One terminal (goal 187): a bar with its name, what it shows, the owner's inputs as a menu and a
 * way back to the newest lines, then the screen, which takes keys as they are pressed. A terminal
 * that takes no keys from Live (a planner's or an advisor's call, a worker in Pi's view) has one
 * line under it for typed lines, each a signed command: a field, Send and its keys as a menu; the
 * choice to confirm shows only for a line that needs it.
 */
function terminalPaneHtml(o: TerminalPane): string {
  const keys = TERMINAL_KEYS.map(
    (k) =>
      `<button class="sm ghost" name="key" value="${esc(k)}" title="Send ${esc(KEY_LABELS[k])}">${esc(KEY_LABELS[k])}</button>`,
  ).join("");
  // A trial's terminal shows the line only for a Pi view.
  const typedLines = o.ended
    ? ""
    : `<form class="term-console" method="post" action="${esc(o.action)}" data-act data-term-console${o.keys ? " hidden" : ""}>
<input type="hidden" name="csrf" value="${esc(o.csrf)}"><input type="hidden" name="run" value="${esc(o.run)}"><input type="hidden" name="trial" value="${esc(o.trial)}">
${o.error ? `<div class="small bad">Not sent: ${esc(o.error)}</div>` : ""}
<div class="term-row"><input name="text" maxlength="${TERMINAL_TEXT_MAX}" autocomplete="off" spellcheck="false" aria-label="Type into the agent's terminal" placeholder="Type a line: words, a /command or a skill. Enter sends it, then presses Enter there"><button class="primary sm">Send</button><details class="menu"><summary class="btn sm ghost" title="Send one key: Enter, Esc, Tab, the arrows, the page keys or a digit">Keys ▾</summary><div class="menu-pop"><div class="term-keys" role="group" aria-label="Keys">${keys}</div></div></details></div>
<label class="term-confirm" data-term-pi hidden><input type="checkbox" name="follow_up" value="1"> Follow-up: give my words when the agent would stop (a reply that calls no tool), not before its next model call</label>
<div class="term-confirm muted" data-term-pi hidden>The Pi view: words steer the agent; <b>Esc</b> stops its reply; its commands are ${esc(PI_VIEW_COMMANDS)}.</div>
<label class="term-confirm" data-term-confirm hidden><input type="checkbox" name="confirm" value="1"> Send it: this line runs a shell command (<code>!</code>) or <code>/login</code>, <code>/logout</code>, <code>/config</code> or <code>/permissions</code></label>
<input type="hidden" name="wait" value="queue">
</form>`;
  const list = termInputsHtml(o.inputs, `term-inputs-${o.trial}`);
  const takesKeys = !o.ended && Boolean(o.keys);
  return `<section class="term" data-term="${esc(o.stream)}" data-trial="${esc(o.trial)}"${takesKeys ? ` data-keys="${esc(o.keys)}" data-csrf="${esc(o.csrf)}"` : ""}>
<div class="term-bar"><b>${esc(o.title ?? "Terminal")}</b><span class="term-state" data-term-state>Waiting for the rig to send its screen…</span><span class="grow"></span><button type="button" class="term-newest" data-term-newest hidden>↓ Newest</button><details class="menu term-menu"><summary>${o.inputs.length ? `${o.inputs.length} input${o.inputs.length === 1 ? "" : "s"}` : "Inputs"} ▾</summary><div class="menu-pop">${list}</div></details></div>
<div class="term-held" data-term-held hidden></div>
<div class="term-view" data-term-view${takesKeys ? ` tabindex="-1" title="Click, then type: keys go straight to the agent's program"` : ""}></div>
${typedLines}
</section>`;
}

/** A page's one terminal, with what the page carries for it. */
export function terminalHtml(o: TerminalPane & { xtermCss: string }): string {
  return `${terminalAssets(o.xtermCss)}\n<div class="term-area one">${terminalPaneHtml(o)}</div>`;
}

/**
 * A run's terminals (goal 187): a tab for each, and Side by side; the chosen one fills the pane.
 */
export function terminalGridHtml(panes: readonly TerminalPane[], xtermCss: string): string {
  const tabs = panes
    .map(
      (p, i) =>
        `<button type="button" class="term-tab${i ? "" : " on"}" data-term-tab="${esc(p.trial)}">${esc(p.title ?? p.trial)}</button>`,
    )
    .join("");
  return `${terminalAssets(xtermCss)}<div class="term-tabs" role="tablist">${tabs}<span class="grow"></span>${panes.length > 1 ? `<button type="button" class="term-tab" data-term-split>Side by side</button>` : ""}</div><div class="term-area" data-term-area>${panes.map((p) => terminalPaneHtml(p)).join("")}</div>`;
}

/**
 * The terminal's script, served from control (CSP script-src 'self'), after xterm.js. It draws
 * each frame control pushes into a terminal of the frame's size, scaled so the whole screen fits
 * its pane, says what it shows, and sends the keys pressed into a terminal that takes them (goal
 * 187). A terminal that takes none gets its typed lines from its form, each a signed command.
 */
export const TERMINAL_JS = `
(() => {
  "use strict";
  // The run's terminals: a tab for each, one shown, or all side by side (goal 187), in a grid as
  // near square as their number allows.
  const area = document.querySelector("[data-term-area]");
  if (area) {
    const panes = [...area.querySelectorAll("[data-term]")];
    const tabs = [...document.querySelectorAll("[data-term-tab]")];
    const split = document.querySelector("[data-term-split]");
    area.style.setProperty("--cols", String(Math.ceil(Math.sqrt(panes.length))));
    let shown = tabs[0] ? tabs[0].dataset.termTab : "";
    const show = (trial) => {
      shown = trial;
      area.classList.remove("split");
      if (split) split.classList.remove("on");
      for (const p of panes) p.classList.toggle("on", p.dataset.trial === trial);
      for (const t of tabs) t.classList.toggle("on", t.dataset.termTab === trial);
    };
    for (const t of tabs) {
      t.title = t.textContent;
      t.addEventListener("click", () => show(t.dataset.termTab));
    }
    if (split) split.addEventListener("click", () => {
      const on = !area.classList.contains("split");
      area.classList.toggle("split", on);
      split.classList.toggle("on", on);
      for (const t of tabs) t.classList.toggle("on", !on && t.dataset.termTab === shown);
    });
    if (shown) show(shown);
  }
  const boxes = document.querySelectorAll("[data-term]");
  if (!boxes.length) return;
  const risky = new RegExp(${JSON.stringify(CONFIRM_FIRST.source)});
  const setup = (box) => {
  const view = box.querySelector("[data-term-view]");
  const state = box.querySelector("[data-term-state]");
  const held = box.querySelector("[data-term-held]");
  const newest = box.querySelector("[data-term-newest]");
  const form = box.querySelector("[data-term-console]");
  const say = (t) => { if (state) state.textContent = t; };
  // The choice to confirm shows only for a line that needs it.
  const text = form && form.querySelector("input[name=text]");
  const confirm = box.querySelector("[data-term-confirm]");
  if (text && confirm) text.addEventListener("input", () => { confirm.hidden = !risky.test(text.value); });
  if (!window.Terminal || !window.EventSource) { say("This browser can't draw the terminal."); return; }
  // Keys pressed into it go to the agent's program, a few at a time (goal 187).
  const keysTo = box.dataset.keys;
  let pending = "", flushing = null, piView = false;
  const flush = async () => {
    flushing = null;
    if (!pending) return;
    const data = pending; pending = "";
    try {
      const res = await fetch(keysTo, { method: "POST", credentials: "same-origin", body: new URLSearchParams({ csrf: box.dataset.csrf, trial: box.dataset.trial, data }) });
      if (!res.ok) { const j = await res.json().catch(() => ({})); say(j.error || "Your keys were not sent."); }
    } catch { say("Your keys were not sent: control could not be reached."); }
  };
  const press = (d) => { if (!keysTo || piView) return; pending += d; if (!flushing) flushing = setTimeout(flush, 30); };
  let term = null, cols = 0, rows = 0, last = "";
  // The screen at the size the agent's program has, its font scaled so all its columns and rows
  // fit the pane: measured from the drawn screen, a few passes until it settles.
  const fit = (pass = 0) => {
    if (!term || !cols) return;
    const w = view.clientWidth - 16, h = view.clientHeight - 10;
    const screen = view.querySelector(".xterm-screen");
    if (w <= 0 || h <= 0 || !screen || !screen.offsetWidth || !screen.offsetHeight) return;
    const now = term.options.fontSize;
    const size = Math.max(5, Math.min(14, Math.floor(now * Math.min(w / screen.offsetWidth, h / screen.offsetHeight) * 4) / 4));
    if (size === now) return;
    term.options.fontSize = size;
    if (pass < 3) requestAnimationFrame(() => fit(pass + 1));
  };
  if (window.ResizeObserver) new ResizeObserver(() => fit()).observe(view);
  else window.addEventListener("resize", () => fit());
  const atBottom = () => !term || term.buffer.active.viewportY >= term.buffer.active.baseY;
  const draw = (f) => {
    if (typeof f.data !== "string") return;
    if (!term || f.cols !== cols || f.rows !== rows) {
      if (term) term.dispose();
      cols = f.cols; rows = f.rows; last = "";
      term = new window.Terminal({
        cols, rows, scrollback: 1000, disableStdin: !keysTo, cursorBlink: false, fontSize: 13,
        // Links in the screen open nothing.
        linkHandler: { activate: () => {} },
        theme: { background: "#0b0d10" },
      });
      term.open(view);
      term.onData(press);
      term.onScroll(() => { if (newest) newest.hidden = atBottom(); });
      fit();
    }
    if (f.data === last) return;
    last = f.data;
    // A frame holds the screen and the lines above it: drawn anew, it keeps the place of a viewer
    // who scrolled back, counted from the bottom.
    const b = term.buffer.active;
    const back = b.baseY - b.viewportY;
    term.reset();
    term.write(f.data, () => { if (back > 0) term.scrollToLine(Math.max(0, term.buffer.active.baseY - back)); if (newest) newest.hidden = atBottom(); });
  };
  if (newest) newest.addEventListener("click", () => { if (term) term.scrollToBottom(); newest.hidden = true; });
  view.addEventListener("click", () => { if (term) term.focus(); });
  const said = (ev) => { try { return JSON.parse(ev.data); } catch { return {}; } };
  const pushed = new EventSource(box.dataset.term);
  pushed.addEventListener("frame", (ev) => {
    const f = said(ev);
    const at = String(f.at || "").slice(11, 19) + " UTC";
    if (f.state === "none") {
      say("This trial has no terminal: its program runs headless, it has not started yet, or the rig restarted since it ended.");
      view.hidden = true;
      if (form) form.hidden = true;
      return;
    }
    view.hidden = false;
    // A worker in Pi's view takes typed lines: its form; any other terminal takes keys.
    piView = Boolean(f.pi_view);
    if (form) form.hidden = f.state === "ended" || (Boolean(keysTo) && !piView);
    for (const el of box.querySelectorAll("[data-term-pi]")) el.hidden = !piView;
    draw(f);
    const typing = keysTo && !piView && f.state !== "ended";
    say((f.state === "ended" ? "Its last screen, kept when the trial ended · " : typing ? "Live · click it and type · " : "Live, read only · ") + at + (f.queued ? " · " + f.queued + " of your inputs wait for the reset" : "") + (f.limit ? " · it waits for its usage window" : ""));
    if (held) {
      held.hidden = !f.held;
      held.textContent = f.held ? "Enter held: “" + f.held + "” runs a shell command or changes its sign-in or settings. Press Enter again to send it." : "";
    }
  });
  pushed.addEventListener("waiting", () => say("Waiting for the rig to send its screen…"));
  pushed.addEventListener("busy", (ev) => { say(said(ev).said || "Not shown now."); pushed.close(); });
  };
  for (const box of boxes) setup(box);
})();
`;
