import { PAPER_PARTS, PAPER_REFUSED, PAPER_REQUESTED } from "../../../core/research-check.ts";
import { type CardGap, cardsOf } from "../cards.ts";
import { questionEnded } from "../progress.ts";
import {
  type ClaimRow,
  type Dissent,
  PACKAGE_QUOTE_MAX,
  PACKAGE_QUOTES,
  type PackageClaim,
  type ResearchEnd,
  researchEnd,
  verifiedClaims,
} from "../review/index.ts";
import type { PapersContext } from "./context.ts";
import { paperItems, proposedHypotheses } from "./items.ts";
import { clip } from "./markdown.ts";
import { NEXT_HEADINGS, NEXT_KIND_WORDS, NEXT_KINDS } from "./next.ts";
import { accepted, type PaperFigures, requested } from "./request.ts";

/** The final writer's package: what a run's paper is written from, and the rules it follows. */

/**
 * The most characters of the final writer's package (as JSON). A longer one is shortened in steps
 * the package states (`shortened`), never cut without a word: the writer reads the rest with its
 * tools.
 */
export const PAPER_PACKAGE_MAX = 200_000;
/** A reviewer's answer in the package, once the package is shortened: its first characters. */
export const PAPER_ANSWER_CHARS = 1500;
/** The most hypotheses proposed by the run that the package lists (goal 117). */
export const PROPOSED_MAX = 100;

/** The rules a paper is written to and checked against, in words: the writer's package carries them. */
export const PAPER_RULES = [
  "The paper is Markdown in Simplified Technical English (descriptive text). Write it as a research paper that a person reads from start to end, such as a paper for arXiv: paragraphs that explain, not lists of records. Use a list or a table only where it helps the reader.",
  "Its first line is its title, a level-1 heading (# Title). No other level-1 heading.",
  `Then its parts, each a level-2 heading (##). A usual paper has these parts, in this order: ${PAPER_PARTS.map((p) => `${p.part} (${p.what})`).join("; ")}. Choose the parts and their words that fit the topic, and put other headings at level 3 (###) under a part. Code does not check the parts.`,
  "Do not write a References part or an appendix: code appends them. References lists the sources of the claims that the paper cites. Appendix A gives the review panel's decision and certainty on each question, its verdict on each hypothesis, each dissent, and the hypotheses that the run proposed. Appendix B lists each claim that the paper cites, with its sources.",
  "Answer every question of the run, with the claims that are its evidence: the claims of its card (questions[].claims) or other verified claims of that question. Code checks that the paper cites evidence for each question that has a verified claim. Give each answer's certainty in words, as the review panel decided it (questions[].certainty). For a question that stayed open (questions[].stayed_open), write what the evidence shows and what is missing. When reviewers dissent (questions[].dissent), say so, with the reason.",
  "Cite a claim as [c-ID] in each sentence that states a fact, such as [c-0a1b2c3d4e5f]; several as [c-…, c-…]. Each cited id must be a verified claim of the run. Code changes each citation to the numbers of its claims' sources in References, such as [1] or [1, 3].",
  "Every number in a paragraph, a list item or a table row must be in the claims it cites (their text or quotes), or be one of the figures in the package. Numbers in headings, record ids, question numbers (question 2) and the numbers in the run's questions and hypotheses are not checked.",
  "Discuss each hypothesis in the package's hypotheses, with the verdict that the review panel gave: supported, refuted or undecided (undecided when it gave none). Name a hypothesis by its words. The hypotheses in proposed were not judged: give them no verdict. A table row whose first cell names a hypothesis's id (h-…), or a line \"Verdict: …\" under a heading that names it, is checked: its verdict must be the review panel's.",
  `Put the next experiments in the part on future work: the measurement gaps of the cards and the next experiments that the review panel named (questions[].next_experiments), then what else to try, each with why. Give it a ### section for each kind of next experiment it has: ${NEXT_KINDS.map((k) => `### ${NEXT_HEADINGS[k]} (${NEXT_KIND_WORDS[k]})`).join(", and ")}. Give each next experiment the same kind in experiments.`,
];

/** The final writer's package: the review panel's decisions and the run's brief and figures. */
export interface PaperPackage {
  kind: "paper";
  run: string;
  /** The accepted review, or for a run the progress rule stopped, its newest decided review (0: none). */
  review: number;
  requested_at: string;
  title: string;
  topic: string;
  /**
   * How the run ended (goal 117): `every question is answered`, or the progress rule's reason;
   * `open` the questions (numbered from 1) that stayed open, and the required hypotheses with no
   * verdict.
   */
  end: { reason: string; open: number[]; open_hypotheses: string[] };
  questions: {
    number: number;
    text: string;
    /** The standing decision: answered, insufficient or open; null: none on its newest card. */
    decision: string | null;
    certainty: string | null;
    /** It has no end: the paper says what is missing. */
    stayed_open: boolean;
    /** The question's answer card (goal 117): what its answer is written from. Null: none. */
    card: {
      version: number;
      answer: string;
      certainty: string;
      gaps: CardGap[];
      created_at: string;
    } | null;
    /** The claims the card cites, with their quotes: the answer's evidence. */
    claims: PackageClaim[];
    /** The card's claims left out here to keep the package short (read them with the tools). */
    claims_not_shown?: number | undefined;
    /** All the question's verified claims: its answer may cite any of them. */
    verified_claims: number;
    /** What only a measurement could settle: the card's measurement gaps and the reviewers' next experiments. */
    next_experiments: string[];
    /** How many reviewers gave the decision with an answer that passed the check, and those answers. */
    answered_by: number;
    answers: { answer: string; claims: string[]; gaps: string; next_experiments: string }[];
    /** Answers of `answered_by` left out here to keep the package short. */
    answers_not_shown?: number | undefined;
    dissent: Dissent[];
  }[];
  /** The hypotheses that need a verdict: the author's and those promoted (goal 117). */
  hypotheses: {
    id: string;
    text: string;
    status: string;
    /** Its question, numbered from 1; null: about the whole run. */
    question: number | null;
    /** The standing verdict, with how many reviewers gave it (empty: no verdict yet). */
    verdicts: { verdict: string; reviewers: number; why: string; claims: string[] }[];
    dissent: Dissent[];
  }[];
  /** The hypotheses the run proposed that need no verdict (status pool): listed, never judged. */
  proposed: { id: string; text: string; question: number | null }[];
  /** Hypotheses proposed by the run left out of `proposed` (more than PROPOSED_MAX, or to keep the package short). */
  proposed_not_shown?: number | undefined;
  reviewers: number;
  figures: PaperFigures;
  rules: string[];
  /** Said when the package was shortened to keep it within PAPER_PACKAGE_MAX: what was left out. */
  shortened?: string | undefined;
  /** The newest refusal of a paper for this run, when there is one: fix these first. */
  last_refusal?: { at: string; problems: string[] } | undefined;
}

/** The runs waiting for their paper, each as the final writer's package. */
export function pendingPackages(ctx: PapersContext): PaperPackage[] {
  return ctx.ledger.runs.ids("research", "running").flatMap((id) => {
    const asked = requested(ctx, id);
    const end = researchEnd(ctx.ledger, id);
    if (!asked || !end || accepted(ctx, id)) return [];
    return [paperPackage(ctx, id, asked, end)];
  });
}

/**
 * The final writer's package for a run (goal 117): each question with its card and the card's
 * claims, the review panel's decision with the answers behind it and the dissent, and what only
 * a measurement could settle; the required hypotheses with their verdicts; the hypotheses the
 * run proposed. One longer than PAPER_PACKAGE_MAX is shortened in steps it states.
 */
function paperPackage(
  ctx: PapersContext,
  id: string,
  asked: { review: number; figures: PaperFigures; at: string },
  end: ResearchEnd,
): PaperPackage {
  const contract = ctx.contract(id);
  const items = paperItems(ctx, id);
  const claims = verifiedClaims(ctx.ledger, id, contract.quality.min_independent_sources);
  const cards = new Map(cardsOf(ctx.ledger, id).map((c) => [c.question, c]));
  const counts = ctx.ledger.claims.verifiedByQuestion(id);
  const proposed = proposedHypotheses(ctx, id);
  // The newest refusal since the newest request, if there is one.
  const request = ctx.ledger.events.lastId(PAPER_REQUESTED, { subject: id });
  const refused = request
    ? ctx.ledger.events.newest(PAPER_REFUSED, { subject: id, after: request })
    : undefined;
  const toClaim = (c: ClaimRow, quotes: boolean): PackageClaim => {
    const shown = quotes ? c.quotes.slice(0, PACKAGE_QUOTES) : [];
    return {
      id: c.id,
      text: c.text,
      quotes: shown.map((q) => clip(q.quote, PACKAGE_QUOTE_MAX)),
      ...(shown.length < c.quotes.length
        ? { quotes_not_shown: c.quotes.length - shown.length }
        : {}),
      domains: c.domains,
      corroborated: c.corroborated,
    };
  };
  interface Form {
    chars: number | null;
    quotes: boolean;
    answers: number | null;
    claims: number | null;
    proposed: number;
  }
  const cut = (s: string, f: Form) => (f.chars === null ? s : clip(s, f.chars));
  const build = (f: Form, shortened: string | undefined): PaperPackage => {
    const questions = items.questions.map((q) => {
      const card = cards.get(q.index);
      const all = [...new Set(card?.claims ?? [])].flatMap((c) => {
        const row = claims.get(c);
        return row ? [row] : [];
      });
      const shown = f.claims === null ? all : all.slice(0, f.claims);
      const answers = f.answers === null ? q.answers : q.answers.slice(0, f.answers);
      const next = [
        ...(card?.gaps ?? []).filter((g) => g.kind === "measurement").map((g) => g.text),
        ...q.answers.map((a) => a.next_experiments.trim()).filter(Boolean),
      ];
      return {
        number: q.index + 1,
        text: q.text,
        decision: q.decision?.decision ?? null,
        certainty: q.decision?.certainty ?? null,
        stayed_open: !questionEnded(q.decision),
        card: card
          ? {
              version: card.version,
              answer: card.answer,
              certainty: card.certainty,
              gaps: card.gaps,
              created_at: card.created_at,
            }
          : null,
        claims: shown.map((c) => toClaim(c, f.quotes)),
        ...(shown.length < all.length ? { claims_not_shown: all.length - shown.length } : {}),
        verified_claims: counts.get(q.index) ?? 0,
        next_experiments: [...new Set(next)].map((x) => cut(x, f)),
        answered_by: q.answers.length,
        answers: answers.map((a) => ({
          answer: cut(a.answer, f),
          claims: a.claims,
          gaps: cut(a.gaps, f),
          next_experiments: cut(a.next_experiments, f),
        })),
        ...(answers.length < q.answers.length
          ? { answers_not_shown: q.answers.length - answers.length }
          : {}),
        dissent: q.dissent,
      };
    });
    const listed = proposed.slice(0, f.proposed);
    return {
      kind: "paper" as const,
      run: id,
      review: asked.review,
      requested_at: asked.at,
      title: contract.title,
      topic: contract.topic,
      end: {
        reason: end.reason,
        open: questions.filter((q) => q.stayed_open).map((q) => q.number),
        open_hypotheses: end.open.hypotheses,
      },
      questions,
      hypotheses: items.hypotheses.map((h) => ({
        id: h.id,
        text: h.text,
        status: h.status,
        question: h.question === null ? null : h.question + 1,
        verdicts: h.decision
          ? [
              {
                verdict: h.decision.decision,
                reviewers: h.given.length,
                why: cut(h.given[0]?.why ?? "", f),
                claims: h.given[0]?.claims ?? [],
              },
            ]
          : [],
        dissent: h.dissent,
      })),
      proposed: listed.map((h) => ({
        id: h.id,
        text: h.text,
        question: h.question === null ? null : h.question + 1,
      })),
      ...(listed.length < proposed.length
        ? { proposed_not_shown: proposed.length - listed.length }
        : {}),
      reviewers: asked.figures.reviewers,
      figures: asked.figures,
      rules: PAPER_RULES,
      ...(shortened ? { shortened } : {}),
      ...(refused
        ? {
            last_refusal: {
              at: refused.at,
              problems: refused.body.problems ?? [],
            },
          }
        : {}),
    };
  };
  const most = Math.max(1, ...[...cards.values()].map((c) => c.claims.length));
  const steps: { f: Form; said: string }[] = [
    {
      f: {
        chars: PAPER_ANSWER_CHARS,
        quotes: true,
        answers: null,
        claims: null,
        proposed: PROPOSED_MAX,
      },
      said: `each reviewer's answer and each next experiment is cut to its first ${PAPER_ANSWER_CHARS} characters (a cut ends with "…")`,
    },
    {
      f: {
        chars: PAPER_ANSWER_CHARS,
        quotes: false,
        answers: null,
        claims: null,
        proposed: PROPOSED_MAX,
      },
      said: "the claims are shown without their quotes",
    },
    {
      f: {
        chars: PAPER_ANSWER_CHARS,
        quotes: false,
        answers: 1,
        claims: null,
        proposed: PROPOSED_MAX,
      },
      said: "each question shows one of the answers behind its decision (answers_not_shown counts the others)",
    },
    {
      f: { chars: PAPER_ANSWER_CHARS, quotes: false, answers: 1, claims: null, proposed: 30 },
      said: "proposed lists the first 30 hypotheses that the run proposed (proposed_not_shown counts the others)",
    },
  ];
  for (let k = Math.ceil(most / 2); k >= 1; k = k === 1 ? 0 : Math.ceil(k / 2))
    steps.push({
      f: { chars: PAPER_ANSWER_CHARS, quotes: false, answers: 1, claims: k, proposed: 30 },
      said: `each question shows the first ${k} ${k === 1 ? "claim" : "claims"} of its card (claims_not_shown counts the others)`,
    });
  let pkg = build(
    { chars: null, quotes: true, answers: null, claims: null, proposed: PROPOSED_MAX },
    undefined,
  );
  const said: string[] = [];
  for (const step of steps) {
    if (JSON.stringify(pkg).length <= PAPER_PACKAGE_MAX) break;
    // Each step keeps the cuts of the steps before it; a shorter claims step replaces the last.
    const claimsStep = (x: string | undefined) => x?.startsWith("each question shows the first");
    if (claimsStep(step.said) && claimsStep(said.at(-1))) said[said.length - 1] = step.said;
    else said.push(step.said);
    pkg = build(
      step.f,
      `To keep this package short: ${said.join("; ")}. Read every claim, quote and source of the run with the tools.`,
    );
  }
  return pkg;
}
