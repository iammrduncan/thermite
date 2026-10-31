import { Type } from "@earendil-works/pi-ai";
import { z } from "zod";
import type { ModelConfig } from "../../../agents/model/index.ts";
import type { Prompt } from "../../../agents/prompt.ts";
import {
  PROMOTE_PER_ROUND,
  RESEARCH_PLAN_LIMITS,
  renderResearchPlanner,
} from "../../../agents/roles/index.ts";
import { JOURNAL_FIELD } from "../../../agents/tools/index.ts";
import type { BriefData } from "../../../core/brief.ts";
import { canonicalJson } from "../../../core/canonical.ts";
import { QueuePosition } from "../../../core/commands.ts";
import { RESEARCH_TASK_KINDS } from "../../../core/directions.ts";
import type { NoteInput } from "../../../core/journal.ts";
import {
  hypothesisStatusWords,
  labelledQuestion,
  MEASURES_NOTHING,
  measurementIn,
  questionLabel,
  SATURATION_TASKS,
} from "../../../core/research-check.ts";
import type { OwnerAddition } from "../../../core/role-additions.ts";
import type { CallUsage } from "../../../core/usage.ts";
import { NOTES_ARE_DATA, type notesData } from "../../journal.ts";
import { briefingData } from "../../knowledge.ts";
import type { BriefingItem, HypothesisRow, Ledger } from "../../ledger/index.ts";
import type { QueueBrief } from "../../queue.ts";
import { type ResearchState, taskDetails } from "../../research/index.ts";
import type { Directive } from "../coordinator.ts";
import {
  type Ask,
  lanesOf,
  type PlannerCallSpec,
  type PlannerCompaction,
  type PlannerMcp,
  type PlannerPast,
  type PlannerView,
  type PlanTry,
  plannerTries,
  type QueuePlan,
} from "../planner/index.ts";

/**
 * The planner of a research run (goals 047 and 117): one stateless model call per round, through
 * the same machinery as a hill climb's (plannerTries: Pi or another harness, compaction, usage,
 * the cause of each try that gave no plan), from a research context the harness builds from its
 * ledger: the questions with their rubrics, each question's answer card (its answer, certainty
 * and open evidence gaps), the review panel's standing decision, its share of the last tasks
 * given out, what its last tasks added and whether it is saturated; the queue; the hypotheses
 * that need a verdict and the pool; the rules; the owner's messages; field notes.
 *
 * It answers with a task for each lane and changes to the queue. Every research task names one
 * question, one evidence gap it closes, the kind of source to read, a title and details. Code
 * checks each task: a question the run has; a gap and words that ask for no measurement (a
 * research run measures nothing); not a question that is decided or saturated, unless every
 * open question is saturated; a kind of task no AVOID rule names, and every MANDATE kind given
 * to a lane. It may promote up to PROMOTE_PER_ROUND pool hypotheses a round, so they need a
 * verdict, and at most PLANNER_PROMOTIONS_MAX in a run: each one is an item every reviewer must
 * judge, and a run of the past failed its reviews when hundreds did. It may retire a pool
 * hypothesis that repeats another or is out of scope. It never changes one whose status the
 * owner set last. A refused answer goes back once with its errors in words; then the gap-driven
 * plan in code gives out the round's work (the scheduler).
 */

/**
 * The most pool hypotheses the planner promotes in one run. Each promoted hypothesis is an item
 * every reviewer of every research review must give a verdict, with its claims in the package;
 * one long run's reviews failed when over 200 hypotheses needed verdicts and the package outgrew
 * the reviewers' prompt. Ten keeps the planner's additions to one or two a question for a brief of
 * six questions, the size of an author's own list. The owner promotes more by command.
 */
export const PLANNER_PROMOTIONS_MAX = 10;
/** The pool hypotheses the planner's context shows, the best supported first. */
export const POOL_SHOWN = 60;

/** A hypothesis as the research planner reads it. */
export interface PlannerHypothesis {
  id: string;
  status: string;
  /** The question it is about (an index from 0), or null: the whole run. */
  question: number | null;
  text: string;
  /** How many verified claims support it. */
  supporting: number;
  /** Who proposed it: a lane, or `author` for the brief's. */
  by: string;
}

/** The run's hypotheses for the research planner, with what bounds its changes. */
export interface PlannerHypotheses {
  /** The author's and the promoted: each needs a verdict from the review panel. */
  required: PlannerHypothesis[];
  /** The pool, the best supported first, at most POOL_SHOWN. */
  pool: PlannerHypothesis[];
  pool_total: number;
  /** How many the planner has promoted in this run. */
  promoted_by_planner: number;
  /** The hypotheses whose status the owner set last: the planner leaves them. */
  owner_set: string[];
  /** Every hypothesis's status, by id, for the checks (not in the context). */
  status: Record<string, string>;
}

const clip = (s: string, n: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** The run's hypotheses as the research planner reads them, and what bounds its changes. */
export function plannerHypotheses(ledger: Ledger, run: string): PlannerHypotheses {
  const rows = ledger.hypotheses.list(run);
  const view = (r: HypothesisRow): PlannerHypothesis => {
    let supporting = 0;
    try {
      supporting = (JSON.parse(r.supporting) as unknown[]).length;
    } catch {
      // Only the harness writes it, as JSON; a row that holds anything else supports nothing.
    }
    return {
      id: r.id,
      status: r.status,
      question: r.question,
      text: clip(r.text, 400),
      supporting,
      by: r.lane ? r.lane : "author",
    };
  };
  const all = rows.map(view);
  const pool = all
    .map((h, i) => ({ h, i }))
    .filter((x) => x.h.status === "pool")
    .sort((a, b) => b.h.supporting - a.h.supporting || b.i - a.i)
    .map((x) => x.h);
  let promoted = 0;
  const last = new Map<string, string>();
  for (const e of ledger.events.list("hypothesis_status", { subject: run })) {
    if (e.actor === "planner" && e.body.status === "promoted") promoted++;
    if (e.body.hypothesis) last.set(e.body.hypothesis, e.actor);
  }
  return {
    required: [
      ...all.filter((h) => h.status === "author"),
      ...all.filter((h) => h.status === "promoted"),
    ],
    pool: pool.slice(0, POOL_SHOWN),
    pool_total: pool.length,
    promoted_by_planner: promoted,
    owner_set: [...last].filter(([, actor]) => actor.startsWith("control:")).map(([id]) => id),
    status: Object.fromEntries(all.map((h) => [h.id, h.status])),
  };
}

export interface ResearchPlannerInput {
  run: string;
  epoch: number;
  laneCount: number;
  title: string;
  topic: string;
  /** Where each question stands (shares.ts). */
  state: ResearchState;
  queue: QueueBrief;
  hypotheses: PlannerHypotheses;
  /** The rules in force: task kinds, and a question's index as a value. */
  directives: Directive[];
  ownerMessages?: { id: number; text: string }[] | undefined;
  campaignBrief?: BriefData | undefined;
  notes?: ReturnType<typeof notesData> | undefined;
  briefing?: BriefingItem[] | undefined;
  pastResearch?: string | undefined;
  /** The owner's addition to the research planner (goal 166; see PlannerInput). */
  addition?: OwnerAddition | undefined;
}

/** A research task the planner adds, checked: its words and where it goes. */
export interface ResearchTask {
  ref: string;
  question: number;
  gap: string;
  source_kind: string;
  title: string;
  details?: string | undefined;
  kind: string;
  why: string;
  position?: QueuePosition | undefined;
}

/** The planner's checked answer: the queue's changes and hand-out, and its hypotheses' changes. */
export interface ResearchPlan {
  queue: QueuePlan;
  tasks: ResearchTask[];
  promote: { id: string; why: string }[];
  retire: { id: string; why: string }[];
  notes?: string | undefined;
}

export interface ResearchPlanResult {
  source: "planner" | "fallback";
  tries: number;
  valid: boolean;
  rawViolations: string[];
  causes?: PlanTry[] | undefined;
  journal?: NoteInput[] | undefined;
  plan?: ResearchPlan | undefined;
}

const Why = z.string().trim().min(1).max(RESEARCH_PLAN_LIMITS.why);
const TaskFields = {
  question: z.coerce.number().int(),
  gap: z.string().trim().min(1).max(RESEARCH_PLAN_LIMITS.gap),
  source_kind: z.string().trim().min(1).max(RESEARCH_PLAN_LIMITS.sourceKind),
  title: z.string().trim().min(1).max(RESEARCH_PLAN_LIMITS.title),
  details: z.string().max(RESEARCH_PLAN_LIMITS.details).optional(),
  kind: z.string().trim().max(40).optional(),
};
const Id = z.string().trim().min(1).max(RESEARCH_PLAN_LIMITS.id);
const ResearchPlanSchema = z.object({
  assignments: z.array(
    z.object({
      lane: z.string(),
      /** A queued task or an idea (its id), or a task this answer adds (its ref). */
      task: Id.optional(),
      /** Or a new task, in place. */
      question: TaskFields.question.optional(),
      gap: TaskFields.gap.optional(),
      source_kind: TaskFields.source_kind.optional(),
      title: TaskFields.title.optional(),
      details: TaskFields.details,
      kind: TaskFields.kind,
      why: z.string().max(RESEARCH_PLAN_LIMITS.why).optional(),
    }),
  ),
  add: z
    .array(
      z.object({
        ref: z.string().trim().min(1).max(RESEARCH_PLAN_LIMITS.ref).optional(),
        ...TaskFields,
        why: Why,
        position: QueuePosition.optional(),
      }),
    )
    .default([]),
  move: z
    .array(z.object({ id: Id, position: QueuePosition, why: Why }))
    .max(RESEARCH_PLAN_LIMITS.changes)
    .default([]),
  drop: z
    .array(z.object({ id: Id, why: Why }))
    .max(RESEARCH_PLAN_LIMITS.changes)
    .default([]),
  accept: z.array(z.object({ id: Id, why: Why, position: QueuePosition.optional() })).default([]),
  promote: z
    .array(z.object({ id: Id, why: Why }))
    .max(PROMOTE_PER_ROUND)
    .default([]),
  retire: z
    .array(z.object({ id: Id, why: Why }))
    .max(RESEARCH_PLAN_LIMITS.retire)
    .default([]),
  notes: z.string().max(RESEARCH_PLAN_LIMITS.notes).optional(),
});

/** The task kinds, with what each asks for: a task's `kind`. */
export const TASK_KIND_WORDS: Record<(typeof RESEARCH_TASK_KINDS)[number], string> = {
  explore: "find and read new relevant sources, and record verified claims",
  primary: "trace existing claims to primary sources (papers, specifications, data)",
  contradict: "look for sources that disagree with recorded claims, and record both sides",
  consolidate: "fold verified claims and notes into the report sections",
};

/** The rules for the plan by kind: the task kinds an AVOID, MANDATE or TRY rule names. */
function kindRules(directives: Directive[]) {
  const of = (k: string) =>
    new Set(
      directives
        .filter((d) => d.body.kind === k && d.body.family)
        .map((d) => String(d.body.family)),
    );
  return { avoid: of("avoid"), mandate: of("mandate"), tryKinds: of("try") };
}

/** Checks a raw research plan: the errors in words (empty when valid) and the checked plan. */
export function validateResearchPlan(
  raw: unknown,
  input: ResearchPlannerInput,
): { errors: string[]; plan?: ResearchPlan } {
  const parsed = ResearchPlanSchema.safeParse(raw);
  if (!parsed.success)
    return { errors: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) };
  const p = parsed.data;
  const errors: string[] = [];
  const st = input.state;
  const n = st.questions.length;
  const lanes = lanesOf(input.laneCount);
  const assigned = p.assignments.map((a) => a.lane).sort();
  if (canonicalJson(assigned) !== canonicalJson([...lanes].sort()))
    errors.push(
      `assign each of ${lanes.join(", ")} exactly once (got ${assigned.join(", ") || "none"})`,
    );
  const q = input.queue;
  const queued = new Map(q.up_next.map((x) => [x.id, x]));
  const proposed = new Map(q.proposed.map((x) => [x.id, x]));
  const elsewhere = new Map<string, string>([
    ...q.in_progress.map((x): [string, string] => [x.id, `in progress on ${x.lane}`]),
    ...q.tried.map((x): [string, string] => [x.id, "tried already"]),
  ]);
  const where = (id: string) => elsewhere.get(id) ?? "not in the queue";
  const { avoid, mandate } = kindRules(input.directives);
  /** Why a question may not get a task now, or undefined. */
  const questionProblem = (question: number, who: string): string | undefined => {
    const s = st.questions[question];
    if (!s)
      return `${who}: question ${question} is not one of the run's questions (an index from 0 to ${n - 1})`;
    if (s.weight > 0) return undefined;
    if (s.decided)
      return `${who}: ${s.label} is decided (${s.decision?.decision}${s.decision?.certainty ? ` at ${s.decision.certainty}` : ""}, review ${s.decision?.review}): its decision stands until its card changes, so give the lane a question still open`;
    return `${who}: ${s.label} is saturated (its last ${SATURATION_TASKS} tasks added no verified claim from a new site, and its card's certainty did not rise): give the lane a question still open, unless every open question is saturated`;
  };
  const tasks: ResearchTask[] = [];
  const checkTask = (
    t: {
      question: number;
      gap: string;
      source_kind: string;
      title: string;
      details?: string | undefined;
      kind?: string | undefined;
    },
    who: string,
  ): string | undefined => {
    const before = errors.length;
    const problem = questionProblem(t.question, who);
    if (problem) errors.push(problem);
    const gapMeasures = measurementIn(t.gap);
    if (gapMeasures)
      errors.push(
        `${who}: its gap asks for a measurement ("${gapMeasures}"), and a research run measures nothing: that is a next experiment for a goal or hill-climb run, not a task; name a gap a source could close`,
      );
    const measures = measurementIn([t.title, t.details ?? "", t.source_kind].join("\n"));
    if (measures)
      errors.push(
        `${who}: it asks for a measurement ("${measures}"), and a research run measures nothing: give it only work that sources can answer`,
      );
    const kind = t.kind?.trim() || "explore";
    if (!(RESEARCH_TASK_KINDS as readonly string[]).includes(kind))
      errors.push(`${who}: kind "${kind}" is not a task kind (${RESEARCH_TASK_KINDS.join(", ")})`);
    else if (avoid.has(kind)) errors.push(`${who}: kind ${kind} is under an AVOID rule`);
    return errors.length === before ? kind : undefined;
  };
  // Tasks the answer adds, then each inline one under its lane's ref.
  p.add.forEach((a, i) => {
    const ref = a.ref ?? `new-${i + 1}`;
    if (tasks.some((x) => x.ref === ref) || queued.has(ref) || proposed.has(ref))
      errors.push(`add: the ref ${ref} is used twice`);
    const kind = checkTask(a, `add ${ref}`);
    tasks.push({
      ref,
      question: a.question,
      gap: a.gap,
      source_kind: a.source_kind,
      title: a.title,
      details: a.details,
      kind: kind ?? "explore",
      why: a.why,
      position: a.position,
    });
  });
  const dropped = new Set(p.drop.map((d) => d.id));
  const handout: QueuePlan["handout"] = [];
  for (const a of p.assignments) {
    let id = a.task;
    if (!id) {
      if (
        a.question === undefined ||
        a.gap === undefined ||
        a.source_kind === undefined ||
        a.title === undefined
      ) {
        errors.push(
          `${a.lane}: name a task (an id from the queue or the ref of one you add), or give a new one with question, gap, source_kind and title`,
        );
        continue;
      }
      id = `@${a.lane}`;
      const kind = checkTask(
        {
          question: a.question,
          gap: a.gap,
          source_kind: a.source_kind,
          title: a.title,
          details: a.details,
          kind: a.kind,
        },
        a.lane,
      );
      tasks.push({
        ref: id,
        question: a.question,
        gap: a.gap,
        source_kind: a.source_kind,
        title: a.title,
        details: a.details,
        kind: kind ?? "explore",
        why: a.why?.trim() || a.title,
      });
    }
    const added = tasks.find((x) => x.ref === id);
    const known = queued.get(id) ?? proposed.get(id);
    if (!added && !known) {
      errors.push(`${a.lane}: task ${id} can't be given out (${where(id)})`);
      continue;
    }
    if (dropped.has(id)) errors.push(`${a.lane}: task ${id} is dropped in this same answer`);
    if (known && known.by !== "owner") {
      if (typeof known.question !== "number")
        errors.push(
          `${a.lane}: task ${id} names no question: add a task for it with its question and gap instead`,
        );
      else {
        const problem = questionProblem(known.question, `${a.lane}: task ${id}`);
        if (problem) errors.push(problem);
      }
    }
    const kind = added ? added.kind : known?.family || "explore";
    if (avoid.has(kind))
      errors.push(`${a.lane}: task ${id} is of kind ${kind}, under an AVOID rule`);
    handout.push({
      lane: a.lane,
      experiment: id,
      parent: "champion",
      why: a.why?.trim() || `next: ${added?.title ?? known?.title ?? id}`,
    });
  }
  const twice = handout.filter(
    (h, i) => handout.findIndex((o) => o.experiment === h.experiment) !== i,
  );
  for (const h of twice)
    errors.push(`${h.lane}: task ${h.experiment} is given to another lane too`);
  const kindOf = (id: string) =>
    tasks.find((x) => x.ref === id)?.kind ?? (queued.get(id) ?? proposed.get(id))?.family ?? "";
  for (const m of mandate)
    if (!handout.some((h) => kindOf(h.experiment) === m))
      errors.push(`MANDATE rule: give a lane a task of kind ${m} (add one if the queue has none)`);
  // The queue's changes: each names a task in the state it needs.
  for (const m of p.move)
    if (!queued.has(m.id)) errors.push(`move ${m.id}: only queued tasks move (${where(m.id)})`);
  for (const d of p.drop)
    if (!queued.has(d.id) && !proposed.has(d.id))
      errors.push(`drop ${d.id}: only queued tasks or ideas can be dropped (${where(d.id)})`);
  for (const a of p.accept) {
    const idea = proposed.get(a.id);
    if (!idea) {
      errors.push(`accept ${a.id}: not an idea of the lanes (${where(a.id)})`);
      continue;
    }
    if (typeof idea.question !== "number")
      errors.push(
        `accept ${a.id}: the idea names no question: add a task for it with its question and gap instead, and drop the idea`,
      );
    else {
      const problem = questionProblem(idea.question, `accept ${a.id}`);
      if (problem) errors.push(problem);
    }
  }
  // The hypotheses: promote and retire only pool ones, never one the owner set last.
  const h = input.hypotheses;
  const owner = new Set(h.owner_set);
  const changed = new Set<string>();
  const hypothesisProblem = (id: string, what: string): string | undefined => {
    const status = h.status[id];
    if (status === undefined) return `${what} ${id}: no hypothesis ${id} in this run`;
    if (changed.has(id)) return `${what} ${id}: it is changed twice in this answer`;
    changed.add(id);
    if (owner.has(id)) return `${what} ${id}: the owner set its status last: leave it to the owner`;
    if (status !== "pool")
      return `${what} ${id}: it is ${hypothesisStatusWords(status)}: only a pool hypothesis can be ${what === "promote" ? "promoted" : "retired"}`;
    return undefined;
  };
  for (const x of p.promote) {
    const problem = hypothesisProblem(x.id, "promote");
    if (problem) errors.push(problem);
  }
  const left = Math.max(0, PLANNER_PROMOTIONS_MAX - h.promoted_by_planner);
  if (p.promote.length > left)
    errors.push(
      `promote: at most ${left} more in this run (the planner promotes at most ${PLANNER_PROMOTIONS_MAX} a run; the owner may promote more)`,
    );
  for (const x of p.retire) {
    const problem = hypothesisProblem(x.id, "retire");
    if (problem) errors.push(problem);
  }
  const questionText = (i: number) => st.questions[i]?.text ?? "";
  return {
    errors,
    plan: {
      queue: {
        add: tasks.map((t) => ({
          ref: t.ref,
          // Its title names its question, as the code plan's do: "Question 2 (index 1): …".
          title:
            labelledQuestion(t.title) === t.question
              ? t.title
              : clip(`${questionLabel(t.question)}: ${t.title}`, RESEARCH_PLAN_LIMITS.title),
          details: taskDetails(t.question, questionText(t.question), t.gap, [
            `What to read: ${t.source_kind.replace(/\s+/g, " ").trim()}`,
            ...(t.details?.trim() ? [t.details.trim()] : []),
          ]),
          family: t.kind,
          why: t.why,
          question: t.question,
          ...(t.position !== undefined ? { position: t.position } : {}),
        })),
        move: p.move,
        drop: p.drop,
        accept: p.accept,
        rules: [],
        convert: [],
        handout,
      },
      tasks,
      promote: p.promote,
      retire: p.retire,
      notes: p.notes,
    },
  };
}

/** The research planner's context, as JSON: what it reads (and the prompt carries) each round. */
export function researchPlannerContext(input: ResearchPlannerInput): string {
  const st = input.state;
  const { avoid, mandate, tryKinds } = kindRules(input.directives);
  const h = input.hypotheses;
  return canonicalJson({
    epoch: input.epoch,
    lanes: lanesOf(input.laneCount),
    mode: "research",
    title: input.title,
    topic: input.topic,
    measures_nothing: MEASURES_NOTHING,
    questions: st.questions.map((q) => ({
      index: q.index,
      label: q.label,
      text: q.text,
      rubric: q.rubric,
      verified_claims: q.verified_claims,
      card: q.card
        ? {
            version: q.card.version,
            certainty: q.card.certainty,
            // A long answer is cut, and says so: the gaps decide the work, and come whole.
            answer:
              q.card.answer.length > 1500
                ? `${q.card.answer.slice(0, 1499)}… (cut here: the answer has ${q.card.answer.length.toLocaleString("en-US")} characters)`
                : q.card.answer,
            evidence_gaps: q.card.evidence_gaps,
            measurement_gaps: q.card.measurement_gaps,
          }
        : null,
      decision: q.decision,
      decided: q.decided,
      saturated: q.saturated,
      weight: q.weight,
      share: { tasks: q.share, of_last: st.window },
      tasks_this_round: q.round,
      tasks_in_all: q.tasks,
      last_tasks_added: q.yield,
    })),
    all_saturated: st.allSaturated,
    all_decided: st.allDecided,
    ceiling: Math.max(1, Math.floor(st.window / 2)),
    queue: input.queue,
    task_kinds: TASK_KIND_WORDS,
    rules: {
      avoid: [...avoid],
      mandate: [...mandate],
      try: [...tryKinds],
      questions_first: input.directives
        .filter(
          (d) =>
            (d.body.kind === "mandate" || d.body.kind === "try") &&
            typeof d.body.value === "number",
        )
        .map((d) => d.body.value),
    },
    hypotheses: {
      required: h.required,
      pool: h.pool,
      pool_total: h.pool_total,
      ...(h.pool_total > h.pool.length
        ? {
            pool_cut: `the ${h.pool.length} best supported of ${h.pool_total}: the rest are in hypotheses/ of the research folder`,
          }
        : {}),
      promote_left: Math.max(0, PLANNER_PROMOTIONS_MAX - h.promoted_by_planner),
      owner_set: h.owner_set,
    },
    ...(input.ownerMessages?.length ? { owner_messages: input.ownerMessages } : {}),
    ...(input.campaignBrief ? { campaign_brief: input.campaignBrief } : {}),
    ...(input.notes?.length ? { field_notes: { note: NOTES_ARE_DATA, notes: input.notes } } : {}),
    ...(input.briefing?.length ? { background: briefingData(input.briefing) } : {}),
    ...(input.pastResearch ? { past_research: input.pastResearch } : {}),
  });
}

const Position = Type.Union([Type.String(), Type.Number()], {
  description: '"top", "end", or an index among the queued tasks (0 first)',
});
const TaskParams = {
  question: Type.Number({ description: "The question's index, from 0" }),
  gap: Type.String({
    minLength: 1,
    maxLength: RESEARCH_PLAN_LIMITS.gap,
    description: "The evidence gap it closes: what is missing that a source could give",
  }),
  source_kind: Type.String({
    minLength: 1,
    maxLength: RESEARCH_PLAN_LIMITS.sourceKind,
    description: "The kind of source to read",
  }),
  title: Type.String({ minLength: 1, maxLength: RESEARCH_PLAN_LIMITS.title }),
  details: Type.Optional(Type.String({ maxLength: RESEARCH_PLAN_LIMITS.details })),
  kind: Type.Optional(
    Type.String({ description: `The kind of task: ${RESEARCH_TASK_KINDS.join(", ")}` }),
  ),
};
const Change = Type.Object({
  id: Type.String({ maxLength: RESEARCH_PLAN_LIMITS.id }),
  why: Type.String({ minLength: 1, maxLength: RESEARCH_PLAN_LIMITS.why }),
});

/** The research planner's call: its prompts and its tool. */
export const RESEARCH_PLAN_SPEC: PlannerCallSpec = {
  id: "research",
  render: renderResearchPlanner,
  description:
    "Submit this round's research plan: each lane's task, your changes to the queue, and the hypotheses you promote or retire.",
  parameters: Type.Object({
    assignments: Type.Array(
      Type.Object({
        lane: Type.String(),
        task: Type.Optional(
          Type.String({
            maxLength: RESEARCH_PLAN_LIMITS.id,
            description: "An id from queue.up_next or queue.proposed, or the ref of a task you add",
          }),
        ),
        question: Type.Optional(TaskParams.question),
        gap: Type.Optional(TaskParams.gap),
        source_kind: Type.Optional(TaskParams.source_kind),
        title: Type.Optional(TaskParams.title),
        details: TaskParams.details,
        kind: TaskParams.kind,
        why: Type.Optional(Type.String({ maxLength: RESEARCH_PLAN_LIMITS.why })),
      }),
      { description: "Each lane's task: one from the queue, one you add, or a new one in place" },
    ),
    add: Type.Optional(
      Type.Array(
        Type.Object({
          ref: Type.Optional(Type.String({ maxLength: RESEARCH_PLAN_LIMITS.ref })),
          ...TaskParams,
          why: Type.String({ minLength: 1, maxLength: RESEARCH_PLAN_LIMITS.why }),
          position: Type.Optional(Position),
        }),
      ),
    ),
    move: Type.Optional(
      Type.Array(
        Type.Object({
          id: Type.String({ maxLength: RESEARCH_PLAN_LIMITS.id }),
          position: Position,
          why: Type.String({ minLength: 1, maxLength: RESEARCH_PLAN_LIMITS.why }),
        }),
        { maxItems: RESEARCH_PLAN_LIMITS.changes },
      ),
    ),
    drop: Type.Optional(Type.Array(Change, { maxItems: RESEARCH_PLAN_LIMITS.changes })),
    accept: Type.Optional(
      Type.Array(
        Type.Object({
          id: Type.String({ maxLength: RESEARCH_PLAN_LIMITS.id }),
          why: Type.String({ minLength: 1, maxLength: RESEARCH_PLAN_LIMITS.why }),
          position: Type.Optional(Position),
        }),
      ),
    ),
    promote: Type.Optional(
      Type.Array(Change, {
        maxItems: PROMOTE_PER_ROUND,
        description: "Pool hypotheses to promote, so the review panel must judge them",
      }),
    ),
    retire: Type.Optional(
      Type.Array(Change, {
        maxItems: RESEARCH_PLAN_LIMITS.retire,
        description: "Pool hypotheses that repeat another or are out of scope",
      }),
    ),
    notes: Type.Optional(Type.String({ maxLength: RESEARCH_PLAN_LIMITS.notes })),
    journal: JOURNAL_FIELD,
  }),
};

/**
 * A research round's plan from the model (goals 047 and 117), or none: no model, or both tries
 * refused or failed, each with its cause. The scheduler then plans the round in code.
 */
export async function planResearch(
  input: ResearchPlannerInput,
  model?: ModelConfig,
  signal?: AbortSignal,
  ask?: Ask,
  past?: PlannerPast,
  mcp?: PlannerMcp,
  compaction?: PlannerCompaction,
  usage?: (u: CallUsage) => void,
  /** Keeps each try's prompt, as it is sent (goal 166). */
  sent?: (p: Prompt) => void,
  /** In Pi, in its own process and its Pi view (goal 169). */
  view?: PlannerView,
): Promise<ResearchPlanResult> {
  if (!model) return { source: "fallback", tries: 0, valid: false, rawViolations: [] };
  const r = await plannerTries({
    context: researchPlannerContext(input),
    addition: input.addition,
    model,
    spec: RESEARCH_PLAN_SPEC,
    check: (raw) => validateResearchPlan(raw, input),
    signal,
    ask,
    past,
    mcp,
    compaction,
    usage,
    sent,
    view,
  });
  return {
    source: r.plan ? "planner" : "fallback",
    tries: r.tries,
    valid: r.plan !== undefined,
    rawViolations: r.rawViolations,
    ...(r.causes.length ? { causes: r.causes } : {}),
    ...(r.journal.length ? { journal: r.journal } : {}),
    ...(r.plan ? { plan: r.plan } : {}),
  };
}
