import assert from "node:assert/strict";
import { researchPackage, researchReviewDue } from "../../src/harness/research/review/index.ts";
import { Reviews } from "../../src/harness/reviews.ts";
import { fillResearch, makeResearchRun, writeCards } from "./research-run.ts";

/**
 * Goal 112's tests of the final paper: a research run (research-run.ts) with an answer card for
 * each question (goal 117), whose review the review panel passed and the harness accepted
 * hands-off, two reviewers who answer it, and a paper that holds against the harness's checks.
 */

export type ResearchIds = Awaited<ReturnType<typeof fillResearch>>;

/** A reviewer who answers both questions from the fixture's verified claims, and the hypothesis. */
export function goodReviewer(name: string, ids: ResearchIds) {
  return {
    reviewer: name,
    pass: true,
    reasons: "Both questions are answered by verified claims.",
    research: {
      questions: [
        {
          index: 0,
          verdict: "answered" as const,
          certainty: "moderate" as const,
          answer: "The first run archived 42 pages.",
          claims: [ids.claims.verified],
          gaps: "",
          next_experiments: "",
        },
        {
          index: 1,
          verdict: "answered" as const,
          certainty: "high" as const,
          answer: "A clock the workers cannot stop keeps a long campaign honest.",
          claims: [ids.claims.clock],
          gaps: "",
          next_experiments: "",
        },
      ] as {
        index: number;
        verdict: "answered" | "insufficient" | "open";
        certainty: "high" | "moderate" | "low" | null;
        answer: string;
        claims: string[];
        gaps: string;
        next_experiments: string;
      }[],
      hypotheses: [
        {
          id: ids.hypothesis,
          verdict: "supported" as const,
          why: "The archive kept every page the workers read.",
          claims: [ids.claims.verified],
        },
      ],
    },
  };
}

/**
 * A research run past its minimum, with a card for each question, whose review the review panel
 * passed, accepted hands-off: it now waits for its paper once its supervisor says it has a final
 * writer. Close it when done.
 */
export async function answeredResearchRun(run = "r-1") {
  const r = await makeResearchRun(run);
  const ids = await fillResearch(r);
  writeCards(r, ids);
  const ledger = r.env.service.ledger;
  ledger.db
    .prepare("update run set created_at = ? where id = ?")
    .run(new Date(Date.now() - 3 * 3_600_000).toISOString(), run);
  const contract = r.env.service.contractFor(run) as Parameters<typeof researchPackage>[2];
  const due = researchReviewDue(ledger, run, contract, r.research.clock(run));
  assert.ok(due.due);
  const review = new Reviews(ledger).requestResearch({
    run,
    marker: due.marker,
    pkg: researchPackage(ledger, run, contract),
    by: "s",
  });
  assert.deepEqual(
    r.env.service.recordReviewPanel(
      review,
      [goodReviewer("reviewer-1", ids), goodReviewer("reviewer-2", ids)],
      "supervisor",
    ),
    { result: "review_passed", accepted: true },
  );
  return { ...r, ids, ledger, review };
}

/**
 * A paper that holds against the harness's checks, in the parts of a usual paper: it answers each
 * question with its own claim, gives the hypothesis the review panel's verdict, and states only
 * numbers the claims or the figures give. `over` replaces a part by its key.
 */
export function goodPaper(ids: ResearchIds, over: Partial<Record<string, string>> = {}): string {
  const v = ids.claims.verified;
  const c = ids.claims.clock;
  const parts = {
    title: "# What the first runs of the harness show",
    abstract: `## Abstract\n\nThis paper reports what the first runs of the harness show. The workers searched the web, and the harness archived each source and checked each claim against it. The first run archived 42 pages [${v}]. A long campaign stays honest when the workers cannot stop its clock [${c}]. The review panel found the first answer with moderate certainty and the second with high certainty.`,
    introduction:
      "## Introduction\n\nA long research campaign must keep the pages that it reads, and it must end at its time. This run asked how much the first run archived, and what keeps a long campaign honest. It also tested one hypothesis: stateless workers make long runs safe.",
    method:
      "## Method\n\nThe workers found 2 sources on 1 site. The harness archived each source, and it verified 2 claims against the archived text. The reviewers of the review panel then decided each question.",
    results: `## Results\n\nThe first run archived 42 pages [${v}]. The review panel found this answer with moderate certainty.\n\nA long campaign needs a clock that the workers cannot stop [${c}]. The review panel found this answer with high certainty.`,
    discussion: `## Discussion\n\nThe two answers agree. The archive kept every page that the workers read [${v}]. The review panel found the hypothesis that stateless workers make long runs safe supported.`,
    limitations:
      "## Limitations\n\nAll the claims come from 1 site. 1 claim stays a draft, and 1 finding stays a draft.",
    next: `## Future work\n\n### For a hill climb\n\nFind a second site that gives the number of pages [${v}].`,
    ...over,
  };
  return `${Object.values(parts).join("\n\n")}\n`;
}

/** The STE result of a rig with no checker. */
export const NO_STE = { checked: false, why: "the rig has no STE checker" } as const;
