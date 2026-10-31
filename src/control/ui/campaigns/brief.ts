import { BRIEF_WHOLE_CHARS, briefOf } from "../../../core/brief.ts";
import { esc, infoLabel, MD_CORE_JS, mdHtml } from "../components/index.ts";

/**
 * A campaign's brief on the screens (goal 078): New campaign's step 2, The brief, takes it for
 * every mode (the owner's choice of 2026-10-22: its own step after Aim), and the campaign's page
 * shows it.
 *
 * - All modes: Additional information, Markdown with no length limit, with its preview beside it
 *   as you type; Starting links, one address per line; and Hypotheses, one per box.
 * - Hill climb and goal: Ideas to try, one per box.
 * - Research: the Topic and the Questions, one per box, each as long as it needs.
 *
 * The agents get it as starting points, not rules (core/brief.ts says where and how).
 */

/** The parts of a draft the brief fills (a draft sent back with mistakes fills them again). */
export interface BriefDraft {
  mode?: string | undefined;
  notes?: string | undefined;
  /** Hill climb and goal: the starting links. A research draft has them as research.seeds. */
  links?: string[] | undefined;
  ideas?: string[] | undefined;
  hypotheses?: string[] | undefined;
  research?:
    | {
        topic?: string | undefined;
        questions?: string[] | undefined;
        seeds?: string[] | undefined;
      }
    | undefined;
}

const TIP = {
  topic:
    "What the agents research, in one sentence. The questions and the additional information say more.",
  questions:
    "What the research must answer, one question in each box. A question can be long and have several lines. Every finding answers one of them. At least one.",
  notes:
    "What the agents should know, in Markdown: the project and its links, what was tried, limits, and what good looks like. No length limit. The planner, the workers and the advisors get it, and the run's folder keeps it as BRIEF.md. A worker's brief has the first 32,000 characters of the brief; the rest is in BRIEF.md.",
  links:
    "Pages for the agents, one address per line. Research: the harness fetches and archives them when the run starts. Hill climb and goal: the agents get them with the brief. Links in Additional information reach the agents too, but nothing fetches them first.",
  ideas:
    "Ideas you want tried, one in each box. The planner and the workers get them as starting points, not rules: the planner turns those that fit into experiments.",
  hypotheses:
    "What you think is true, one in each box. The agents test them; they are not facts. A research run starts with them as its hypotheses.",
};

const PLACEHOLDER = {
  topic: "Which methods keep long agent tasks stable?",
  questions:
    "Which papers since 2024 train agents on tasks of 100 steps or more? What do they report?",
  notes:
    "## Background\nWhat the project is, with links.\n\n## What was tried\nWhat worked, and what did not.\n\n## Limits\nWhat must not change.\n\n## What good looks like",
  links: "https://git.example.com/team/project/issues/12\nhttps://docs.example.com/design",
  ideas: "Fuse the dequantize step into the inner loop",
  hypotheses: "The kernel is memory bound at batch size 1",
};

type ListName = "questions" | "ideas" | "hypotheses";
const ITEM: Record<ListName, { add: string; one: string }> = {
  questions: { add: "Add a question", one: "question" },
  ideas: { add: "Add an idea", one: "idea" },
  hypotheses: { add: "Add a hypothesis", one: "hypothesis" },
};

/** One box of a list: its number, the text, and Remove. */
const entryRow = (name: ListName, value: string, i: number) =>
  `<div class="bl-row"><span class="bl-k">${i + 1}</span><textarea rows="2" data-bl-item="${name}" aria-label="${ITEM[name].one} ${i + 1}" placeholder="${esc(PLACEHOLDER[name])}">${esc(value)}</textarea><button class="sm ghost" data-bl-del aria-label="Remove this ${ITEM[name].one}">×</button></div>`;

/** A list of boxes, with Add and a count; one empty box when there is nothing yet. */
const entryList = (name: ListName, items: string[]) =>
  `<div class="bl" data-bl="${name}">${(items.length ? items : [""]).map((x, i) => entryRow(name, x, i)).join("")}</div><div class="act bl-act"><button class="sm" data-bl-add="${name}">${ITEM[name].add}</button><span class="muted small" data-bl-n="${name}"></span></div>`;

const listField = (name: ListName, label: string, items: string[], modes = "") =>
  `<div class="fd"${modes ? ` data-modes="${modes}"` : ""}>${infoLabel(label, TIP[name])}${entryList(name, items)}</div>`;

/** New campaign's step 2, The brief: its pane, with Back and Next. */
export function briefPane(d: BriefDraft): string {
  const notes = d.notes ?? "";
  const links = (d.mode === "research" ? d.research?.seeds : d.links) ?? [];
  return `<section class="pane" data-pane="brief" hidden><div class="sec nc-brief" id="brief"><h2>The brief</h2><p class="lead">What the agents should know. They get it as starting points, not rules.</p>
<div data-modes="research"><label class="fd">${infoLabel("Topic", TIP.topic)}<input name="topic" value="${esc(d.research?.topic ?? "")}" placeholder="${esc(PLACEHOLDER.topic)}"></label>
${listField("questions", "Questions", d.research?.questions ?? [])}</div>
<div class="fd">${infoLabel("Additional information", TIP.notes)}<div class="md-two"><textarea name="notes" class="md-in" placeholder="${esc(PLACEHOLDER.notes)}">${esc(notes)}</textarea><div class="md-out md" data-md-out aria-live="polite">${notes.trim() ? mdHtml(notes) : `<span class="muted">The preview shows here.</span>`}</div></div><div class="small muted" data-md-say>Markdown. Empty is fine.</div></div>
<label class="fd">${infoLabel("Starting links", TIP.links)}<textarea name="links" class="nc-links" placeholder="${esc(PLACEHOLDER.links)}">${esc(links.join("\n"))}</textarea><span class="small muted" data-links-say>One address per line. Empty is fine.</span></label>
${listField("ideas", "Ideas to try", d.ideas ?? [], "hill_climb goal")}
${listField("hypotheses", "Hypotheses", d.hypotheses ?? [])}
<div class="act" style="margin-top:14px"><button data-back>Back</button><button class="primary" data-next>Next</button></div></div></section>`;
}

/**
 * The brief's page-free part, as the browser runs it (and the tests, as the browser does):
 * - `briefDraft(mode, f)`: the draft's brief from the fields' values, `f` = {notes, links, ideas,
 *   hypotheses} (links as typed, the lists as boxes): entries trimmed, empty ones left out, links
 *   and ideas only for hill climb and goal (a research draft has its links as research.seeds);
 * - `briefSay(chars, bytes)`: the line under Additional information, for the brief's size;
 * - `briefLinks(text)`: Starting links as typed: `{links, bad}`, every line with words, and the
 *   numbers of the lines that are not http or https addresses.
 */
export const BRIEF_CORE_JS = `
${MD_CORE_JS}
const BRIEF_WHOLE = ${BRIEF_WHOLE_CHARS};
const BRIEF_SEND_MAX = 3000000;
const briefList = (xs) => (xs || []).map((x) => String(x).trim()).filter(Boolean);
const briefLinks = (text) => {
  const all = String(text || "").split("\\n").map((x) => x.trim());
  const links = [], bad = [];
  all.forEach((x, i) => {
    if (!x) return;
    links.push(x);
    let ok = false;
    try { const u = new URL(x); ok = (u.protocol === "https:" || u.protocol === "http:") && !/\\s/.test(x); } catch {}
    if (!ok) bad.push(i + 1);
  });
  return { links, bad };
};
const briefDraft = (mode, f) => {
  const d = {};
  if (String(f.notes || "").trim()) d.notes = String(f.notes).replace(/\\s+$/, "");
  if (mode !== "research" && briefLinks(f.links).links.length) d.links = briefLinks(f.links).links;
  if (mode !== "research" && briefList(f.ideas).length) d.ideas = briefList(f.ideas);
  if (briefList(f.hypotheses).length) d.hypotheses = briefList(f.hypotheses);
  return d;
};
const briefSay = (chars, bytes) => {
  const n = (x) => Number(x).toLocaleString("en-US");
  if (!chars) return "Markdown. Empty is fine.";
  if (bytes > BRIEF_SEND_MAX) return "Too long to send: a campaign goes to a rig in one command of at most 3.5 MiB.";
  if (chars > BRIEF_WHOLE) return "Markdown · " + n(chars) + " characters. Each worker's brief has the first " + n(BRIEF_WHOLE) + "; the rest is in BRIEF.md in the run's folder. The planner gets all of it, and the advisors as much as their window takes.";
  return "Markdown · " + n(chars) + " characters. Every agent gets all of it.";
};`;

/**
 * The brief's part of the page's script (inside NEW_CAMPAIGN_JS, which gives it form, $, $$ and
 * update): boxes added and removed, each growing with its text, the preview and the line under
 * Additional information, and each list's count. The preview is mdHtml's: everything escaped.
 */
export const BRIEF_PAGE_JS = `
  // ------------------------------------------------ the brief (goal 078)
  const BL_ONE = { questions: ["question", "questions"], ideas: ["idea", "ideas"], hypotheses: ["hypothesis", "hypotheses"] };
  const blItems = (name) => $$('[data-bl-item="' + name + '"]').map((t) => t.value);
  // A box grows with its text; a hidden one (another mode's) keeps the page's height until shown.
  const blGrow = (t) => { if (!t.offsetParent) { t.style.height = ""; return; } t.style.height = "auto"; t.style.height = Math.min(t.scrollHeight + 2, 480) + "px"; };
  const blNumber = (box) => $$(".bl-row", box).forEach((r, i) => {
    $(".bl-k", r).textContent = String(i + 1);
    $("textarea", r).setAttribute("aria-label", BL_ONE[box.dataset.bl][0] + " " + (i + 1));
  });
  /** A list's boxes, from a draft sent back: one box for each entry, or one empty box. */
  const blFill = (name, items) => {
    const box = $('[data-bl="' + name + '"]');
    if (!box || !Array.isArray(items)) return;
    const tpl = $(".bl-row", box);
    box.replaceChildren(...(items.length ? items : [""]).map((x) => { const r = tpl.cloneNode(true); $("textarea", r).value = x; return r; }));
    blNumber(box);
  };
  form.addEventListener("click", (e) => {
    const add = e.target.closest("[data-bl-add]");
    if (add) {
      e.preventDefault();
      const box = $('[data-bl="' + add.dataset.blAdd + '"]'), row = $(".bl-row", box).cloneNode(true);
      $("textarea", row).value = ""; $("textarea", row).style.height = "";
      box.append(row); blNumber(box); $("textarea", row).focus(); update();
    }
    const del = e.target.closest("[data-bl-del]");
    if (del) {
      e.preventDefault();
      const box = del.closest("[data-bl]"), rows = $$(".bl-row", box);
      if (rows.length > 1) del.closest(".bl-row").remove(); else $("textarea", rows[0]).value = "";
      blNumber(box); update();
    }
  });
  form.addEventListener("input", (e) => { if (e.target.matches && e.target.matches(".bl-row textarea")) blGrow(e.target); });
  /** The brief's fields as they are now: the draft takes them from here. */
  const briefFieldsNow = () => ({ notes: form.elements.notes ? form.elements.notes.value : "", links: form.elements.links ? form.elements.links.value : "", ideas: blItems("ideas"), hypotheses: blItems("hypotheses") });
  let mdLast = null;
  const briefUpdate = () => {
    const f = briefFieldsNow(), text = f.notes;
    if (text !== mdLast) {
      mdLast = text;
      const out = $("[data-md-out]");
      if (out) out.innerHTML = text.trim() ? mdHtml(text) : '<span class="muted">The preview shows here.</span>';
    }
    const all = [text, f.links, ...f.ideas, ...f.hypotheses].join("\\n");
    const bytes = new TextEncoder().encode(all).length;
    const say = $("[data-md-say]");
    if (say) {
      say.textContent = briefSay(text.trim() ? all.length : 0, bytes);
      say.classList.toggle("bad", bytes > BRIEF_SEND_MAX);
    }
    const ls = $("[data-links-say]");
    if (ls) {
      const l = briefLinks(f.links);
      ls.textContent = l.bad.length
        ? "Line " + l.bad.join(", ") + (l.bad.length === 1 ? " is" : " are") + " not a web address: write each as https://…"
        : l.links.length ? l.links.length + (l.links.length === 1 ? " link." : " links.") : "One address per line. Empty is fine.";
      ls.className = "small " + (l.bad.length ? "bad" : "muted");
    }
    for (const name of Object.keys(BL_ONE)) {
      const el = $('[data-bl-n="' + name + '"]');
      if (!el) continue;
      const n = briefList(blItems(name)).length;
      el.textContent = n ? n + " " + BL_ONE[name][n === 1 ? 0 : 1] : name === "questions" ? "At least one." : "None yet. Empty is fine.";
      el.classList.toggle("bad", name === "questions" && !n);
    }
  };
  $$(".bl-row textarea").forEach(blGrow);`;

// ---------------------------------------------------------------- the campaign's page

const entryHtml = (s: string) => esc(s).replace(/\n/g, "<br>");
const fmt = (n: number) => n.toLocaleString("en-US");

/**
 * The brief on the campaign's page: the research questions, the starting links (as links, http
 * and https only), the ideas to try and the hypotheses, then the additional information as
 * Markdown, folded when it is long. "" when the contract has no brief and no questions.
 */
export function campaignBriefBlock(contract: unknown): string {
  const c = (contract ?? {}) as { mode?: unknown; questions?: unknown };
  const b = briefOf(contract);
  const questions =
    c.mode === "research" && Array.isArray(c.questions)
      ? c.questions.filter((q): q is string => typeof q === "string")
      : [];
  if (!b && !questions.length) return "";
  const part = (label: string, tip: string, items: string[], say = "") =>
    items.length
      ? `<div class="kb-part">${infoLabel(label, tip)}${say ? `<div class="muted small">${esc(say)}</div>` : ""}<ol class="kb-list">${items.map((x) => `<li>${entryHtml(x)}</li>`).join("")}</ol></div>`
      : "";
  const linkHtml = (x: string) =>
    /^https?:\/\/\S+$/.test(x)
      ? `<a href="${esc(x)}" rel="noopener noreferrer" target="_blank">${esc(x)}</a>`
      : esc(x);
  const links = b?.links.length
    ? `<div class="kb-part">${infoLabel("Starting links", "Pages for the agents. Research: the harness fetches and archives them when a run starts. Hill climb and goal: the agents get them with the brief.")}<ul class="kb-list">${b.links.map((x) => `<li>${linkHtml(x)}</li>`).join("")}</ul></div>`
    : "";
  const notes = b?.notes ?? "";
  // Open when short; a long text folds, with its size in its summary.
  const info = notes
    ? `<details class="kb-info"${notes.length <= 1500 ? " open" : ""}><summary><b>Additional information</b> <span class="muted small">${fmt(notes.length)} characters · Markdown · the run's folder keeps it as BRIEF.md</span></summary><div class="md">${mdHtml(notes)}</div></details>`
    : "";
  return `<div class="block" id="brief"><div class="head"><h2>The brief</h2><span class="right">what its agents know: starting points, not rules</span></div><div class="card kbrief">${part("Questions", "What the research must answer. Every finding answers one of them.", questions)}${links}${part("Ideas to try", "The planner and the workers get them as starting points, not rules.", b?.ideas ?? [])}${part("Hypotheses", "What the campaign's author thinks is true, for the agents to test.", b?.hypotheses ?? [], c.mode === "research" ? "Each run starts with these as its hypotheses." : "")}${info}</div></div>`;
}
