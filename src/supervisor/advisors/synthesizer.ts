import { Type } from "@earendil-works/pi-ai";
import { z } from "zod";
import { renderSynthesizer } from "../../agents/roles/index.ts";
import {
  CARD_ANSWER_MAX,
  CARD_CLAIMS_MAX,
  CARD_GAP_MAX,
  CARD_GAPS_MAX,
  CARD_WHY_MAX,
  CERTAINTIES,
  GAP_KINDS,
} from "../../core/api/harness/research.ts";
import { additionIn, type RunAdditions } from "../../core/role-additions.ts";
import type { AdvisorKeeper, AdvisorResult } from "./call.ts";
import { type AdvisorRuntime, packageFit } from "./config.ts";
import { leniently } from "./review-panel.ts";
import { runAdvisor } from "./run.ts";
import type { AdvisorKb, AdvisorResearch } from "./tools/index.ts";

/**
 * The synthesizer's answer (goal 117): one card for each question of its request. Read leniently,
 * as a reviewer's answer is: a card that does not fit is left out (its question stays in the next
 * request, and the supervisor says it got no card), a certainty or a gap's kind is read whatever
 * its case, a card's borrowed claims and gaps may be left out, and unknown fields are dropped.
 * Nothing is cut: the harness checks each card's bounds and refuses one that goes past them, with
 * the limit in words.
 */
const optionalList = <T extends z.ZodType>(item: T) =>
  z
    .unknown()
    .optional()
    .transform((xs): z.infer<T>[] =>
      (Array.isArray(xs) ? xs : []).flatMap((x) => {
        const r = item.safeParse(x);
        return r.success ? [r.data as z.infer<T>] : [];
      }),
    );
const SynthesizedGap = z.object({
  kind: z.preprocess(
    (v) => (typeof v === "string" ? v.trim().toLowerCase() : v),
    z.string().max(100),
  ),
  text: z.string().max(20_000),
});
const SynthesizedCard = z.object({
  question: z.coerce.number().int(),
  answer: z.string().max(100_000),
  certainty: z.preprocess(
    (v) => (typeof v === "string" ? v.trim().toLowerCase() : v),
    z.string().max(100),
  ),
  claims: z
    .array(z.string().max(200))
    .default([])
    .transform((c) => c.slice(0, 1000)),
  borrowed: optionalList(z.object({ claim: z.string().max(200), why: z.string().max(20_000) })),
  gaps: optionalList(SynthesizedGap),
});
export const SynthesizerAnswer = z.object({ cards: leniently(SynthesizedCard) });
export type SynthesizerAnswer = z.infer<typeof SynthesizerAnswer>;
const SynthesizerAnswerSchema = Type.Object({
  cards: Type.Array(
    Type.Object({
      question: Type.Number({
        description: "The question's index in the request (questions[].index)",
      }),
      answer: Type.String({
        description: `The current best answer, in a few paragraphs (at most ${CARD_ANSWER_MAX.toLocaleString("en-US")} characters), from the claims you cite only`,
      }),
      certainty: Type.String({ description: CERTAINTIES.join(" | ") }),
      claims: Type.Array(Type.String(), {
        description: `The ids of the verified claims the answer rests on (c-…), at most ${CARD_CLAIMS_MAX}`,
      }),
      borrowed: Type.Optional(
        Type.Array(
          Type.Object({
            claim: Type.String({
              description: "A cited claim recorded for another question, or none (c-…)",
            }),
            why: Type.String({
              description: `Why it bears on this question (at most ${CARD_WHY_MAX} characters)`,
            }),
          }),
        ),
      ),
      gaps: Type.Array(
        Type.Object({
          kind: Type.String({
            description:
              "evidence (a kind of source could close it) | measurement (only a measurement could settle it: a next experiment)",
          }),
          text: Type.String({
            description: `What is missing, and which kind of source or which experiment (at most ${CARD_GAP_MAX} characters)`,
          }),
        }),
        { description: `What the answer still lacks, at most ${CARD_GAPS_MAX}` },
      ),
    }),
    { description: "One card for each question in the request" },
  ),
});

/**
 * Problems a synthesizer's answer has before the harness checks it, in words (none: undefined):
 * a card for each question of the request, a certainty word, gap kinds and bounds. In Pi they go
 * back to it once within its call; the harness checks the rest (claims and numbers), and each
 * card on its own.
 */
export function synthesisProblems(
  pkg: { questions?: { index: number }[] },
  out: SynthesizerAnswer,
): string | undefined {
  const asked = (pkg.questions ?? []).map((q) => q.index);
  const problems: string[] = [];
  const missing = asked.filter((i) => !out.cards.some((c) => c.question === i));
  if (missing.length)
    problems.push(
      `give a card for ${missing.length === 1 ? "the question with index" : "the questions with index"} ${missing.join(", ")}`,
    );
  for (const c of out.cards) {
    const which = `the card for index ${c.question}`;
    if (!asked.includes(c.question))
      problems.push(`${which}: the request has no question with this index`);
    if (!c.answer.trim()) problems.push(`${which}: the answer is empty`);
    if (c.answer.length > CARD_ANSWER_MAX)
      problems.push(
        `${which}: the answer has ${c.answer.length.toLocaleString("en-US")} characters, at most ${CARD_ANSWER_MAX.toLocaleString("en-US")}`,
      );
    if (!(CERTAINTIES as readonly string[]).includes(c.certainty))
      problems.push(`${which}: the certainty is one of ${CERTAINTIES.join(", ")}`);
    if (c.certainty !== "none" && !c.claims.length)
      problems.push(`${which}: cite at least one verified claim, or give certainty none`);
    if (new Set(c.claims).size > CARD_CLAIMS_MAX)
      problems.push(`${which}: cite at most ${CARD_CLAIMS_MAX} claims`);
    if (c.gaps.length > CARD_GAPS_MAX)
      problems.push(`${which}: name at most ${CARD_GAPS_MAX} gaps`);
    for (const g of c.gaps) {
      if (!(GAP_KINDS as readonly string[]).includes(g.kind))
        problems.push(`${which}: a gap's kind is evidence or measurement`);
      if (g.text.length > CARD_GAP_MAX)
        problems.push(`${which}: a gap has at most ${CARD_GAP_MAX} characters`);
    }
  }
  return problems.length ? problems.join("; ") : undefined;
}

/**
 * The synthesizer writes a research run's answer cards (goal 117), on its own model, else the
 * first teacher's (goal 166), with the run's research read only. The request's keys it must answer come first, and a cut is
 * said, as a research review's is. In Pi, the problems synthesisProblems finds go back to it once
 * within its call; its next answer is taken as it is, so one card it cannot fix never holds back
 * the others: the harness refuses that card alone, and it is asked again at the next round.
 */
export async function synthesizeCards(input: {
  runtime: AdvisorRuntime;
  pkg: unknown;
  research?: AdvisorResearch | undefined;
  /** Thermite's knowledge base (goal 175), in the synthesizer's own slot. */
  kb?: AdvisorKb | undefined;
  keeper?: AdvisorKeeper | undefined;
  /** The owner's additions to the run's roles (goal 166): the synthesizer's goes in its prompt. */
  additions?: RunAdditions;
}): Promise<AdvisorResult<SynthesizerAnswer>> {
  const pkg = input.pkg as { questions?: { index: number }[] };
  let refusedOnce = false;
  return runAdvisor({
    runtime: input.runtime,
    prompt: (f) =>
      renderSynthesizer(
        {
          pkg: input.pkg,
          fit: packageFit(input.runtime),
          addition: additionIn(input.additions, "synthesizer"),
        },
        f,
      ),
    schema: SynthesizerAnswer,
    answerSchema: SynthesizerAnswerSchema,
    keeper: input.keeper,
    accept: async (o) => {
      if (refusedOnce) return undefined;
      const problems = synthesisProblems(pkg, o);
      if (problems) refusedOnce = true;
      return problems;
    },
    ...(input.research || input.kb
      ? {
          tools: {
            ...(input.research ? { research: input.research } : {}),
            ...(input.kb ? { kb: input.kb } : {}),
          },
        }
      : {}),
  });
}
