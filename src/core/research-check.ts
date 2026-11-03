/**
 * The names the harness and control share for the check that ends a research run (goal 112):
 * after its minimum running time, the review panel checks whether every question is answered, and
 * a final writer writes the run's research paper. Also the progress rule's limits, which end a run
 * whose research stopped adding (goal 117).
 */

/**
 * What a research run can and cannot do, for each agent that works on one or reviews it: its
 * evidence is what archived sources say, and nothing it runs is measured. A fact only a
 * measurement can settle is one of its paper's next experiments, for a goal or hill-climb run.
 */
export const MEASURES_NOTHING =
  "A research run reads, archives and cites sources, and its evidence is what those sources say. It has no target to measure, and nothing its workers run counts as evidence: no benchmark, no test on the hardware its questions are about, no change to a deployed system. A fact that only such a measurement could settle is not a gap that research can close: it is a next experiment, for a goal or hill-climb run to take after this one.";

/** Words that a verb of measuring starts: "Time the kernel", "and measure how", "to time it". */
const VERB_START = String.raw`(?:^|[.;:!?(]\s*|\b(?:to|and|then|or|first|please|must|should|we|you)\s+)`;
const OBJECT = String.raw`(?:it|this|that|them|these|those|the|each|both|our|its|how|whether|with|on|under|using|a|an)\b`;

/**
 * What asks for a measurement (goal 117): a research run measures nothing, so a task, an idea or
 * a gap that asks for one is a next experiment, never work for the queue. Each rule names an act
 * of measuring, not the topic: "run a benchmark", "profile the kernel", "time each variant", "an
 * A/B test", "run it on the card", "run the litmus tests", and the fields of a measured
 * experiment ("matched control", "expected gain"). A task about published measurements ("find the
 * benchmark results reported for the A100", "papers that profile memory traffic", "documentation
 * on the hardware scheduler") asks for none. The tests hold the cases on each side.
 */
const MEASUREMENT: RegExp[] = [
  /\b(?:run|rerun|re-run|write|build|perform|execute|do|repeat)\s+(?:(?:a|an|the|some|our|its|this|that|these|those|new|own|small|quick|simple)\s+){0,3}(?:micro-?)?benchmarks?\b/i,
  /\bbenchmark\s+(?:it|this|that|them|these|those|the|each|both|our|its)\b/i,
  new RegExp(String.raw`\bprofile\s+${OBJECT}`, "i"),
  /\brun\s+(?:a\s+|the\s+)?profil(?:e|er|ing)\b/i,
  new RegExp(String.raw`${VERB_START}time\s+${OBJECT}`, "i"),
  new RegExp(String.raw`${VERB_START}(?:re-?)?measure\s+${OBJECT}`, "i"),
  /\bA\s*\/\s*B\b/,
  /\bA-?B\s+tests?\b/i,
  /\b(?:run|runs|running|rerun|test|testing|try|measure|measuring|time|timing|profile|profiling|verify|execute|reproduce|replay|benchmark|benchmarking)\b[^.;\n]{0,60}?\bon\s+(?:(?:the|our|this|that|a|real|actual|target|its|their|your)\s+)+(?:[\w-]+\s+){0,2}?(?:hardware|cards?|box|boxes|machines?|rigs?)\b/i,
  /\bon-(?:box|device|card|hardware)\b/i,
  /\b(?:run|rerun|write|execute|perform)\s+(?:(?:a|an|the|some|our|its|these|those|new)\s+){0,2}litmus\b/i,
  /\b(?:matched\s+control|smallest\s+discriminating\s+experiment|expected\s+gain)\b/i,
  /\bdev[- ]runs?\b/i,
];

/** The first words of a text that ask for a measurement, or undefined when it asks for none. */
export function measurementIn(text: string): string | undefined {
  let first: RegExpExecArray | undefined;
  for (const re of MEASUREMENT) {
    const m = re.exec(text);
    if (m && (first === undefined || m.index < first.index)) first = m;
  }
  return first?.[0].replace(/^[\s.;:!?(]+/, "").trim();
}

/** Why a task that asks for a measurement stays out of a research run's queue, in words. */
export function measurementRefusal(words: string): string {
  return `this asks for a measurement ("${words}"), and a research run measures nothing: record it as a next experiment in a report section or a note (what it would settle, and how), and propose only work that sources can answer`;
}

/** The reserved goal name of a research run's review (a research contract has no goals). */
export const RESEARCH_REVIEW = "research";

/**
 * A research run's close reason when the review panel's decisions give every question an end
 * (answered, or the best that sources allow) and every required hypothesis a verdict.
 */
export const ANSWERED = "every question is answered";

/**
 * A research run's close reason when the progress rule ends it (goal 117): every question still
 * open is saturated, and no item improved for a quarter of the running time. Not a time cap: the
 * rule holds only once research stopped adding. The run's open items are stated with it.
 */
export const PROGRESS_STOPPED = "research stopped adding: its open questions are saturated";

/** A question's last tasks that show it saturated: this many in a row that added nothing new. */
export const SATURATION_TASKS = 4;

/** The progress rule (the owner, 2026-10-24): no improvement for this share of the running time. */
export const PROGRESS_SHARE = 0.25;

/** The review panel's events of a research review (goal 117): each reviewer's checked answers per item, and each item's decision. */
export const REVIEW_ITEMS = "review_items";
export const ITEM_DECIDED = "item_decided";
/** Where the progress rule stands, at each digest after the minimum (goal 117). */
export const RESEARCH_PROGRESS = "research_progress";
/** The progress rule held: the run ends with its open items stated, and its paper (goal 117). */
export const RESEARCH_STOPPED = "research_stopped";

/** The harness asks the supervisor's final writer for a run's research paper. */
export const PAPER_REQUESTED = "research_paper_requested";
/** Code refused a paper the final writer wrote, with its problems. */
export const PAPER_REFUSED = "research_paper_refused";
/** Code accepted a run's research paper: it leads the run's final report. */
export const PAPER_ACCEPTED = "research_paper_accepted";

/** Why an answered research run closes without a paper, when its rig has no final writer. */
export const NO_WRITER = "no final writer on this rig";

/**
 * A research question's names (goal 117). Code, storage, file names and every field an agent
 * writes (a claim's, a hypothesis's or a task's `question`) number questions from 0. What people
 * read numbers them from 1: `questionName` ("Question 1"), for text only people read (the
 * dashboard, the paper, the journal's gap notes). A line an agent reads, or that agents and people
 * both read (a worker's brief, INDEX.md, REPORT.md, a task's title, the folder's files), names
 * both: `questionLabel` ("Question 1 (index 0)").
 */
export const questionName = (index: number): string => `Question ${index + 1}`;
export const questionLabel = (index: number): string => `Question ${index + 1} (index ${index})`;

/** The index a "Question N (index K)" label names, in a title or a line; undefined without one. */
export function labelledQuestion(text: string): number | undefined {
  const m = /\bquestion\s+\d+\s*\(\s*index\s+(\d+)\s*\)/i.exec(text);
  return m ? Number(m[1]) : undefined;
}

/**
 * A gap's line in a research task's details: the plan and the planner name the gap there, and so
 * do the research teachers' tasks.
 */
export const GAP_LINE = "Evidence gap to close: ";

/**
 * A research run's hypotheses (goal 117): the author's (the brief's), the workers' pool, those the
 * owner or the plan promoted, those merged into another and those retired. Live ones may not be
 * repeated; only the author's and promoted ones need a verdict from the review panel, and the
 * pool's are listed in the report as proposed by the run.
 */
export const LIVE_HYPOTHESES = ["author", "pool", "promoted"] as const;
export const REQUIRED_HYPOTHESES = ["author", "promoted"] as const;

/** A hypothesis's status in words, for briefs, files and reports. */
export function hypothesisStatusWords(status: string, mergedInto?: string | null): string {
  switch (status) {
    case "author":
      return "the author's, which needs a verdict";
    case "promoted":
      return "promoted, which needs a verdict";
    case "pool":
      return "in the pool";
    case "merged":
      return `merged into ${mergedInto ?? "another"}`;
    case "retired":
      return "retired";
    default:
      return status;
  }
}

/** Where the hypotheses go, in words, for a worker's brief and the research folder. */
export const HYPOTHESES_RULE =
  "Only the author's hypotheses and promoted ones need a verdict from the review panel. The others are the run's pool, which the report lists as proposed by the run and no review waits on. Propose a hypothesis only when it is new; to change one of the pool's words, question or supporting claims, revise it (revise_hypothesis) instead of proposing it again.";

/**
 * The parts of a usual research paper, each a level-2 heading, in this order: what the writer is
 * asked for. The writer chooses its parts and their words; code checks none of them, only that
 * every question is answered somewhere (owner, 2026-10-24).
 */
export const PAPER_PARTS = [
  {
    part: "Abstract",
    what: "one paragraph: the topic, how the run worked, the main answers and how certain they are",
  },
  {
    part: "Introduction",
    what: "the topic, why it is important, and the run's questions and hypotheses, in sentences",
  },
  { part: "Related work", what: "earlier work that the sources describe, when they describe it" },
  { part: "Method", what: "how the sources were found, archived and checked, with the figures" },
  {
    part: "Results",
    what: "the answer to each question, from its card, with its evidence and the certainty that the review panel decided",
  },
  {
    part: "Discussion",
    what: "what the answers show together, the hypotheses with the review panel's verdicts, and where reviewers dissent",
  },
  {
    part: "Limitations",
    what: "claims from a single site, open gaps, questions that stayed open, and draft findings that stay unverified",
  },
  {
    part: "Future work",
    what: "what only a measurement could settle (each question's next_experiments), then what else to try, each with why",
  },
  { part: "Conclusion", what: "the main result, in a few sentences" },
] as const;
