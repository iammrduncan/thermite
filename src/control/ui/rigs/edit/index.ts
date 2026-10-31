import { EFFORTS } from "../../../../core/agents.ts";
import { COMPACT_AT_DEFAULT } from "../../../../core/compaction.ts";
import type { AdvisorSetupView, AdvisorsFileView } from "../../../rigs/index.ts";
import type { AgentRole } from "../../../store/index.ts";
import { infoLabel } from "../../campaigns/new/index.ts";
import { esc } from "../../components/index.ts";

export { EDIT_RIG_JS } from "./client.ts";

/**
 * Edit rig's section "2 · The agents" (goals 070, 073 and 074, as the owner approved the revised
 * mockup on 2026-10-21): the agents in two groups, The work (the workers and the planner) and The
 * advisors (the teachers, the auditor, the review panel, and a research run's synthesizer and
 * final writer, goal 166), each with its job on one line. Every
 * line has a Model, an Effort, a Runs in and a Context cell (the window and the compaction point,
 * changed in a small panel that opens under the cell). The teachers take one model or two; with
 * two, a merged by line joins their suggestions.
 *
 * A line with no model says what its agent uses then (goal 074; the owner, 2026-10-21: "what is
 * default of default?"): the workers the rig's own settings, the planner the workers' model, an
 * advisor the model in the rig's advisors file, as the supervisor reports it ("rig's file:
 * opus-5.5"), or none, and then the advisor is off ("none: off"). Until the supervisor has said,
 * "rig's file". The greyed Runs in and Context cells show the file's harness and window. The
 * synthesizer and the final writer with no model use the first teacher's ("same as the first
 * teacher"), as the planner uses the workers'.
 *
 * Every field has a form name, so the form posts without the page's script
 * (/ui/assets/edit-rig.js, edit/client.ts): the workers' `choice`, `effort`, `harness`,
 * `context_workers` and `compact_workers`; every other line's `role_<id>`, `effort_<id>`,
 * `harness_<id>`, `context_<id>` and `compact_<id>`, by the role it sets. The Context panel is a
 * details element, so it opens without the script too. "+ second teacher" and × are links to the
 * page with the second teacher's lines shown or emptied; the script does the same in place.
 */

/** A line of the agents' table: the workers, or the role a line sets. */
export type AgentLineId = "workers" | AgentRole;

/** A model in a line's list, with what the page's script needs to check it. */
export interface AgentModelOption {
  /** "provider|model", each part URI-encoded. */
  value: string;
  label: string;
  provider: string;
  model: string;
  /** Where it runs: claude (a Claude subscription), chatgpt, opencode (OpenCode's own), key. */
  kind: "claude" | "chatgpt" | "opencode" | "key";
  /** Whether Codex can reach its provider (OpenAI's Responses API). */
  codex: boolean;
  /** The context window its provider lists, in tokens; 0: none. */
  window: number;
}
export interface AgentModelGroup {
  label: string;
  options: AgentModelOption[];
}

/** What control keeps for one line now. */
export interface AgentLineNow {
  /** The model's option value; "": none (the line's default). */
  picked: string;
  effort: string | null;
  /** The harness it runs in; null: none chosen. */
  harness: string | null;
  cap: number | null;
  at: number | null;
  /** The model control keeps, when the page shows the line emptied (the second teacher after ×). */
  was?: string | undefined;
}

interface LineSpec {
  id: AgentLineId;
  name: string;
  job: string;
  tip: string;
  /** The model list's empty choice, for the lines whose default is not reported. */
  empty: string;
  /** An advisor whose file names none: what that means, as a sentence's end. */
  off?: string;
  /** For sentences: who, whose, and the verb's -s. */
  who: string;
  poss: string;
  s: string;
  kind: "workers" | "planner" | "advisor";
  /** A later line of the Teachers row. */
  sub?: "teacher2" | "merged_by";
  /** An advisor that uses the first teacher's model when it has none of its own (goal 166). */
  follows?: "teachers";
}

const LINES: LineSpec[] = [
  {
    id: "workers",
    name: "Workers",
    job: "Change the code, one trial each.",
    tip: "The agents that change the code, one for each lane. They run for many turns, so they use the most of a subscription. With no model here, they use the model in the rig's own settings, set where the rig is deployed. With none there, they can't run.",
    empty: "rig's settings",
    who: "the workers",
    poss: "the workers'",
    s: "",
    kind: "workers",
  },
  {
    id: "planner",
    name: "Planner",
    job: "Picks what each worker tries next.",
    tip: "A few calls in each round. With no model of its own, it uses the workers' model, harness and context.",
    empty: "same as the workers",
    who: "the planner",
    poss: "the planner's",
    s: "s",
    kind: "planner",
  },
  {
    id: "teachers",
    name: "Teachers",
    job: "Read recent trials and suggest next steps.",
    tip: "One or two models. Each reads the recent trials and past research, and suggests next steps, each with a source. Add a second teacher under the first: then a merged-by model joins their suggestions into one set for the planner. With no model here, the teachers are the ones in the rig's advisors file. If the file has none, there are no teachers.",
    empty: "rig's file",
    off: "so there are no teachers",
    who: "the teacher",
    poss: "the teacher's",
    s: "s",
    kind: "advisor",
  },
  {
    id: "second_teacher",
    name: "",
    job: "",
    tip: "",
    empty: "choose a model",
    who: "teacher 2",
    poss: "teacher 2's",
    s: "s",
    kind: "advisor",
    sub: "teacher2",
  },
  {
    id: "merged_by",
    name: "",
    job: "",
    tip: "",
    empty: "rig's file",
    off: "so the first review that comes back is the set",
    who: "the merged-by model",
    poss: "the merged-by model's",
    s: "s",
    kind: "advisor",
    sub: "merged_by",
  },
  {
    id: "auditor",
    name: "Auditor",
    job: "Checks a win before it is kept.",
    tip: "It looks for a hidden flaw in a win before the win becomes the champion, when the campaign asks for an audit. With no model here, it is the auditor in the rig's advisors file. If the file has none, there is no auditor, and audits wait for you.",
    empty: "rig's file",
    off: "so there is no auditor",
    who: "the auditor",
    poss: "the auditor's",
    s: "s",
    kind: "advisor",
  },
  {
    id: "review_panel",
    name: "Review panel",
    job: "Scores goals that code can't measure.",
    tip: "Three reviewers, all on this model, score the goals that need judgement. A goal is met only when you accept it. The judge's numbers never come from them. With no model here, it is the review panel in the rig's advisors file. If the file has none, there is no review panel, and those goals stay open.",
    empty: "rig's file",
    off: "so there is no review panel",
    who: "the review panel",
    poss: "the review panel's",
    s: "s",
    kind: "advisor",
  },
  {
    id: "synthesizer",
    name: "Synthesizer",
    job: "Writes each research question's answer card.",
    tip: "In a research run, it rewrites the answer card of each question whose evidence changed, from the run's verified claims. Code checks each card before it is kept. With no model here, it uses the first teacher's model, harness and context. With no teacher at all, there is no synthesizer, and the cards wait.",
    empty: "same as the first teacher",
    who: "the synthesizer",
    poss: "the synthesizer's",
    s: "s",
    kind: "advisor",
    follows: "teachers",
  },
  {
    id: "final_writer",
    name: "Final writer",
    job: "Writes a research run's paper when it ends.",
    tip: "When a research run ends, it writes the run's research paper in Simplified Technical English. Code checks the paper before it is kept. With no model here, it uses the first teacher's model, harness and context. With no teacher at all, there is no final writer, and the paper waits.",
    empty: "same as the first teacher",
    who: "the final writer",
    poss: "the final writer's",
    s: "s",
    kind: "advisor",
    follows: "teachers",
  },
];

/** The harnesses, as Runs in offers them on every line (goal 073). */
const HARNESS_CHOICES: [string, string][] = [
  ["pi", "Pi"],
  ["opencode", "OpenCode v2"],
  ["claude-code", "Claude Code"],
  ["codex", "Codex"],
];

const AGENT_TIP =
  "Each agent, with its job under its name. The work runs in the rig's harness. The advisors run in the supervisor and never judge: code measures each change and decides.";
const MODEL_TIP =
  "The model of each agent, from Settings › Providers. A subscription's models show as claude-code:…; control gives the rig a subscription's login only while one of its agents uses it. The empty choice says what the agent uses with no model here. The workers: the model in the rig's own settings. The planner: the workers' model. The synthesizer and the final writer: the first teacher's model. Another advisor: the model in the rig's advisors file, such as \"rig's file: opus-5.5\". \"none: off\": the file has none, so that advisor does not run. \"rig's file\" alone: the rig's supervisor has not reported its file yet.";
const EFFORT_TIP =
  "How long the model thinks before it answers. More effort: better answers, slower, and more of a subscription's window. Providers other than a Claude subscription take up to high. \"model's default\": Thermite sends no effort, and the model (or Claude Code) uses its own.";
const RUNS_TIP =
  "The program that runs the agent: Pi, OpenCode v2, Claude Code or Codex. Each agent can have its own. A Claude subscription runs only in Claude Code, Anthropic's own program. OpenCode's own free models run only in OpenCode. Codex, OpenAI's own program, takes a ChatGPT subscription or an OpenAI-compatible key. The planner with no model of its own runs where the workers run. A line with no model shows, greyed, where its agent runs then: an advisor where the rig's advisors file runs it, or — when it is off. The advisors run in the supervisor, each in its own folder, with no project to change: they get only Thermite's tools for advisors (past research and the kit's MCP tools).";
const CTX_TIP =
  "Each agent's context window (the most its model reads in one request) and its compaction point (when its conversation is compacted). Press a cell to change them. Empty: the provider's window, and 80%. Bold: set on this rig. A line with no model shows, greyed, the context its agent has then: for an advisor, the window and point of the rig's advisors file, or — when it is off. These are the rig's defaults: a campaign can set a smaller window and its own point for all its runs.";
const WORK_TIP =
  "The agents that do the research, in the rig's harness. The workers change the code; the planner picks what each worker tries next.";
const ADV_TIP =
  "The agents that advise, in the supervisor. They read the work, then suggest, check or score. They never judge: the judge's code measures each change and decides.";
const MB_TIP =
  "With two teachers, this model joins their suggestions into one set for the planner. Empty: the merged-by model in the rig's advisors file. If the file has none, the first review that comes back is the set.";
/** The fields' own tips; the page's script adds what the line's harness does. */
const WINDOW_TIP = "The most the model reads in one request, in tokens.";
const POINT_TIP = "When the conversation is compacted: a percent of the context window.";

/** The form names of a line's fields. */
export const lineFields = (id: AgentLineId) =>
  id === "workers"
    ? {
        model: "choice",
        effort: "effort",
        harness: "harness",
        window: "context_workers",
        point: "compact_workers",
      }
    : {
        model: `role_${id}`,
        effort: `effort_${id}`,
        harness: `harness_${id}`,
        window: `context_${id}`,
        point: `compact_${id}`,
      };

const tokens = (n: number) => n.toLocaleString("en-US");

/**
 * What an agent with no model on control uses, as control knows it (goal 074). `workers`: the
 * model of the rig's own settings, as its harness reports it; null, it has none; undefined,
 * control can't tell (an older harness, or one on control's model now). `advisors`: what the
 * rig's advisors file sets up, as its supervisor reports it; undefined, not reported yet.
 */
export interface AgentDefaults {
  workers: string | null | undefined;
  advisors: AdvisorsFileView | undefined;
}

/** What a line with no model shows and says: its Model, Runs in and Context, and a sentence. */
interface LineFallback {
  /** The model list's empty choice. */
  model: string;
  /** Runs in's empty choice (none: the line has none). */
  runs: string;
  /** The Context cell, greyed. */
  ctx: string;
  /** For "You change the auditor's model to …". */
  say: string;
  /** An advisor that is off: the file names none. */
  off: boolean;
}

/** A harness as Runs in shows it; cli is a command-line agent of the advisors file. */
const HARNESS_WORDS: Record<string, string> = {
  pi: "Pi",
  opencode: "OpenCode v2",
  "claude-code": "Claude Code",
  codex: "Codex",
  cli: "command line",
};
const distinct = (xs: string[]) => [...new Set(xs)].join(", ");
const setupContext = (a: AdvisorSetupView) =>
  a.harness === "cli"
    ? "—"
    : `${a.context_window ? tokens(a.context_window) : "no window"} · ${a.compact_at ?? COMPACT_AT_DEFAULT}%`;

/** The advisors file's setups for a line's role: the teachers, merged by, auditor, review panel. */
function fileSetups(id: AgentLineId, file: AdvisorsFileView): AdvisorSetupView[] {
  if (id === "teachers") return file.teachers;
  if (id === "review_panel") return file.review_panel;
  const one = id === "merged_by" ? file.merged_by : id === "auditor" ? file.auditor : null;
  return one ? [one] : [];
}

/** A setup's harness, as Runs in shows it. */
const harnessWords = (a: AdvisorSetupView) =>
  (Object.hasOwn(HARNESS_WORDS, a.harness) && HARNESS_WORDS[a.harness]) || a.harness;

/**
 * What a line that uses the first teacher's model shows with none of its own: the first teacher
 * of the rig's advisors file, as the page opens (the page's script follows the Teachers line).
 */
function followerFallback(spec: LineSpec, d: AgentDefaults): LineFallback {
  const say = "the first teacher's model";
  if (!d.advisors)
    return {
      model: spec.empty,
      runs: "as the first teacher",
      ctx: "as the first teacher",
      say,
      off: false,
    };
  const first = d.advisors.teachers[0];
  if (!first)
    return {
      model: spec.empty,
      runs: "—",
      ctx: "—",
      say: `${say}: none, as the rig's advisors file has no teachers, so it is off until it or the teachers have a model`,
      off: true,
    };
  return {
    model: spec.empty,
    runs: harnessWords(first),
    ctx: setupContext(first),
    say: `${say} (rig's file: ${first.model ?? "a command-line agent"})`,
    off: false,
  };
}

/** What a line with no model shows: the real default, as far as control knows it. */
function lineFallback(spec: LineSpec, d: AgentDefaults): LineFallback {
  if (spec.follows) return followerFallback(spec, d);
  if (spec.kind === "workers") {
    if (d.workers === null)
      return {
        model: "none: can't run",
        runs: "",
        ctx: "—",
        say: "none: the rig's own settings have no model, so the workers can't run",
        off: true,
      };
    return {
      model: d.workers ? `rig's settings: ${d.workers}` : "rig's settings",
      runs: "",
      ctx: "rig's settings",
      say: d.workers ? `the rig's own settings (${d.workers})` : "the rig's own settings",
      off: false,
    };
  }
  if (spec.kind === "planner")
    return {
      model: spec.empty,
      runs: "as the workers",
      ctx: "as the workers",
      say: "the workers' model",
      off: false,
    };
  if (spec.sub === "teacher2")
    return { model: spec.empty, runs: "—", ctx: "—", say: spec.empty, off: false };
  if (!d.advisors)
    return {
      model: spec.empty,
      runs: spec.empty,
      ctx: spec.empty,
      say: "the one in the rig's advisors file, if it has one",
      off: false,
    };
  const set = fileSetups(spec.id, d.advisors);
  if (!set.length)
    return {
      model: "none: off",
      runs: "—",
      ctx: "—",
      say: `none: the rig's advisors file has none, ${spec.off ?? "so it is off"}`,
      off: true,
    };
  const models = distinct(set.map((a) => a.model ?? "a command-line agent"));
  return {
    model: `rig's file: ${models}`,
    runs: distinct(set.map(harnessWords)),
    ctx: distinct(set.map(setupContext)),
    say: `the one in the rig's advisors file (${models})`,
    off: false,
  };
}

/**
 * The Context cell's text as the page opens: the window and the point, bold where set here.
 * `followed`: the summary of the line one with no model follows (the workers' for the planner,
 * the first teacher's for the synthesizer and the final writer); "" when that line has no model.
 */
function contextSummary(
  spec: LineSpec,
  now: AgentLineNow,
  window: number,
  followed: string,
  fb: LineFallback,
): string {
  if (!now.picked) {
    if (spec.kind === "planner")
      return `<span class="muted">as the workers${followed ? `: ${followed}` : ""}</span>`;
    if (spec.follows && followed)
      return `<span class="muted">as the first teacher: ${followed}</span>`;
    return `<span class="muted">${esc(fb.ctx)}</span>`;
  }
  const win = now.cap ?? window;
  const w = win ? tokens(win) : "no window";
  const p = now.at ?? COMPACT_AT_DEFAULT;
  return `${now.cap ? `<b>${w}</b>` : w} · ${now.at ? `<b>${p}%</b>` : `${p}%`}`;
}

/** One line's model list. */
function modelOptions(empty: string, groups: AgentModelGroup[], picked: string): string {
  return `<option value="" data-kind="">${esc(empty)}</option>${groups
    .map(
      (g) =>
        `<optgroup label="${esc(g.label)}">${g.options
          .map(
            (o) =>
              `<option value="${esc(o.value)}" data-kind="${o.kind}" data-provider="${esc(o.provider)}" data-model="${esc(o.model)}" data-window="${o.window}"${o.codex ? ` data-codex="1"` : ""}${o.value === picked ? " selected" : ""}>${esc(o.label)}</option>`,
          )
          .join("")}</optgroup>`,
    )
    .join("")}`;
}

export interface AgentsTableInput {
  groups: AgentModelGroup[];
  now: Record<AgentLineId, AgentLineNow>;
  /** Whether the second teacher's lines show as the page opens. */
  two: boolean;
  /** The page's own address, for "+ second teacher" and × without the script. */
  href: string;
  /** What an agent with no model uses; left out, control knows none of it. */
  defaults?: AgentDefaults | undefined;
}

/** The agents' table, with its subscription call-out under it. */
export function agentsTable(o: AgentsTableInput): string {
  const windowOf = (picked: string) =>
    o.groups.flatMap((g) => g.options).find((x) => x.value === picked)?.window ?? 0;
  /** A line's window and point in short, when it has a model; "" when it has none. */
  const summaryOf = (n: AgentLineNow) => {
    const win = n.cap ?? windowOf(n.picked);
    return n.picked ? `${win ? tokens(win) : "no window"} · ${n.at ?? COMPACT_AT_DEFAULT}%` : "";
  };
  const followed = { workers: summaryOf(o.now.workers), teachers: summaryOf(o.now.teachers) };
  const defaults = o.defaults ?? { workers: undefined, advisors: undefined };
  const line = (spec: LineSpec) => {
    const now = o.now[spec.id];
    const fb = lineFallback(spec, defaults);
    const f = lineFields(spec.id);
    const hidden = spec.sub !== undefined && !o.two;
    const label = esc(spec.poss);
    const model = `<select name="${f.model}" data-role="${spec.id}" data-label="${label} model" aria-label="${label} model"${now.was !== undefined ? ` data-was="${esc(now.was)}"` : ""}>${modelOptions(fb.model, o.groups, now.picked)}</select>`;
    const first =
      spec.sub !== undefined
        ? `<div class="ag-sp"></div>`
        : `<div class="ag">${infoLabel(spec.name, spec.tip)}<span class="job">${esc(spec.job)}</span></div>`;
    const modelCell =
      spec.sub === "teacher2"
        ? `<div class="t2-m">${model}<a class="btn t2-x" href="${esc(o.href)}?teachers=1#agents" data-t2-x title="Remove the second teacher" aria-label="Remove the second teacher">×</a></div>`
        : spec.sub === "merged_by"
          ? `<div class="mb-m">${infoLabel("merged by", MB_TIP)}${model}</div>`
          : model;
    const effort = `<select name="${f.effort}" data-effort="${spec.id}" data-label="${label} effort" aria-label="${label} effort">${[
      ["", "model's default"],
      ...EFFORTS.map((e) => [e, e]),
    ]
      .map(
        ([v, t]) =>
          `<option value="${v}"${(now.effort ?? "") === v ? " selected" : ""}>${t}</option>`,
      )
      .join("")}</select>`;
    const runs = spec.kind === "workers" ? "run" : "runs";
    // A line that follows the Teachers line, which has a model: where the first teacher runs.
    const runsWith = spec.follows && o.now.teachers.picked ? "as the first teacher" : fb.runs;
    const firstRun =
      spec.kind === "workers"
        ? ""
        : `<option value=""${now.harness ? "" : " selected"}>${esc(runsWith)}</option>`;
    const harness = `<select name="${f.harness}" data-runs-in="${spec.id}" data-label="where ${esc(spec.who)} ${runs}" aria-label="where ${esc(spec.who)} ${runs}">${firstRun}${HARNESS_CHOICES.map(
      ([v, t]) =>
        `<option value="${v}"${(now.harness ?? (spec.kind === "workers" ? "pi" : "")) === v ? " selected" : ""}>${t}</option>`,
    ).join("")}</select>`;
    const ctx = `<details class="ctx-w" data-ctx="${spec.id}"><summary class="ctx-b" title="Press to change the context window and the compaction point" aria-label="${label} context"><span class="ctx-v"><span class="ctx-k">Context: </span><span data-ctx-sum="${spec.id}">${contextSummary(spec, now, windowOf(now.picked), spec.follows ? followed.teachers : followed.workers, fb)}</span></span><span class="ctx-car" aria-hidden="true"></span></summary>
<div class="ctx-pop" role="group" aria-label="${label} context">
<label class="ctx-f">${infoLabel("Context window", WINDOW_TIP)}<input name="${f.window}" data-cap value="${now.cap ?? ""}" placeholder="${now.picked && windowOf(now.picked) ? esc(tokens(windowOf(now.picked))) : "none"}" inputmode="numeric" autocomplete="off" spellcheck="false"><span class="muted">tokens</span></label>
<label class="ctx-f">${infoLabel("Compact at", POINT_TIP)}<input name="${f.point}" data-at value="${now.at ?? ""}" placeholder="${COMPACT_AT_DEFAULT}" inputmode="numeric" autocomplete="off" spellcheck="false"><span class="muted">%</span></label>
<div class="ctx-msg" data-ctx-msg aria-live="polite"></div>
</div></details>`;
    return `<div class="ln${spec.sub ? " sub" : ""}" data-line="${spec.id}" data-kind="${spec.kind}" data-who="${esc(spec.who)}" data-poss="${esc(spec.poss)}" data-s="${spec.s}" data-fb-ctx="${esc(fb.ctx)}" data-fb-say="${esc(fb.say)}"${fb.off ? ` data-fb-off="1"` : ""}${spec.sub ? ` data-sub="${spec.sub}"` : ""}${spec.follows ? ` data-follows="${spec.follows}" data-fb-runs="${esc(fb.runs)}"` : ""}${hidden ? " hidden" : ""}>${first}${modelCell}${effort}${harness}${ctx}</div><div class="row-say" data-row-say="${spec.id}" hidden></div>`;
  };
  const byId = (id: AgentLineId) => LINES.find((l) => l.id === id) as LineSpec;
  const grp = (name: string, sub: string, tip: string) =>
    `<div class="grp">${infoLabel(name, tip)}<span class="muted small">${esc(sub)}</span></div>`;
  return `<div class="roles" data-agents><div class="hd">${infoLabel("Agent", AGENT_TIP)}</div><div class="hd">${infoLabel("Model", MODEL_TIP)}</div><div class="hd">${infoLabel("Effort", EFFORT_TIP)}</div><div class="hd">${infoLabel("Runs in", RUNS_TIP)}</div><div class="hd">${infoLabel("Context", CTX_TIP)}</div>
${grp("The work", "in the rig's harness", WORK_TIP)}
${line(byId("workers"))}
${line(byId("planner"))}
${grp("The advisors", "in the supervisor; they never judge", ADV_TIP)}
${line(byId("teachers"))}
${line(byId("second_teacher"))}
<div class="ln add" data-t2-addline${o.two || !o.now.teachers.picked ? " hidden" : ""}><div class="ag-sp"></div><div class="t2-add-c"><a class="btn sm ghost" href="${esc(o.href)}?teachers=2#agents" data-t2-add>+ second teacher</a></div></div>
${line(byId("merged_by"))}
${line(byId("auditor"))}
${line(byId("review_panel"))}
${line(byId("synthesizer"))}
${line(byId("final_writer"))}</div><div class="flag" id="share" hidden></div>`;
}
