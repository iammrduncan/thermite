import { Type } from "@earendil-works/pi-ai";
import { z } from "zod";
import { renderFinalWriter } from "../../agents/roles/index.ts";
import { PAPER_EXPERIMENT_FIELDS, PAPER_MAX } from "../../core/api/harness/research.ts";
import { additionIn, type RunAdditions } from "../../core/role-additions.ts";
import type { AdvisorKeeper, AdvisorResult } from "./call.ts";
import { type AdvisorRuntime, packageFit } from "./config.ts";
import { runAdvisor } from "./run.ts";
import type { AdvisorKb, AdvisorPaper, AdvisorResearch } from "./tools/index.ts";

/**
 * The final writer's answer (goal 112): the whole paper, and its next experiments as items, each
 * with why, its details, its kind and measure (goal 119) and the findings or claims it rests on.
 */
export const WriterAnswer = z.strictObject({
  paper: z.string().min(1).max(PAPER_MAX),
  experiments: z.array(z.object(PAPER_EXPERIMENT_FIELDS)).max(50).default([]),
});
export type WriterAnswer = z.infer<typeof WriterAnswer>;
const WriterAnswerSchema = Type.Object({
  paper: Type.String({
    description:
      "The whole paper in Markdown, from its # title to its last part, with no References part or appendix",
  }),
  experiments: Type.Array(
    Type.Object({
      title: Type.String({ description: "What to try, in a few words" }),
      why: Type.String({ description: "Why it is worth trying, from the evidence" }),
      details: Type.Optional(Type.String({ description: "How to try it, in plain steps" })),
      kind: Type.String({
        description:
          "The run it is for: hill_climb (an improvement a hill climb measures against its champion) or goal (an outcome a goal campaign proves)",
      }),
      measure: Type.String({
        description:
          "For hill_climb, the metric it should move and which way; for goal, how a check would know the goal is reached",
      }),
      findings: Type.Optional(
        Type.Array(Type.String(), {
          description: "Ids of the supported findings it rests on (f-…)",
        }),
      ),
      claims: Type.Optional(
        Type.Array(Type.String(), { description: "Ids of the verified claims it rests on (c-…)" }),
      ),
    }),
    {
      description:
        "The paper's next experiments, as items: each one becomes an experiment in the campaign's collection in the knowledge base",
    },
  ),
});

/**
 * The final writer writes a research run's paper (goal 112), with the run's research (read only)
 * and its checks: check_paper and ste_check. Its prompt carries the STE checker's guide when the
 * rig has one, else short STE rules. In Pi, `accept` checks its answer and sends it back to
 * revise within the call.
 */
export async function writePaper(input: {
  runtime: AdvisorRuntime;
  pkg: unknown;
  paper: AdvisorPaper;
  research?: AdvisorResearch | undefined;
  /** Thermite's knowledge base (goal 175), in the final writer's own slot. */
  kb?: AdvisorKb | undefined;
  /** The STE checker's guide, when the rig has a checker with one beside it. */
  guide?: string | undefined;
  accept?: ((output: WriterAnswer) => Promise<string | undefined>) | undefined;
  keeper?: AdvisorKeeper | undefined;
  /** The owner's additions to the run's roles (goal 166): the final writer's goes in its prompt. */
  additions?: RunAdditions;
}): Promise<AdvisorResult<WriterAnswer>> {
  return runAdvisor({
    runtime: input.runtime,
    prompt: (f) =>
      renderFinalWriter(
        {
          pkg: input.pkg,
          fit: packageFit(input.runtime),
          guide: input.guide,
          addition: additionIn(input.additions, "final-writer"),
        },
        f,
      ),
    schema: WriterAnswer,
    answerSchema: WriterAnswerSchema,
    keeper: input.keeper,
    accept: input.accept,
    tools: {
      paper: input.paper,
      ...(input.research ? { research: input.research } : {}),
      ...(input.kb ? { kb: input.kb } : {}),
    },
  });
}
