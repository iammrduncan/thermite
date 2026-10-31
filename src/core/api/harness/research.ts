import { z } from "zod";

/**
 * The words and limits of a run's research on the wire between the harness and its supervisor's
 * advisors (the routes are in advisors.ts): the kinds the teachers read and their pages, the
 * synthesizer's answer cards, the final writer's paper with its next experiments and the STE
 * checker's result, and a reviewer's verdicts on a research run's questions and hypotheses. The
 * harness checks each further in its research modules (src/harness/research/), with words.
 */

/** The kinds of the run's research, as the tools and the search name them. */
export const RESEARCH_KINDS = ["source", "claim", "hypothesis", "finding", "note", "file"] as const;
export type ResearchKind = (typeof RESEARCH_KINDS)[number];

/** Each kind's list: GET /v1/research/<path>. */
export const KIND_PATHS: Record<ResearchKind, string> = {
  source: "sources",
  claim: "claims",
  hypothesis: "hypotheses",
  finding: "findings",
  note: "notes",
  file: "files",
};

/** A list's page: 20 items when not told, at most 50. */
export const PAGE_DEFAULT = 20;
export const PAGE_MAX = 50;
/** One read of a source's archived text: 8,000 characters when not told, at most 20,000. */
export const SOURCE_CHARS_DEFAULT = 8000;
export const SOURCE_CHARS_MAX = 20_000;
/** Hits a search gives when it is not told how many, and the most it gives. */
export const SEARCH_DEFAULT = 10;
export const SEARCH_MAX = 50;
/** The longest search, in characters. */
export const SEARCH_QUERY_MAX = 300;

/** A question's decision: answered at a certainty, the best that sources allow, or still open. */
export const QUESTION_DECISIONS = ["answered", "insufficient", "open"] as const;
export type QuestionDecision = (typeof QUESTION_DECISIONS)[number];
/** The certainty of an answered question. */
export const ANSWER_CERTAINTIES = ["high", "moderate", "low"] as const;
export type AnswerCertainty = (typeof ANSWER_CERTAINTIES)[number];
/** A required hypothesis's verdict. */
export const HYPOTHESIS_DECISIONS = ["supported", "refuted", "undecided"] as const;
export type HypothesisDecision = (typeof HYPOTHESIS_DECISIONS)[number];

/** A reviewer's answers to a research package, as the supervisor posts them (goal 117). */
export const ResearchVerdicts = z.strictObject({
  questions: z
    .array(
      z.strictObject({
        index: z.number().int().min(0),
        verdict: z.enum(QUESTION_DECISIONS),
        certainty: z.enum(ANSWER_CERTAINTIES).nullable().default(null),
        answer: z.string().max(8000).default(""),
        claims: z.array(z.string().max(200)).max(100).default([]),
        gaps: z.string().max(4000).default(""),
        next_experiments: z.string().max(4000).default(""),
      }),
    )
    .max(2000)
    .default([]),
  hypotheses: z
    .array(
      z.strictObject({
        id: z.string().max(200),
        verdict: z.enum(HYPOTHESIS_DECISIONS),
        why: z.string().max(4000).default(""),
        claims: z.array(z.string().max(200)).max(100).default([]),
      }),
    )
    .max(5000)
    .default([]),
});
export type ResearchVerdicts = z.infer<typeof ResearchVerdicts>;

/** The certainty scale of an answer card, from the most certain to no answer. */
export const CERTAINTIES = ["high", "moderate", "low", "insufficient", "none"] as const;
export type Certainty = (typeof CERTAINTIES)[number];

/** The kinds of gap a card names. */
export const GAP_KINDS = ["evidence", "measurement"] as const;
export type GapKind = (typeof GAP_KINDS)[number];

/** The most characters of a card's answer: a few paragraphs. */
export const CARD_ANSWER_MAX = 6000;
/** The most claims a card cites. */
export const CARD_CLAIMS_MAX = 60;
/** The most gaps a card names, and the most characters of each. */
export const CARD_GAPS_MAX = 12;
export const CARD_GAP_MAX = 500;
/** The most characters of why a card borrows a claim recorded for another question. */
export const CARD_WHY_MAX = 500;

/** A gap as the supervisor posts it: its kind and words are checked in code, with words. */
const GapInput = z.strictObject({
  kind: z.string().max(100),
  text: z.string().max(20_000),
});

/** One card as the supervisor posts it. Its bounds are checked in code, so a problem has words. */
export const CardInput = z.strictObject({
  question: z.number().int(),
  answer: z.string().max(100_000),
  certainty: z.string().max(100),
  claims: z.array(z.string().max(200)).max(1000).default([]),
  borrowed: z
    .array(z.strictObject({ claim: z.string().max(200), why: z.string().max(20_000) }))
    .max(1000)
    .default([]),
  gaps: z.array(GapInput).max(1000).default([]),
  /** The `through` the request gave for this question; null: the card's request named none. */
  through: z.string().max(200).nullable().default(null),
});
export type CardInput = z.infer<typeof CardInput>;

/** What the supervisor posts for a run: the synthesizer's name and one or more cards. */
export const CardSubmission = z.strictObject({
  synthesizer: z.string().trim().min(1).max(100),
  cards: z.array(CardInput).min(1).max(100),
});
export type CardSubmission = z.infer<typeof CardSubmission>;

/** The most characters of a paper as the writer writes it (code appends the references). */
export const PAPER_MAX = 100_000;

/** The fields of one of the paper's next experiments (the supervisor reads a model's answer with them). */
export const PAPER_EXPERIMENT_FIELDS = {
  title: z.string().trim().min(1).max(200),
  why: z.string().trim().min(1).max(2000),
  details: z.string().max(4000).default(""),
  /**
   * The run it is for (goal 119): `hill_climb` or `goal`. Read whatever its case and spacing
   * ("Hill climb", "goal campaign"); checked in code, with words, when it is neither.
   */
  kind: z.preprocess(
    (v) =>
      typeof v === "string"
        ? v
            .trim()
            .toLowerCase()
            .replace(/[\s-]+/g, "_")
            .replace(/^goal_campaign$/, "goal")
        : v,
    z.string().max(40).default(""),
  ),
  /** For a hill climb, the metric it should move and which way; for a goal, how a check knows it is reached. */
  measure: z.string().trim().max(2000).default(""),
  findings: z.array(z.string().min(1).max(100)).max(50).default([]),
  claims: z.array(z.string().min(1).max(100)).max(50).default([]),
};

/** The most next experiments a paper gives. */
export const PAPER_EXPERIMENTS_MAX = 50;

/** One of the paper's next experiments, as the writer gives it beside the paper. */
export const PaperExperiment = z.strictObject(PAPER_EXPERIMENT_FIELDS);
export type PaperExperiment = z.infer<typeof PaperExperiment>;

/** One finding of the STE checker, as the supervisor posts it. */
const SteFinding = z.object({
  line: z.number().int().min(0),
  column: z.number().int().min(0).optional(),
  severity: z.string().max(20),
  rule: z.string().max(100),
  message: z.string().max(1000),
  text: z.string().max(500).default(""),
});

/**
 * The STE checker's result on the paper's text, as the supervisor ran it (never the model): its
 * counts and findings, and the SHA-256 of the text it checked. Or why it did not run.
 */
export const SteResult = z.discriminatedUnion("checked", [
  z.strictObject({
    checked: z.literal(true),
    /** The SHA-256 of the paper's text that the checker read (`sha256Hex`, as hex). */
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    version: z.string().max(100).nullable().default(null),
    issue: z.string().max(100).nullable().default(null),
    counts: z.strictObject({
      error: z.number().int().min(0),
      warning: z.number().int().min(0),
      info: z.number().int().min(0),
    }),
    findings: z.array(SteFinding).max(200).default([]),
  }),
  z.strictObject({ checked: z.literal(false), why: z.string().min(1).max(500) }),
]);
export type SteResult = z.infer<typeof SteResult>;

/** What the supervisor posts for a run's paper. */
export const PaperSubmission = z.strictObject({
  writer: z.string().trim().min(1).max(100),
  paper: z.string().min(1).max(PAPER_MAX),
  experiments: z.array(PaperExperiment).max(PAPER_EXPERIMENTS_MAX).default([]),
  ste: SteResult,
});
export type PaperSubmission = z.infer<typeof PaperSubmission>;
