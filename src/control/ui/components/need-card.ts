import type { RigView, RunView } from "../../views/index.ts";
import { runHref } from "../urls.ts";
import { span } from "../words/index.ts";
import { esc } from "./index.ts";

/**
 * A decision as one row that reads at a glance: what it is about, why it waits for the owner,
 * the facts that decide it and its buttons. Opened, it shows the question, the full evidence and
 * what each choice does. It keeps its open state across the page's refresh (data-k).
 */
export function card(o: {
  tone: "warn" | "bad" | "violet";
  ic: string;
  /** One or two words for the kind of decision: "Promote", "Blocked". */
  kind: string;
  question: string;
  /** What it is about (HTML, escaped): a change in its author's words, a rig, a goal. */
  headline: string;
  /** Why it waits for the owner, in one clause (HTML, escaped). */
  why: string;
  chips?: string | undefined;
  key: string;
  /** The rig it is about; none for control's own, which gives `where` instead. */
  u?: RigView | undefined;
  /** Where it is, in place of the rig and run (HTML, escaped). */
  where?: string | undefined;
  r?: RunView | undefined;
  lane?: string | null | undefined;
  since?: string | undefined;
  now: number;
  facts: string;
  /** Each choice; those with a button show it on the row. */
  choices: { button?: string | undefined; label: string; does: string }[];
  more?: string | undefined;
  /** The owner's choice already sent for this item, and the rig's answer (see decidedState). */
  decided?: { sent: boolean; html: string } | undefined;
}): { html: string; box: string; decided: boolean } {
  const u = o.u;
  const where =
    o.where ??
    (u && o.r
      ? `<a href="${runHref(o.r)}">${esc(o.r.campaign || o.r.id)} › ${esc(o.r.id)}</a> · ${esc(u.id)}${o.lane ? ` · ${esc(o.lane)}` : ""}`
      : u
        ? `rig <a href="/ui/rigs/${encodeURIComponent(u.id)}">${esc(u.id)}</a>`
        : "");
  // Once the owner has chosen, the row says so instead of offering the buttons again; a choice
  // the rig refused says why, and the buttons come back.
  const buttons = o.decided?.sent
    ? `<span class="dq-sent">${o.decided.html}</span>`
    : o.choices.flatMap((c) => (c.button ? [c.button] : [])).join("");
  if (o.decided && !o.decided.sent) o.why = `${o.why}<br>${o.decided.html}`;
  const choices = o.choices.map((c) => `<dt>${esc(c.label)}</dt><dd>${c.does}</dd>`).join("");
  const box = `<div class="decide decide-${o.tone}"><div class="decide-q"><span class="dq-kind">${o.ic}${esc(o.kind)}</span><b>${esc(o.question)}</b><span class="dq-age">${o.since ? `waiting ${esc(span(o.since, o.now))}` : ""}</span></div><div class="decide-why">${o.why}</div><div class="dq-btns">${buttons}</div><dl class="dq-choices">${choices}</dl></div>`;
  const html = `<details class="dq dq-${o.tone}" data-k="need-${esc(o.key)}"><summary>
<span class="dq-kind">${o.ic}${esc(o.kind)}</span>
<span class="dq-main"><span class="dq-head">${o.headline}</span><span class="dq-why">${o.why}</span><span class="dq-sub"><span class="dq-where">${where}</span>${o.chips ?? ""}</span></span>
<span class="dq-side">${o.since ? `<span class="dq-age">waiting ${esc(span(o.since, o.now))}</span>` : ""}<span class="dq-btns">${buttons}</span></span>
</summary><div class="dq-body"><p class="dq-q">${esc(o.question)}</p><dl class="dc-facts">${o.facts}</dl>
<dl class="dq-choices">${choices}</dl>${o.more ? `<div class="dq-foot">${o.more}</div>` : ""}</div></details>`;
  return { html, box, decided: o.decided?.sent === true };
}
