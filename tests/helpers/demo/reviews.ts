import { callUsage } from "../../../src/core/usage.ts";
import { iso, type Rig, urnd } from "./shared.ts";

/**
 * The research run RS's reviews on c1: the owner's message to the review panel, each review and
 * its items, the tries of review 3 that failed, and the reviewers' model calls.
 */
export function researchReviews(c1: Rig, RS: string): void {
  // The owner's message to the review panel, and its answer.
  c1.ev(2.5, "agent_message", RS, {
    id: 7,
    to: "review_panel",
    text: "Judge question 4 against what sources can say: how many repetitions a rig needs is a next experiment.",
  });
  // Reviews: each asked, each reviewer's answers per item, the decision on each item.
  const review = (
    n: number,
    asked: number,
    claims: number,
    posted: number | null,
    answers: Record<string, [string, string | null][]>,
    decided: [string, string, string, string | null, number | null, number | null][],
    result: string,
  ) => {
    c1.ev(asked, "review_requested", RS, {
      review: n,
      goal: "research",
      commit: `corpus:${claims}:0:c-${n}`,
      questions: 4,
      hypotheses: n === 1 ? 2 : 3,
      verified_claims: claims,
    });
    if (posted === null) return;
    for (const [reviewer, verdicts] of Object.entries(answers))
      c1.ev(posted + 0.02, "review_items", RS, {
        review: n,
        reviewer,
        items: decided.map(([kind, key, , , , version], i) => ({
          kind,
          key: kind === "question" ? Number(key) : key,
          card_version: version,
          verdict: verdicts[i]?.[0] ?? "open",
          certainty: verdicts[i]?.[1] ?? null,
          reasons:
            verdicts[i]?.[0] === "open"
              ? "The card names its gap itself: no source yet measures driver jitter apart from clocks."
              : "The cited claims answer it directly, from independent sites.",
          claims: [`c-${key}1`, `c-${key}2`],
          problems:
            reviewer === "reviewer-3" && i === 1 && n === 1
              ? ["the number 12 is not in the claims it cites"]
              : [],
        })),
      });
    for (const [kind, key, decision, certainty, dissent, version] of decided)
      c1.ev(posted + 0.01, "item_decided", RS, {
        review: n,
        kind,
        key: kind === "question" ? Number(key) : key,
        card_version: version,
        decision,
        certainty,
        dissent:
          dissent === null
            ? []
            : [
                {
                  reviewer: `reviewer-${dissent}`,
                  verdict: kind === "question" ? "open" : "undecided",
                  certainty: null,
                  reasons: "One site only: I would wait for a second.",
                },
              ],
      });
    c1.ev(posted, "review_panel", RS, {
      review: n,
      goal: "research",
      result,
      reviewers: Object.keys(answers).length,
      decided: decided.filter(([, , d]) => d !== "open" && d !== "undecided").length,
      open: decided.filter(([, , d]) => d === "open" || d === "undecided").length,
    });
  };
  review(
    1,
    4.5,
    64,
    4.2,
    {
      "reviewer-1": [
        ["answered", "moderate"],
        ["open", null],
        ["open", null],
        ["open", null],
        ["supported", null],
        ["undecided", null],
      ],
      "reviewer-2": [
        ["answered", "moderate"],
        ["open", null],
        ["open", null],
        ["open", null],
        ["supported", null],
        ["undecided", null],
      ],
      "reviewer-3": [
        ["answered", "low"],
        ["answered", "low"],
        ["open", null],
        ["open", null],
        ["supported", null],
        ["undecided", null],
      ],
    },
    [
      ["question", "0", "answered", "moderate", null, 1],
      ["question", "1", "open", null, 3, 1],
      ["question", "2", "open", null, null, 1],
      ["question", "3", "open", null, null, 1],
      ["hypothesis", "h-a1", "supported", null, null, null],
      ["hypothesis", "h-a2", "undecided", null, null, null],
    ],
    "review_failed",
  );
  review(
    2,
    2.2,
    97,
    1.9,
    {
      "reviewer-1": [
        ["answered", "high"],
        ["answered", "moderate"],
        ["open", null],
        ["insufficient", null],
        ["supported", null],
        ["undecided", null],
        ["supported", null],
      ],
      "reviewer-2": [
        ["answered", "high"],
        ["answered", "moderate"],
        ["open", null],
        ["insufficient", null],
        ["supported", null],
        ["supported", null],
        ["supported", null],
      ],
      "reviewer-3": [
        ["answered", "high"],
        ["open", null],
        ["open", null],
        ["insufficient", null],
        ["supported", null],
        ["undecided", null],
        ["supported", null],
      ],
    },
    [
      ["question", "0", "answered", "high", null, 2],
      ["question", "1", "answered", "moderate", 3, 3],
      ["question", "2", "open", null, null, 2],
      ["question", "3", "insufficient", null, null, 1],
      ["hypothesis", "h-a1", "supported", null, null, null],
      ["hypothesis", "h-a2", "undecided", null, 2, null],
      ["hypothesis", "h-p2", "supported", null, null, null],
    ],
    "review_failed",
  );
  c1.ev(1.88, "agent_message_read", RS, { message: 7, by: "review_panel" });
  c1.ev(
    1.88,
    "advisor_answer",
    RS,
    {
      message: 7,
      role: "review_panel",
      advisor: "reviewer-1",
      text: "Understood: question 4 is the best available, insufficient; the repetitions a rig needs are a next experiment.",
    },
    "supervisor",
  );
  review(3, 0.6, 112, null, {}, [], "");
  // Review 3's tries that could not be posted, as the harness keeps them (goal 116).
  c1.ev(0.54, "review_try_failed", RS, {
    review: 3,
    try: 1,
    error:
      "2 of 3 reviewers of the review panel answered (reviewer-2: the provider refused: 429 too many requests)",
  });
  c1.ev(0.05, "review_try_failed", RS, {
    review: 3,
    try: 2,
    error:
      "1 of 3 reviewers of the review panel answered (reviewer-2: the provider refused: 429 too many requests; reviewer-3: no answer in 15 min)",
  });
  for (const [h, run, calls] of [
    [4.3, "review 1", 3],
    [2.0, "review 2", 3],
    [0.5, "review 3", 2],
  ] as const)
    for (const reviewer of ["reviewer-1", "reviewer-2", "reviewer-3"].slice(0, calls)) {
      const tokensIn = 60_000 + Math.floor(urnd() * 30_000);
      const tokensOut = 2_000 + Math.floor(urnd() * 1_500);
      c1.ev(h, "model_call", RS, {
        trial: null,
        round: run,
        agent: "review_panel",
        harness: "pi",
        provider: "demo-models",
        model: reviewer === "reviewer-3" ? "kimi-k3" : "glm-5.1",
        ...callUsage({
          at: iso(h),
          calls: 6,
          tokensIn,
          cachedIn: Math.floor(tokensIn * 0.6),
          tokensOut,
          firstTokenMs: 1200,
          callMs: 95_000 + Math.floor(urnd() * 60_000),
        }),
      });
    }
}
