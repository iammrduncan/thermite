import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { StoredRule } from "../../../../src/core/directives.ts";
import { GAP_LINE, MEASURES_NOTHING, questionLabel } from "../../../../src/core/research-check.ts";
import {
  PLANNER_PROMOTIONS_MAX,
  type PlannerHypotheses,
  POOL_SHOWN,
  planResearch,
  type ResearchPlannerInput,
  researchPlannerContext,
  validateResearchPlan,
} from "../../../../src/harness/agents/research/planner.ts";
import type { QueueBrief } from "../../../../src/harness/queue.ts";
import type { QuestionState, ResearchState } from "../../../../src/harness/research/shares.ts";

/**
 * Goals 047 and 117: code checks every task of the research planner's answer, at the scale of a
 * long run: six questions (one decided, one saturated), 40 tasks up next, 200 pool hypotheses.
 */

function question(index: number, o: Partial<QuestionState> = {}): QuestionState {
  return {
    index,
    label: questionLabel(index),
    text: `What is true of topic ${index + 1}?`,
    rubric: `Cover topic ${index + 1} fully.`,
    verified_claims: 60 - index * 5,
    card: {
      version: 2,
      certainty: "low",
      answer: `The answer to question ${index + 1} so far.`,
      evidence_gaps: [`Q${index} gap 1: the vendor's specification`, `Q${index} gap 2: a paper`],
      measurement_gaps: 1,
    },
    decision: null,
    decided: false,
    saturated: false,
    share: 0,
    round: 0,
    tasks: 12,
    yield: { tasks: 4, verified_claims: 6, new_domain_claims: 2 },
    gapped: true,
    weight: 5,
    ...o,
  };
}

function scene(
  o: { allSaturated?: boolean; promoted?: number; rules?: StoredRule[] } = {},
): ResearchPlannerInput {
  const questions = [0, 1, 2, 3, 4, 5].map((i) =>
    i === 3
      ? question(i, {
          decided: true,
          weight: 0,
          decision: { decision: "answered", certainty: "moderate", review: 7 },
        })
      : i === 4
        ? question(i, { saturated: true, weight: o.allSaturated ? 5 : 0 })
        : question(i),
  );
  const state: ResearchState = {
    questions,
    window: 4,
    recent: [0, 1, 2, 5],
    allSaturated: o.allSaturated ?? false,
    allDecided: false,
  };
  const queue: QueueBrief = {
    up_next: [
      { id: "x-owner000003", title: "Read the errata", question: 3, by: "owner" },
      { id: "x-teach000003", title: "More on topic 4", question: 3, by: "teacher" },
      { id: "x-noq00000000", title: "Something", by: "teacher" },
      ...Array.from({ length: 37 }, (_, i) => ({
        id: `x-t${String(i).padStart(10, "0")}`,
        title: `Teacher's lead ${i}`,
        question: 0,
        family: "explore",
        by: "teacher",
      })),
    ],
    proposed: [
      { id: "x-idea0000002", title: "An idea on topic 3", question: 2, by: "lane-1" },
      { id: "x-idea0000none", title: "An idea on nothing", by: "lane-2" },
    ],
    in_progress: [
      { id: "x-busy00000000", title: "Busy", question: 1, by: "planner", lane: "lane-9" },
    ],
    tried: [
      { id: "x-done00000000", title: "Done", question: 1, by: "planner", result: "finished" },
    ],
  };
  const pool = Array.from({ length: 200 }, (_, i) => ({
    id: `h-pool${String(i).padStart(4, "0")}`,
    status: "pool",
    question: i % 6,
    text: `Hypothesis ${i}.`,
    supporting: 200 - i,
    by: "lane-1",
  }));
  const hypotheses: PlannerHypotheses = {
    required: [
      {
        id: "h-author0",
        status: "author",
        question: null,
        text: "A.",
        supporting: 2,
        by: "author",
      },
      { id: "h-promo00", status: "promoted", question: 1, text: "P.", supporting: 3, by: "lane-2" },
    ],
    pool: pool.slice(0, POOL_SHOWN),
    pool_total: pool.length,
    promoted_by_planner: o.promoted ?? 0,
    owner_set: ["h-pool0005"],
    status: Object.fromEntries([
      ["h-author0", "author"],
      ["h-promo00", "promoted"],
      ["h-merged0", "merged"],
      ...pool.map((h) => [h.id, h.status]),
    ]),
  };
  return {
    run: "r-1",
    epoch: 9,
    laneCount: 3,
    title: "A survey",
    topic: "A topic",
    state,
    queue,
    hypotheses,
    directives: (o.rules ?? []).map((body, i) => ({ id: i + 1, body })),
  };
}

const task = (question: number, more: Record<string, unknown> = {}) => ({
  question,
  gap: `Q${question} gap 1: the vendor's specification`,
  source_kind: "the vendor's architecture manual",
  title: "Read the manual's chapter",
  ...more,
});

describe("the research planner's answer, checked in code (goals 047 and 117)", () => {
  test("a good plan: tasks named by question and gap, queued ones and ideas given out, hypotheses promoted and retired", () => {
    const input = scene({ promoted: 4 });
    const { errors, plan } = validateResearchPlan(
      {
        assignments: [
          { lane: "lane-1", task: "new-1", why: "topic 3 has two open gaps" },
          {
            lane: "lane-2",
            ...task(5, { kind: "primary", details: "Start at chapter 4." }),
            why: "gap 1",
          },
          { lane: "lane-3", task: "x-owner000003", why: "the owner's task" },
        ],
        add: [
          {
            ref: "new-1",
            ...task(2, { title: "Question 3 (index 2): Occupancy in the guide", kind: "explore" }),
            why: "its card names the gap",
          },
        ],
        accept: [{ id: "x-idea0000002", why: "a distinct idea for topic 3" }],
        drop: [{ id: "x-teach000003", why: "its question is decided" }],
        move: [{ id: "x-t0000000001", position: "top", why: "next lead" }],
        promote: [
          { id: "h-pool0000", why: "central to question 1" },
          { id: "h-pool0001", why: "central to question 2" },
        ],
        retire: [{ id: "h-pool0002", why: "repeats h-pool0000" }],
        notes: "two gaps first",
      },
      input,
    );
    assert.deepEqual(errors, []);
    assert.ok(plan);
    const add = plan.queue.add;
    assert.deepEqual(
      add.map((a) => [a.ref, a.question, a.family, a.title]),
      [
        ["new-1", 2, "explore", "Question 3 (index 2): Occupancy in the guide"],
        ["@lane-2", 5, "primary", "Question 6 (index 5): Read the manual's chapter"],
      ],
    );
    assert.equal(
      add[1]?.details,
      `${GAP_LINE}Q5 gap 1: the vendor's specification\nWhat to read: the vendor's architecture manual\nStart at chapter 4.\nQuestion 6 (index 5): What is true of topic 6?`,
    );
    assert.deepEqual(
      plan.queue.handout.map((h) => [h.lane, h.experiment]),
      [
        ["lane-1", "new-1"],
        ["lane-2", "@lane-2"],
        ["lane-3", "x-owner000003"],
      ],
    );
    assert.deepEqual(
      plan.promote.map((x) => x.id),
      ["h-pool0000", "h-pool0001"],
    );
    assert.deepEqual(
      plan.retire.map((x) => x.id),
      ["h-pool0002"],
    );
    assert.deepEqual(plan.queue.rules, []);
  });

  test("refused in words: decided and saturated questions, measurements, unknown questions and kinds, rules, ideas with no question, and hypotheses it may not change", () => {
    const input = scene({
      promoted: PLANNER_PROMOTIONS_MAX - 1,
      rules: [
        { kind: "avoid", family: "consolidate", rationale: "r", citations: [] },
        { kind: "mandate", family: "contradict", rationale: "r", citations: [] },
      ],
    });
    const { errors } = validateResearchPlan(
      {
        assignments: [
          { lane: "lane-1", ...task(3) },
          { lane: "lane-2", task: "x-teach000003" },
          { lane: "lane-3", task: "x-noq00000000" },
        ],
        add: [
          { ref: "a", ...task(4), why: "w" },
          { ref: "b", ...task(9), why: "w" },
          { ref: "c", ...task(0, { gap: "Time the kernel on the card" }), why: "w" },
          { ref: "d", ...task(1, { details: "Then run a benchmark of it" }), why: "w" },
          { ref: "e", ...task(2, { kind: "survey" }), why: "w" },
          { ref: "f", ...task(2, { kind: "consolidate" }), why: "w" },
        ],
        accept: [{ id: "x-idea0000none", why: "w" }],
        move: [{ id: "x-busy00000000", position: "top", why: "w" }],
        promote: [
          { id: "h-pool0010", why: "w" },
          { id: "h-author0", why: "w" },
        ],
        retire: [
          { id: "h-pool0005", why: "w" },
          { id: "h-promo00", why: "w" },
          { id: "h-pool0010", why: "w" },
        ],
      },
      input,
    );
    const expect = [
      "lane-1: Question 4 (index 3) is decided (answered at moderate, review 7): its decision stands until its card changes, so give the lane a question still open",
      "lane-2: task x-teach000003: Question 4 (index 3) is decided (answered at moderate, review 7): its decision stands until its card changes, so give the lane a question still open",
      "lane-3: task x-noq00000000 names no question: add a task for it with its question and gap instead",
      "add a: Question 5 (index 4) is saturated (its last 4 tasks added no verified claim from a new site, and its card's certainty did not rise): give the lane a question still open, unless every open question is saturated",
      "add b: question 9 is not one of the run's questions (an index from 0 to 5)",
      'add c: its gap asks for a measurement ("Time the"), and a research run measures nothing: that is a next experiment for a goal or hill-climb run, not a task; name a gap a source could close',
      'add d: it asks for a measurement ("run a benchmark"), and a research run measures nothing: give it only work that sources can answer',
      'add e: kind "survey" is not a task kind (explore, primary, contradict, consolidate)',
      "add f: kind consolidate is under an AVOID rule",
      "MANDATE rule: give a lane a task of kind contradict (add one if the queue has none)",
      "move x-busy00000000: only queued tasks move (in progress on lane-9)",
      "accept x-idea0000none: the idea names no question: add a task for it with its question and gap instead, and drop the idea",
      "promote h-author0: it is the author's, which needs a verdict: only a pool hypothesis can be promoted",
      "promote: at most 1 more in this run (the planner promotes at most 10 a run; the owner may promote more)",
      "retire h-pool0005: the owner set its status last: leave it to the owner",
      "retire h-promo00: it is promoted, which needs a verdict: only a pool hypothesis can be retired",
      "retire h-pool0010: it is changed twice in this answer",
    ];
    for (const e of expect)
      assert.ok(errors.includes(e), `missing: ${e}\n\nall:\n${errors.join("\n")}`);
    assert.equal(errors.length, expect.length, errors.join("\n"));
    // The form: every lane once, and no more than 3 promotions a round.
    const form = validateResearchPlan(
      {
        assignments: [{ lane: "lane-1", task: "x-owner000003" }, { lane: "lane-1" }],
        promote: [1, 2, 3, 4].map((i) => ({ id: `h-pool000${i}`, why: "w" })),
      },
      input,
    );
    assert.match(form.errors.join("\n"), /promote: Too big: expected array to have <=3 items/);
    const lanes = validateResearchPlan(
      { assignments: [{ lane: "lane-1", task: "x-owner000003" }, { lane: "lane-1" }] },
      input,
    );
    assert.deepEqual(lanes.errors.slice(0, 2), [
      "assign each of lane-1, lane-2, lane-3 exactly once (got lane-1, lane-1)",
      "lane-1: name a task (an id from the queue or the ref of one you add), or give a new one with question, gap, source_kind and title",
    ]);
  });

  test("when every open question is saturated, a saturated one may get tasks again; a decided one still may not", () => {
    const input = scene({ allSaturated: true });
    const { errors } = validateResearchPlan(
      {
        assignments: [
          { lane: "lane-1", ...task(4) },
          { lane: "lane-2", ...task(4, { title: "Another chapter" }) },
          { lane: "lane-3", ...task(3) },
        ],
      },
      input,
    );
    assert.deepEqual(errors, [
      "lane-3: Question 4 (index 3) is decided (answered at moderate, review 7): its decision stands until its card changes, so give the lane a question still open",
    ]);
  });

  test("the context: the cards and their gaps, the run's figures, the rules, and a cut pool that says so", () => {
    const input = scene({
      promoted: 3,
      rules: [
        { kind: "try", family: "primary", rationale: "r", citations: [] },
        { kind: "mandate", value: 2, rationale: "r", citations: [] },
      ],
    });
    const q0 = input.state.questions[0];
    if (q0?.card) q0.card.answer = "a".repeat(4000);
    const c = JSON.parse(researchPlannerContext(input)) as Record<string, unknown>;
    assert.equal(c.measures_nothing, MEASURES_NOTHING);
    assert.equal(c.ceiling, 2);
    const qs = c.questions as {
      label: string;
      card: { answer: string; evidence_gaps: string[] } | null;
      decided: boolean;
      saturated: boolean;
      weight: number;
      share: { tasks: number; of_last: number };
    }[];
    assert.equal(qs.length, 6);
    assert.match(String(qs[0]?.card?.answer), /… \(cut here: the answer has 4,000 characters\)$/);
    assert.deepEqual(qs[2]?.card?.evidence_gaps, [
      "Q2 gap 1: the vendor's specification",
      "Q2 gap 2: a paper",
    ]);
    assert.deepEqual(
      qs.map((q) => [q.decided, q.saturated, q.weight]),
      [
        [false, false, 5],
        [false, false, 5],
        [false, false, 5],
        [true, false, 0],
        [false, true, 0],
        [false, false, 5],
      ],
    );
    assert.deepEqual(qs[0]?.share, { tasks: 0, of_last: 4 });
    const h = c.hypotheses as Record<string, unknown>;
    assert.equal((h.pool as unknown[]).length, POOL_SHOWN);
    assert.equal(h.pool_total, 200);
    assert.equal(
      h.pool_cut,
      "the 60 best supported of 200: the rest are in hypotheses/ of the research folder",
    );
    assert.equal(h.promote_left, PLANNER_PROMOTIONS_MAX - 3);
    assert.deepEqual(h.owner_set, ["h-pool0005"]);
    assert.equal(h.status, undefined, "the checks' own map stays out of the prompt");
    assert.deepEqual(c.rules, { avoid: [], mandate: [], try: ["primary"], questions_first: [2] });
    assert.equal((c.queue as QueueBrief).up_next.length, 40);
  });

  test("through another harness: the research prompt, the plan as JSON text, and a refusal sent back once", async () => {
    const input = scene();
    const prompts: string[] = [];
    const answers = [
      // A first answer whose task is for the decided question, then a good one.
      JSON.stringify({
        assignments: [
          { lane: "lane-1", ...task(3) },
          { lane: "lane-2", ...task(0) },
          { lane: "lane-3", ...task(1) },
        ],
      }),
      `Here is the plan:\n\`\`\`json\n${JSON.stringify({
        assignments: [
          { lane: "lane-1", ...task(2) },
          { lane: "lane-2", ...task(0) },
          { lane: "lane-3", ...task(1) },
        ],
        journal: [{ kind: "decision", text: "Open gaps first." }],
      })}\n\`\`\``,
    ];
    const r = await planResearch(
      input,
      {
        baseUrl: "http://127.0.0.1:9",
        model: "m",
        apiKey: "k",
        contextWindow: 64_000,
        maxTokens: 2000,
      },
      undefined,
      async (prompt) => {
        prompts.push(prompt);
        return answers[prompts.length - 1] ?? "";
      },
    );
    assert.equal(r.source, "planner");
    assert.equal(r.tries, 2);
    assert.deepEqual(
      r.causes?.map((c) => c.cause),
      ["invalid"],
    );
    assert.match(String(r.causes?.[0]?.detail), /^lane-1: Question 4 \(index 3\) is decided/);
    assert.deepEqual(
      r.plan?.queue.handout.map((h) => [
        h.lane,
        r.plan?.queue.add.find((a) => a.ref === h.experiment)?.question,
      ]),
      [
        ["lane-1", 2],
        ["lane-2", 0],
        ["lane-3", 1],
      ],
    );
    assert.deepEqual(r.journal, [{ kind: "decision", text: "Open gaps first." }]);
    assert.match(prompts[0] ?? "", /^You plan the next round of an automated research run\./);
    assert.match(
      prompts[0] ?? "",
      /Answer with only the plan, as one JSON object: \{"assignments": \[\{"lane": "lane-1", "task":/,
    );
    assert.match(prompts[0] ?? "", /Use no tools\.\n\nThe campaign, as JSON:\n\{/);
    assert.match(
      prompts[1] ?? "",
      /Your previous plan was refused:\n- lane-1: Question 4 \(index 3\) is decided/,
    );
    // No model: no call, and the scheduler plans the round in code.
    const none = await planResearch(input);
    assert.deepEqual([none.source, none.tries, none.plan], ["fallback", 0, undefined]);
  });
});
