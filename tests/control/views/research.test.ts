import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { sentence } from "../../../src/control/ui/words/index.ts";
import type { RigView, StoredEvent } from "../../../src/control/views/index.ts";
import { at, researchControl, researchRunEvents } from "../../helpers/research-reviews.ts";

/**
 * Goals 116 and 117 in control's read model, from a rig's events: a research run's hypotheses
 * with their status, each reviewer's answers per item and the review panel's decision on each,
 * the decisions that still stand, the progress rule's state and each research task's question
 * and yield, as MCP's get_run and run_queue give them; and History's words for each new event.
 */

describe("a research run's items on control (goals 116 and 117)", () => {
  test("get_run and run_queue carry the decisions, each review's items, the progress rule, the hypotheses and each task's question and yield", async () => {
    const c = await researchControl();
    await c.ingest(researchRunEvents());
    const run = await c.mcp("get_run", { run: "s-1" });
    assert.deepEqual(
      run.standing.map((s: Record<string, unknown>) => [
        s.kind,
        s.key,
        s.decision,
        s.certainty,
        s.stands,
        s.newer_card,
      ]),
      [
        ["question", "0", "answered", "high", false, 2],
        ["question", "1", "insufficient", null, true, null],
        ["hypothesis", "h-a1", "supported", null, true, null],
        ["hypothesis", "h-p2", "supported", null, true, null],
      ],
    );
    assert.equal(run.decisions.length, 6);
    const r1 = run.reviews.find((r: { review: number }) => r.review === 1);
    assert.deepEqual(
      r1.reviewers.map((x: { reviewer: string; items: unknown[] }) => [x.reviewer, x.items.length]),
      [
        ["reviewer-1", 3],
        ["reviewer-3", 3],
      ],
    );
    assert.deepEqual(r1.reviewers[1].items[1].problems, [
      "the number 12 is not in the claims it cites",
    ]);
    assert.deepEqual(r1.decided[2].dissent, [
      { reviewer: "reviewer-3", verdict: "undecided", certainty: null, reasons: "One site only." },
    ]);
    assert.deepEqual(r1.saw, { questions: 3, hypotheses: 2, verified_claims: 9 });
    assert.deepEqual(r1.counts, { reviewers: 3, decided: 2, open: 1 });
    const r2 = run.reviews.find((r: { review: number }) => r.review === 2);
    // Counts given as lists count their items.
    assert.deepEqual(r2.counts, { reviewers: 3, decided: 3, open: 0 });
    assert.equal(r2.tries, 3);
    assert.deepEqual(
      r2.failed_tries.map((f: { try: number; error: string }) => [f.try, f.error]),
      [
        [1, "2 of 3 reviewers of the review panel answered"],
        [2, "reviewer-2: the answer was not JSON"],
      ],
    );
    assert.equal(r2.owner_note, "Good enough.");
    assert.ok(r2.requested_at < r2.posted_at && r2.posted_at < r2.owner_at);
    assert.deepEqual(
      { ...run.progress, at: undefined, last_improvement: undefined },
      {
        at: undefined,
        open: [0, 2],
        saturated: [2],
        last_improvement: undefined,
        since_ms: 3_600_000,
        needed_ms: 7_200_000,
      },
    );
    assert.deepEqual(
      run.hypotheses.map((h: Record<string, unknown>) => [h.id, h.status, h.question, h.by]),
      [
        ["h-a1", "author", null, "brief"],
        ["h-a2", "author", null, "brief"],
        ["h-p1", "pool", 1, "lane-1"],
        ["h-p2", "promoted", 0, "lane-2"],
        ["h-p3", "merged", 1, "lane-1"],
        ["h-p4", "retired", 2, "lane-2"],
      ],
    );
    assert.equal(run.hypotheses[4].merged_into, "h-p1");
    assert.deepEqual(
      { ...run.hypotheses[3].status_change, at: undefined },
      {
        status: "promoted",
        by: "control:owner:ui",
        reason: "Question 1 turns on it.",
        at: undefined,
      },
    );
    const queue = await c.mcp("run_queue", { run: "s-1" });
    const x1 = queue.tried.find((x: { id: string }) => x.id === "x-1");
    assert.equal(x1.question, 0);
    assert.deepEqual(x1.yield.by_question, [
      { question: 0, verified_claims: 3, new_domain_claims: 2 },
    ]);
    assert.equal(queue.up_next.find((x: { id: string }) => x.id === "x-4").question, 2);
    assert.equal(queue.in_progress[0].yield, null);
  });

  test("History says a failed review try and the progress rule's stop; a digest's progress alone is not said", () => {
    const say = (kind: string, body: Record<string, unknown>) =>
      sentence(
        { runs: [] } as unknown as RigView,
        {
          seq: 1,
          id: 1,
          at: at(1),
          actor: "harness",
          kind,
          subject: "s-1",
          body,
        } as unknown as StoredEvent,
      )?.text;
    assert.equal(
      say("review_try_failed", {
        review: 4,
        try: 2,
        error: "2 of 3 reviewers of the review panel answered",
      }),
      "Review 4, try 2, could not be posted: 2 of 3 reviewers of the review panel answered. It is tried again at the review panel's next round.",
    );
    assert.equal(say("research_progress", { open: [1], stopped: false }), undefined);
    // A paper's next experiments, by the run each is for (goal 119).
    assert.equal(
      say("research_paper_accepted", {
        cited_claims: 4,
        ste: { checked: false },
        experiments: [{ kind: "hill_climb" }, { kind: "goal" }, { kind: "goal" }],
      }),
      "The research paper passed the harness's checks (no STE checker on the rig). It cites 4 claims, and 3 next experiments (1 for a hill climb, 2 for a goal campaign) went to the knowledge base.",
    );
    assert.match(
      String(say("research_stopped", { open: { questions: [1, 3], hypotheses: [] } })),
      /^Research stopped adding: 2 questions stay open, every open one saturated/,
    );
  });

  test("History says each new event in words", () => {
    const say = (kind: string, body: Record<string, unknown>, actor = "harness") =>
      sentence(
        { runs: [] } as unknown as RigView,
        {
          seq: 1,
          id: 1,
          at: at(1),
          actor,
          kind,
          subject: "s-1",
          body,
        } as unknown as StoredEvent,
      )?.text;
    assert.equal(
      say("hypothesis_status", {
        hypothesis: "h-p1",
        status: "promoted",
        by: "control:owner:ui",
        reason: "It matters.",
      }),
      "You promoted hypothesis h-p1: the review panel must give it a verdict. Why: It matters.",
    );
    assert.equal(
      say("hypothesis_status", {
        hypothesis: "h-p4",
        status: "retired",
        by: "planner",
        reason: "Out of scope",
      }),
      "The planner retired hypothesis h-p4. Why: Out of scope.",
    );
    assert.equal(
      say("item_decided", {
        review: 2,
        kind: "question",
        key: 1,
        decision: "answered",
        certainty: "moderate",
        dissent: [{ reviewer: "r-3" }],
      }),
      "In review 2, the review panel decided Question 2: answered, certainty moderate (1 reviewer dissents).",
    );
    assert.equal(
      say("review_items", {
        review: 2,
        reviewer: "reviewer-1",
        items: [
          { kind: "question", verdict: "answered", problems: [] },
          { kind: "question", verdict: "open", problems: ["the number 4 is not in its claims"] },
          { kind: "hypothesis", verdict: "supported", problems: [] },
        ],
      }),
      "reviewer-1 answered review 2: 1 of 2 questions answered, 1 of 1 hypothesis decided. Code found problems in 1 answer.",
    );
    assert.equal(
      say("review_panel", {
        review: 2,
        goal: "research",
        result: "review_failed",
        decided: 3,
        open: 2,
      }),
      "Review 2 is in: the review panel did not pass it, with 3 items decided and 2 still open.",
    );
    assert.equal(
      say("hypothesis_added", {
        hypothesis: "h-p1",
        lane: "lane-1",
        text: "Boost clocks vary.",
        question: 1,
        status: "pool",
      }),
      'lane-1 proposed a hypothesis for the pool (Question 2): "Boost clocks vary.".',
    );
    assert.equal(
      say("hypothesis_merged", { hypothesis: "h-p3", into: "h-p1" }),
      "Hypothesis h-p3 was merged into h-p1: its new words repeat it.",
    );
  });
});
