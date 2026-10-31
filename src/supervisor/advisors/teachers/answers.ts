import { Type } from "@earendil-works/pi-ai";
import { z } from "zod";
import { JOURNAL_FIELD } from "../../../agents/tools/index.ts";
import { ExperimentId, QueuePosition } from "../../../core/commands.ts";
import { RESEARCH_TASK_KINDS } from "../../../core/directions.ts";
import { LenientNotes } from "../../../core/journal.ts";
import { GAP_LINE, labelledQuestion, questionLabel } from "../../../core/research-check.ts";
import { OwnerAnswers, OwnerAnswersSchema } from "../owner-answers.ts";

/** How an advisor's answer schema describes a rule's direction (goal 066). */
const DIRECTION_FIELD =
  "The rule's direction, in plain words or as :name:: one of the run's directions (brief.directions), or a new one, which the planner designs";

/**
 * A teacher's recommendation, read leniently so that one bad recommendation never costs the
 * review: its direction (`family`, a name or :name:) is checked when the set is made, and words
 * (`match`) are no longer a rule (goal 066), so a recommendation that gives them is dropped then.
 */
const Recommendation = z.strictObject({
  kind: z.enum(["avoid", "try", "mandate", "priority", "lane_count", "note"]),
  family: z.string().trim().max(200).optional(),
  match: z.string().max(2000).optional(),
  value: z.union([z.string().max(1000), z.number()]).optional(),
  rationale: z.string().min(1).max(2000),
  citations: z.array(z.string().min(1).max(500)).max(20).default([]),
});

/** An experiment an advisor proposes for the run's queue, with why. */
const ProposedExperiment = z.strictObject({
  title: z.string().trim().min(1).max(200),
  details: z.string().max(4000).optional(),
  family: z.string().trim().min(1).max(80).optional(),
  why: z.string().trim().min(1).max(2000),
  /** A research run's task: the question it serves, an index from 0 (goal 117). */
  question: z.number().int().min(0).optional(),
});
export type ProposedExperiment = z.infer<typeof ProposedExperiment>;
/** A queued experiment an advisor would move, with why. */
export const ProposedMove = z.strictObject({
  id: ExperimentId,
  position: QueuePosition,
  why: z.string().trim().min(1).max(2000),
});
/**
 * A list of an advisor's proposals for the queue. Lenient on purpose: a proposal that does not
 * fit is left out, never a reason to lose the advisor's review or audit. `max`: how many are used
 * (moves); none for experiments, which have no count (goal 081).
 */
const proposals = <T extends z.ZodType>(item: T, max?: number) =>
  z
    .array(z.unknown())
    .default([])
    .catch([])
    .transform((xs) => {
      const kept = xs.flatMap((x): z.infer<T>[] => {
        const r = item.safeParse(x);
        return r.success ? [r.data] : [];
      });
      return max === undefined ? kept : kept.slice(0, max);
    });

/**
 * One opportunity of a teacher's portfolio (goal 081), as the teachers of an hourly research
 * agent once wrote them: what to try and the mechanism by which it would help, the most it may
 * gain, the smallest experiment that tells, with its matched control, when to stop, why it is new
 * since the teachers' last round, and what it rests on. Each one becomes an experiment for the
 * run's queue (opportunityExperiment).
 */
/**
 * A part of an opportunity, cut to its length rather than refused: an opportunity dropped for one
 * long part loses the whole idea, as a teacher's long gain_bound once did.
 */
const part = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .transform((s) => s.slice(0, max));

export const Opportunity = z.object({
  title: part(200),
  family: part(80).optional(),
  mechanism: part(2000),
  gain_bound: part(300),
  experiment: part(2000),
  control: part(1000),
  stop: part(1000),
  new_because: part(1000),
  citations: z.array(part(500)).min(1).max(20),
});
export type Opportunity = z.infer<typeof Opportunity>;
/** A merged opportunity: the ids of the teachers' opportunities it holds. */
export const MergedOpportunity = Opportunity.extend({
  from: z.array(z.string().max(200)).max(40).default([]).catch([]),
});

/** An opportunity as the run's queue keeps it: one experiment with all its parts in words. */
export function opportunityExperiment(o: Opportunity): ProposedExperiment {
  const details = [
    `Mechanism: ${o.mechanism}`,
    `Expected gain, at most: ${o.gain_bound}`,
    `Smallest discriminating experiment: ${o.experiment}`,
    `Matched control: ${o.control}`,
    `Stop when: ${o.stop}`,
    `Evidence: ${o.citations.join("; ")}`,
  ].join("\n");
  return {
    title: o.title,
    ...(o.family ? { family: o.family } : {}),
    details: details.length > 4000 ? `${details.slice(0, 3999)}…` : details,
    why: `New since the teachers' last round: ${o.new_because}`.slice(0, 2000),
  };
}

/**
 * One task of a research run's teacher (goal 117): the question it serves (an index from 0), one
 * gap in that question's evidence it closes, the kind of source to read, a title, details and
 * why; what it rests on, when it rests on something; and its kind of task, when one fits. No gain,
 * control or measured experiment: a research run measures nothing. Each becomes a task for the
 * run's queue (researchOpportunityExperiment), and the harness refuses one whose words ask for a
 * measurement.
 */
export const ResearchOpportunity = z.object({
  question: z.coerce.number().int().min(0),
  gap: part(500),
  source_kind: part(200),
  title: part(200),
  details: part(2000).optional(),
  why: part(2000),
  citations: z.array(part(500)).max(20).default([]).catch([]),
  kind: z.enum(RESEARCH_TASK_KINDS).optional().catch(undefined),
});
export type ResearchOpportunity = z.infer<typeof ResearchOpportunity>;
/** A merged research task: the ids of the teachers' tasks it holds. */
export const MergedResearchOpportunity = ResearchOpportunity.extend({
  from: z.array(z.string().max(200)).max(40).default([]).catch([]),
});

/**
 * A research teacher's task as the run's queue keeps it (goal 117): its title names its question
 * ("Question 2 (index 1): …"), its details start with the gap it closes (as the plan's do), then
 * what to read, its details and what it rests on; its question and its kind go with it.
 */
export function researchOpportunityExperiment(o: ResearchOpportunity): ProposedExperiment {
  const title =
    labelledQuestion(o.title) === o.question ? o.title : `${questionLabel(o.question)}: ${o.title}`;
  const details = [
    `${GAP_LINE}${o.gap.replace(/\s+/g, " ").trim()}`,
    `What to read: ${o.source_kind.replace(/\s+/g, " ").trim()}`,
    ...(o.details ? [o.details] : []),
    ...(o.citations.length ? [`Evidence: ${o.citations.join("; ")}`] : []),
  ].join("\n");
  return {
    title: title.length > 200 ? `${title.slice(0, 199)}…` : title,
    ...(o.kind ? { family: o.kind } : {}),
    details: details.length > 4000 ? `${details.slice(0, 3999)}…` : details,
    why: o.why.slice(0, 2000),
    question: o.question,
  };
}

/**
 * A portfolio as an answer gives it, each opportunity checked on its own: those that fit, and
 * why each other one was left out. No count: as many as are distinct and evidenced.
 */
export function checkPortfolio<T extends z.ZodType>(
  xs: unknown[],
  who: string,
  item: T,
): { kept: z.infer<T>[]; left: string[] } {
  const kept: z.infer<T>[] = [];
  const left: string[] = [];
  xs.forEach((x, i) => {
    const r = item.safeParse(x);
    if (r.success) {
      kept.push(r.data);
      return;
    }
    const title = (x as { title?: unknown } | null)?.title;
    const issue = r.error.issues[0];
    left.push(
      `${who}'s opportunity ${i + 1}${typeof title === "string" ? ` ("${title.slice(0, 80)}")` : ""}: ${issue ? `${issue.path.join(".") || "it"}: ${issue.message}` : "invalid"}`,
    );
  });
  return { kept, left };
}

const MovesField = Type.Optional(
  Type.Array(
    Type.Object({
      id: Type.String({ description: "A queued experiment's id (brief.queue.up_next)" }),
      position: Type.Union([Type.String(), Type.Number()], {
        description: '"top", "end", or an index among the queued experiments (0 first)',
      }),
      why: Type.String(),
    }),
    { description: "Queued experiments to move, each with why" },
  ),
);
const OpportunityFields = {
  title: Type.String({ description: "What to try, in a few words" }),
  family: Type.Optional(Type.String({ description: "Its direction (approach family)" })),
  mechanism: Type.String({
    description: "Why it would help here: the mechanism, from what you read",
  }),
  gain_bound: Type.String({
    description: "The most it may gain, and on what (for example: up to 8% on the large cases)",
  }),
  experiment: Type.String({
    description: "The smallest experiment that tells whether the mechanism holds",
  }),
  control: Type.String({ description: "The matched control it is compared with" }),
  stop: Type.String({ description: "When to stop pursuing it" }),
  new_because: Type.String({
    description: "Why it is new since the teachers' last round (brief.teacher_ideas)",
  }),
  citations: Type.Array(Type.String(), {
    description:
      "What it rests on, at least one: attempt ids, files of the champion, URLs or paper ids",
  }),
};
const PortfolioField = Type.Optional(
  Type.Array(Type.Object(OpportunityFields), {
    description:
      "Your portfolio of new opportunities, as many as are distinct and evidenced: each becomes an experiment in the run's queue",
  }),
);

const ResearchOpportunityFields = {
  question: Type.Number({ description: "The question it serves: its index, from 0" }),
  gap: Type.String({
    description:
      "One gap in that question's evidence it closes, best one of its card's open evidence gaps, in the card's words",
  }),
  source_kind: Type.String({
    description:
      "The kind of source to read: for example the vendor's specification, peer-reviewed papers, the project's code and issue tracker, a standard",
  }),
  title: Type.String({ description: "The task, in a few words" }),
  details: Type.Optional(Type.String({ description: "Where to start and what to look for" })),
  why: Type.String({
    description:
      "Why it is worth a lane now, and why it is new since the teachers' last round (brief.teacher_ideas)",
  }),
  citations: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "What it rests on: the run's source, claim or card ids or files, URLs or paper ids",
    }),
  ),
  kind: Type.Optional(
    Type.String({ description: `Its kind of task: ${RESEARCH_TASK_KINDS.join(", ")}` }),
  ),
};
const ResearchPortfolioField = Type.Optional(
  Type.Array(Type.Object(ResearchOpportunityFields), {
    description:
      "Your portfolio of research tasks, as many as are distinct and evidenced: each becomes a task in the run's queue",
  }),
);

export const TeacherReview = z.strictObject({
  summary: z.string().min(1).max(4000),
  /** The main product (goal 081): checked opportunity by opportunity in teacherRound. */
  portfolio: z.array(z.unknown()).default([]).catch([]),
  /** Rules, only when new evidence calls for one. */
  recommendations: z.array(Recommendation).max(20).default([]),
  answers: OwnerAnswers,
  /** Plain experiments, the field before the portfolio: still read, and queued as they are. */
  experiments: proposals(ProposedExperiment),
  moves: proposals(ProposedMove, 10),
  /** Field notes, read leniently: a bad note never loses the review. */
  journal: LenientNotes,
});
export const TeacherAnswer = Type.Object({
  answers: OwnerAnswersSchema,
  summary: Type.String(),
  portfolio: PortfolioField,
  recommendations: Type.Optional(
    Type.Array(
      Type.Object({
        kind: Type.String({ description: "avoid | try | mandate | priority | lane_count | note" }),
        family: Type.Optional(Type.String({ description: DIRECTION_FIELD })),
        value: Type.Optional(Type.Union([Type.String(), Type.Number()])),
        rationale: Type.String(),
        citations: Type.Array(Type.String()),
      }),
      { description: "Rules for the planner, only when new evidence calls for one" },
    ),
  ),
  moves: MovesField,
  journal: JOURNAL_FIELD,
});

/** A research run's teacher's answer (goal 117): its portfolio is research tasks. */
export const ResearchTeacherAnswer = Type.Object({
  ...TeacherAnswer.properties,
  portfolio: ResearchPortfolioField,
});

/**
 * The merged by model's set. Each directive is checked on its own when the set is made (teacherRound):
 * one that is not a valid directive, such as one in words, is dropped with why, never the set.
 * Its portfolio is checked opportunity by opportunity, and any teacher's opportunity it holds in
 * none is added back (goal 081).
 */
export const DirectiveSet = z.strictObject({
  directives: z.array(z.unknown()).max(20).default([]),
  portfolio: z.array(z.unknown()).default([]).catch([]),
  experiments: proposals(ProposedExperiment),
  moves: proposals(ProposedMove, 10),
  journal: LenientNotes,
});
export const DirectiveAnswer = Type.Object({
  portfolio: Type.Optional(
    Type.Array(
      Type.Object({
        ...OpportunityFields,
        from: Type.Array(Type.String(), {
          description: "The ids of the teachers' opportunities it holds (reviews[].portfolio[].id)",
        }),
      }),
      {
        description:
          "The teachers' portfolios merged into one, with no distinct opportunity dropped",
      },
    ),
  ),
  directives: Type.Optional(
    Type.Array(
      Type.Object({
        kind: Type.String(),
        family: Type.Optional(Type.String({ description: DIRECTION_FIELD })),
        value: Type.Optional(Type.Union([Type.String(), Type.Number()])),
        rationale: Type.String(),
        citations: Type.Array(Type.String()),
      }),
    ),
  ),
  moves: MovesField,
  journal: JOURNAL_FIELD,
});

/** A research run's merged by model's answer (goal 117): the merged research tasks. */
export const ResearchDirectiveAnswer = Type.Object({
  ...DirectiveAnswer.properties,
  portfolio: Type.Optional(
    Type.Array(
      Type.Object({
        ...ResearchOpportunityFields,
        from: Type.Array(Type.String(), {
          description: "The ids of the teachers' tasks it holds (reviews[].portfolio[].id)",
        }),
      }),
      {
        description:
          "The teachers' research tasks merged into one portfolio, with no distinct task dropped",
      },
    ),
  ),
});
