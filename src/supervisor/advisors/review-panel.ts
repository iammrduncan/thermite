import { Type } from "@earendil-works/pi-ai";
import { z } from "zod";
import { type LeftOut, renderResearchReviewer, renderReviewer } from "../../agents/roles/index.ts";
import { JOURNAL_FIELD } from "../../agents/tools/index.ts";
import { REASONS_MAX } from "../../core/api/harness/advisors.ts";
import {
  ANSWER_CERTAINTIES,
  HYPOTHESIS_DECISIONS,
  QUESTION_DECISIONS,
} from "../../core/api/harness/research.ts";
import { LenientNotes } from "../../core/journal.ts";
import { additionIn, type RunAdditions } from "../../core/role-additions.ts";
import type { AdvisorKeeper, AdvisorMcp, AdvisorResult, AdvisorUsage } from "./call.ts";
import { type AdvisorRuntime, packageFit } from "./config.ts";
import { OwnerAnswers, OwnerAnswersSchema } from "./owner-answers.ts";
import { runAdvisor } from "./run.ts";
import type { AdvisorInTerminal } from "./terminal/index.ts";
import type { AdvisorKb, AdvisorResearch } from "./tools/index.ts";

/**
 * A reviewer's reasons, cut to 8,000 characters rather than refused: a long but sound answer is
 * kept. An answer's unknown fields are dropped (z.object, not strictObject) for the same reason:
 * a reviewer whose answer is refused leaves the review unposted, and its whole panel runs again.
 */
const longText = z
  .string()
  .min(1)
  .transform((s) => s.slice(0, REASONS_MAX));

export const PanelAnswer = z.object({
  pass: z.boolean(),
  reasons: longText,
  answers: OwnerAnswers,
  journal: LenientNotes,
});
const PanelAnswerSchema = Type.Object({
  pass: Type.Boolean(),
  reasons: Type.String(),
  answers: OwnerAnswersSchema,
  journal: JOURNAL_FIELD,
});

/**
 * A reviewer's answer to a research package (goals 112 and 117): for each item to decide, a
 * question's verdict (answered with its certainty, insufficient or open) with its answer, the
 * claims it cites, its evidence gaps and its next experiments, and each hypothesis's verdict.
 * Read leniently where a model may stray: a question or verdict that does not fit is left out, and
 * the harness then counts it as no answer, with why.
 */
// An item that does not fit is dropped from a reviewer's answer (leniently, below), and a dropped
// item counts as not answered: so what can be cut is cut to the harness's limits, and a verdict's
// word is read whatever its case, rather than an item being dropped for either.
const cut = (max: number) =>
  z
    .string()
    .default("")
    .transform((s) => s.slice(0, max));
const ids = z
  .array(z.string().max(200))
  .default([])
  .transform((c) => c.slice(0, 100));
/** A word read whatever its case and spaces. */
const word = <T extends readonly [string, ...string[]]>(values: T) =>
  z.preprocess((v) => (typeof v === "string" ? v.trim().toLowerCase() : v), z.enum(values));
const ResearchQuestionAnswer = z.object({
  index: z.coerce.number().int().min(0),
  verdict: word(QUESTION_DECISIONS),
  // A certainty that does not fit is no certainty: the harness then says an answered verdict
  // needs one, rather than the whole answer being left out.
  certainty: z
    .unknown()
    .transform((v) => {
      const r = word(ANSWER_CERTAINTIES).safeParse(v);
      return r.success ? r.data : null;
    })
    .default(null),
  answer: cut(8000),
  claims: ids,
  gaps: cut(4000),
  next_experiments: cut(4000),
});
const ResearchHypothesisVerdict = z.object({
  id: z.string().min(1).max(200),
  verdict: word(HYPOTHESIS_DECISIONS),
  why: cut(4000),
  claims: ids,
});
export const leniently = <T extends z.ZodType>(item: T) =>
  z.unknown().transform((xs): z.infer<T>[] =>
    (Array.isArray(xs) ? xs : []).flatMap((x) => {
      const r = item.safeParse(x);
      return r.success ? [r.data as z.infer<T>] : [];
    }),
  );
export const ResearchPanelAnswer = z.object({
  pass: z.boolean(),
  reasons: longText,
  questions: leniently(ResearchQuestionAnswer),
  hypotheses: leniently(ResearchHypothesisVerdict),
  answers: OwnerAnswers,
  journal: LenientNotes,
});
const ResearchPanelAnswerSchema = Type.Object({
  pass: Type.Boolean({
    description:
      "true when every question you decide is answered or insufficient and every hypothesis you decide has a verdict",
  }),
  reasons: Type.String(),
  questions: Type.Array(
    Type.Object({
      index: Type.Number({
        description:
          "The question's index in the package (questions[].index), one of decide.questions",
      }),
      verdict: Type.String({ description: "answered | insufficient | open" }),
      certainty: Type.Optional(Type.String({ description: "For answered: high | moderate | low" })),
      // Only what each verdict needs is required, by the harness's check in words; the schema
      // leaves them optional, so a field left empty never costs the reviewer its answer.
      answer: Type.Optional(
        Type.String({
          description:
            "The answer, or for insufficient the best answer sources allow, in a few plain sentences, from the claims you cite only; for open, what is known so far",
        }),
      ),
      claims: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "The ids of the verified claims the answer rests on (c-…); needed for answered",
        }),
      ),
      gaps: Type.Optional(
        Type.String({
          description:
            "For open: each gap in the evidence a source could close, and the kind of source",
        }),
      ),
      next_experiments: Type.Optional(
        Type.String({
          description:
            "What only a measurement could settle, as next experiments for a goal or hill-climb run; needed for insufficient",
        }),
      ),
    }),
    { description: "One for each question in decide.questions" },
  ),
  hypotheses: Type.Array(
    Type.Object({
      id: Type.String({ description: "The hypothesis's id (h-…), one of decide.hypotheses" }),
      verdict: Type.String({ description: "supported | refuted | undecided" }),
      why: Type.String({ description: "Why, in a sentence or two" }),
      claims: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "The ids of the verified claims that show it; needed for supported or refuted",
        }),
      ),
    }),
    { description: "One for each hypothesis in decide.hypotheses" },
  ),
  answers: OwnerAnswersSchema,
  journal: JOURNAL_FIELD,
});

/** A reviewer's answers to a research package, as the supervisor posts them (goal 112). */
export interface ResearchReviewAnswers {
  questions: z.infer<typeof ResearchQuestionAnswer>[];
  hypotheses: z.infer<typeof ResearchHypothesisVerdict>[];
}

/** One reviewer's review: a goal's pass or fail, and for a research package its answers too. */
export type ReviewOutput = z.infer<typeof PanelAnswer> & {
  research?: ResearchReviewAnswers | undefined;
};

/** A research run's package (goal 112), as the harness marks it. */
type ResearchAnswer = z.infer<typeof ResearchPanelAnswer>;

/** A research package's items to decide; a package from before goal 117 has no decide: all of them. */
type ItemsPackage = {
  decide?: { questions?: number[]; hypotheses?: string[] };
  questions?: { index: number }[];
  hypotheses?: { id: string }[];
};
const toDecide = (pkg: ItemsPackage) => ({
  questions: pkg.decide?.questions ?? (pkg.questions ?? []).map((q) => q.index),
  hypotheses: pkg.decide?.hypotheses ?? (pkg.hypotheses ?? []).map((h) => h.id),
});

/** The questions (by index) and hypotheses (by id) to decide that an answer left out. */
export function leftOut(
  pkg: ItemsPackage,
  answer: Pick<ResearchAnswer, "questions" | "hypotheses">,
): LeftOut {
  const asked = new Set(answer.questions.map((q) => q.index));
  const judged = new Set(answer.hypotheses.map((h) => h.id));
  const items = toDecide(pkg);
  return {
    questions: items.questions.filter((i) => !asked.has(i)),
    hypotheses: items.hypotheses.filter((id) => !judged.has(id)),
  };
}

/** An answer with what a second answer gave for the items the first left out. */
function fillIn(
  first: ResearchAnswer,
  second: ResearchAnswer,
  left: { questions: number[]; hypotheses: string[] },
): ResearchAnswer {
  const qs = new Set(left.questions);
  const hs = new Set(left.hypotheses);
  return {
    ...first,
    pass: first.pass && second.pass,
    questions: [...first.questions, ...second.questions.filter((q) => qs.delete(q.index))],
    hypotheses: [...first.hypotheses, ...second.hypotheses.filter((h) => hs.delete(h.id))],
    journal: [...first.journal, ...second.journal],
  };
}

export const isResearchPackage = (pkg: unknown): boolean =>
  typeof pkg === "object" && pkg !== null && (pkg as { kind?: unknown }).kind === "research";

export async function reviewOne(input: {
  runtime: AdvisorRuntime;
  pkg: unknown;
  /** Thermite's knowledge base (goal 175): the review panel's tools for it. */
  kb?: AdvisorKb | undefined;
  /** The MCP servers the run's kit gives the advisors (goal 068). */
  mcp?: AdvisorMcp | undefined;
  /** A research package's run's own research, read only (goal 112). */
  research?: AdvisorResearch | undefined;
  /** Where the call's conversation is kept before a compaction (goal 070). */
  keeper?: AdvisorKeeper | undefined;
  /** The owner's additions to the run's roles (goal 166): the reviewer's goes in its prompt. */
  additions?: RunAdditions;
  /** On a rig whose agents run in their own terminal (goal 169): the call runs in its program's. */
  terminal?: AdvisorInTerminal | undefined;
}): Promise<AdvisorResult<ReviewOutput>> {
  // A research run's package (goal 112): its own prompt and answer, which says, for each
  // question, if it is answered, and for each hypothesis, its verdict.
  if (isResearchPackage(input.pkg)) {
    const tools = {
      ...(input.kb ? { kb: input.kb } : {}),
      ...(input.mcp ? { mcp: input.mcp } : {}),
      ...(input.research ? { research: input.research } : {}),
    };
    const fit = packageFit(input.runtime);
    const ask = (o: { pkg: unknown; leftOut?: LeftOut | undefined }) =>
      runAdvisor({
        runtime: input.runtime,
        prompt: (f) =>
          renderResearchReviewer(
            { ...o, fit, addition: additionIn(input.additions, "research-reviewer") },
            f,
          ),
        schema: ResearchPanelAnswer,
        answerSchema: ResearchPanelAnswerSchema,
        keeper: input.keeper,
        terminal: input.terminal,
        ...(Object.keys(tools).length ? { tools } : {}),
      });
    const pkg = input.pkg as ItemsPackage;
    let r = await ask({ pkg: input.pkg });
    // A question or hypothesis to decide that an answer left out counts as no answer: the
    // reviewer is asked once more, for what it left out only, with the package's other
    // hypotheses taken out, and what it gives is added to its answer.
    const out = r.output;
    const left = out ? leftOut(pkg, out) : undefined;
    if (out && left && (left.questions.length || left.hypotheses.length)) {
      const only = new Set(left.hypotheses);
      const again = await ask({
        pkg: {
          ...pkg,
          decide: left,
          hypotheses: (pkg.hypotheses ?? []).filter((h) => only.has(h.id)),
        },
        leftOut: left,
      });
      r = {
        ...r,
        output: again.output ? fillIn(out, again.output, left) : out,
        tokensIn: r.tokensIn + again.tokensIn,
        tokensOut: r.tokensOut + again.tokensOut,
        usd: r.usd + again.usd,
        ...(r.compactions || again.compactions
          ? { compactions: [...(r.compactions ?? []), ...(again.compactions ?? [])] }
          : {}),
        ...(r.sent || again.sent ? { sent: [...(r.sent ?? []), ...(again.sent ?? [])] } : {}),
        ...(r.given || again.given ? { given: [...(r.given ?? []), ...(again.given ?? [])] } : {}),
        ...(r.usage || again.usage
          ? {
              usage: {
                ...((r.usage ?? again.usage) as AdvisorUsage),
                calls: [...(r.usage?.calls ?? []), ...(again.usage?.calls ?? [])],
              },
            }
          : {}),
      };
    }
    const o = r.output;
    return {
      ...r,
      output: o
        ? {
            pass: o.pass,
            reasons: o.reasons,
            answers: o.answers,
            journal: o.journal,
            research: { questions: o.questions, hypotheses: o.hypotheses },
          }
        : undefined,
    };
  }
  return runAdvisor({
    runtime: input.runtime,
    prompt: (f) =>
      renderReviewer(
        {
          pkg: input.pkg,
          fit: packageFit(input.runtime),
          addition: additionIn(input.additions, "reviewer"),
        },
        f,
      ),
    schema: PanelAnswer,
    answerSchema: PanelAnswerSchema,
    keeper: input.keeper,
    terminal: input.terminal,
    ...(input.kb || input.mcp
      ? {
          tools: {
            ...(input.kb ? { kb: input.kb } : {}),
            ...(input.mcp ? { mcp: input.mcp } : {}),
          },
        }
      : {}),
  });
}
