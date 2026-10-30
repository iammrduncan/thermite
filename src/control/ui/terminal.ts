import {
  CONFIRM_FIRST,
  TERMINAL_KEYS,
  TERMINAL_TEXT_MAX,
  type TerminalKey,
} from "../../core/terminal-input.ts";
import { esc } from "./components/index.ts";

/** The Pi view's commands, as the harness's Pi view takes them (src/harness/agents/pi-view/). */
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
.term { border-bottom: 1px solid var(--border); background: var(--card); }
.term > summary { display: flex; align-items: center; gap: 8px; padding: 8px 16px; cursor: pointer; font-size: 13px; }
.term-state { color: var(--muted-foreground); font-size: 12px; }
.term-view { margin: 0 16px; padding: 6px; background: #0b0d10; border-radius: 8px; overflow: auto; max-height: 58vh; }
.term-view:empty::before { content: "No screen yet."; color: #8b949e; font-size: 12px; }
.term-console { display: flex; flex-direction: column; gap: 6px; padding: 8px 16px; }
.term-row { display: flex; gap: 6px; }
.term-row input[name=text] { flex: 1; font-family: var(--mono, ui-monospace, monospace); }
.term-keys { display: flex; flex-wrap: wrap; gap: 4px; }
.term-keys button { min-width: 34px; }
.term-wait { padding: 6px 10px; border-radius: 8px; background: var(--warning-surface); font-size: 12.5px; }
.term-wait label { margin-left: 10px; }
.term-confirm { font-size: 12.5px; }
.term-inputs { padding: 0 16px 10px; font-size: 12.5px; }
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

/** The inputs' list: newest first, a part of the page drawn again as each command moves. */
export function termInputsHtml(rows: readonly TermInputRow[]): string {
  const row = (r: TermInputRow) =>
    `<li><span class="muted">${esc(r.at.slice(11, 19))} UTC</span> ${r.keys ? esc(r.words) : `<code>${esc(r.words)}</code>`} · <span class="${r.tone}">${esc(r.outcome)}</span></li>`;
  return `<div class="term-inputs" data-part="term-inputs">${
    rows.length
      ? `<div class="muted">Your inputs, newest first:</div><ol>${rows.map(row).join("")}</ol>`
      : `<div class="muted">Nothing typed yet. Each input is a signed command, recorded word for word with what became of it.</div>`
  }</div>`;
}

/**
 * The terminal and its console. `stream`: the frames' address; `action`: where the console posts;
 * `error`: why the last input was not sent.
 */
export function terminalHtml(o: {
  stream: string;
  action: string;
  csrf: string;
  run: string;
  trial: string;
  ended: boolean;
  inputs: readonly TermInputRow[];
  xtermCss: string;
  error?: string | undefined;
}): string {
  const keys = TERMINAL_KEYS.map(
    (k) =>
      `<button class="sm ghost" name="key" value="${esc(k)}" title="Send ${esc(KEY_LABELS[k])}">${esc(KEY_LABELS[k])}</button>`,
  ).join("");
  const console = o.ended
    ? `<div class="term-console muted small">The trial has ended: its terminal takes no more input.</div>`
    : `<form class="term-console" method="post" action="${esc(o.action)}" data-act data-term-console>
<input type="hidden" name="csrf" value="${esc(o.csrf)}"><input type="hidden" name="run" value="${esc(o.run)}"><input type="hidden" name="trial" value="${esc(o.trial)}">
${o.error ? `<div class="small bad">Not sent: ${esc(o.error)}</div>` : ""}
<div class="term-wait" data-term-wait hidden><b>The program waits for its usage window to reset<span data-term-until></span>.</b> Your input:<label><input type="radio" name="wait" value="queue" checked> waits for the reset</label><label><input type="radio" name="wait" value="now"> goes in now (the program may start its wait again)</label></div>
<div class="term-row"><input name="text" maxlength="${TERMINAL_TEXT_MAX}" autocomplete="off" spellcheck="false" aria-label="Type into the agent's terminal" placeholder="Type into the agent's terminal: words, a /command or a skill. Enter sends it, then presses Enter there"><button class="primary sm">Send</button></div>
<label class="term-confirm" data-term-pi hidden><input type="checkbox" name="follow_up" value="1"> Follow-up: give my words when the agent would stop (a reply that calls no tool), not before its next model call</label>
<div class="term-confirm muted" data-term-pi hidden>The Pi view: words steer the agent; <b>Esc</b> stops its reply; its commands are ${esc(PI_VIEW_COMMANDS)}.</div>
<label class="term-confirm" data-term-confirm><input type="checkbox" name="confirm" value="1"> Confirm an input that starts with <code>!</code> (a shell command) or runs <code>/login</code>, <code>/logout</code>, <code>/config</code> or <code>/permissions</code></label>
<div class="term-keys" role="group" aria-label="Keys">${keys}</div>
</form>`;
  return `<style>${o.xtermCss}${TERM_STYLE}</style>
<details class="term" open data-term="${esc(o.stream)}"><summary><b>Terminal</b><span class="term-state" data-term-state>Waiting for the rig to send its screen…</span></summary>
<div class="term-view" data-term-view></div>
${console}
${termInputsHtml(o.inputs)}
</details>
<script src="/ui/assets/xterm.js" defer></script><script src="/ui/assets/terminal.js" defer></script>`;
}

/**
 * The terminal's script, served from control (CSP script-src 'self'), after xterm.js. It draws
 * each frame control pushes into a read-only terminal of the frame's size, says what it shows, and
 * shows the console's choice while the program waits for its usage window. Nothing typed into the
 * screen reaches the program: only the console's form does, as a signed command.
 */
export const TERMINAL_JS = `
(() => {
  "use strict";
  const box = document.querySelector("[data-term]");
  if (!box) return;
  const view = box.querySelector("[data-term-view]");
  const state = box.querySelector("[data-term-state]");
  const wait = box.querySelector("[data-term-wait]");
  const until = box.querySelector("[data-term-until]");
  const form = box.querySelector("[data-term-console]");
  const say = (t) => { if (state) state.textContent = t; };
  const pis = box.querySelectorAll("[data-term-pi]");
  // The same rule as control's: such an input is sent only once confirmed.
  const risky = new RegExp(${JSON.stringify(CONFIRM_FIRST.source)});
  if (form) {
    const text = form.querySelector("input[name=text]");
    const confirm = form.querySelector("[data-term-confirm]");
    const check = () => { if (confirm && text) confirm.hidden = !risky.test(text.value); };
    if (text) text.addEventListener("input", check);
    check();
    // Sent: the field empties once the form's words have gone (after the page's own sender).
    form.addEventListener("submit", (ev) => {
      if (ev.submitter && ev.submitter.name === "key") return;
      setTimeout(() => {
        if (text) text.value = "";
        for (const tick of form.querySelectorAll("input[type=checkbox]")) tick.checked = false;
        check();
      }, 0);
    });
  }
  if (!window.Terminal || !window.EventSource) { say("This browser can't draw the terminal."); return; }
  let term = null, cols = 0, rows = 0, last = "";
  const draw = (f) => {
    if (typeof f.data !== "string") return;
    if (!term || f.cols !== cols || f.rows !== rows) {
      if (term) term.dispose();
      cols = f.cols; rows = f.rows; last = "";
      term = new window.Terminal({
        cols, rows, scrollback: 1000, disableStdin: true, cursorBlink: false, fontSize: 13,
        // Links in the screen open nothing.
        linkHandler: { activate: () => {} },
        theme: { background: "#0b0d10" },
      });
      term.open(view);
    }
    if (f.data === last) return;
    last = f.data;
    term.reset();
    term.write(f.data);
  };
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
    if (form) form.hidden = false;
    for (const el of pis) el.hidden = !f.pi_view;
    draw(f);
    say((f.state === "ended" ? "Its last screen, kept when the trial ended · " : "Live, read only · ") + at + (f.queued ? " · " + f.queued + " of your inputs wait for the reset" : ""));
    if (wait) {
      wait.hidden = !f.limit;
      if (until) until.textContent = f.limit && f.limit.resets_at ? " at " + String(f.limit.resets_at).replace("T", " ").slice(0, 16) + " UTC" : "";
    }
  });
  pushed.addEventListener("waiting", () => say("Waiting for the rig to send its screen…"));
  pushed.addEventListener("busy", (ev) => { say(said(ev).said || "Not shown now."); pushed.close(); });
})();
`;
