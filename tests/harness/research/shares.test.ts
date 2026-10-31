import assert from "node:assert/strict";
import { describe, type TestContext, test } from "node:test";
import type { Ledger } from "../../../src/harness/ledger/index.ts";
import {
  ceilingOf,
  floorOf,
  gapOf,
  gapPlan,
  NO_CARD_GAP,
  NO_GAP_NAMED,
  nextGap,
  researchState,
} from "../../../src/harness/research/shares.ts";
import { makeResearchRun } from "../../helpers/research-run.ts";

/**
 * Goal 117's gap-driven plan, at the scale of a long run: six questions, hundreds of verified
 * claims, cards at every certainty, a decided question and a saturated one, and long rounds of
 * tasks. The scheduler's side (the hand-out, the queue) is in scheduler-research.test.ts.
 */

const RUN = "r-1";
const QUESTIONS = [
  "Which memory spaces does the architecture expose?",
  "How are warps scheduled?",
  "What limits occupancy?",
  "How does the cache hierarchy behave under contention?",
  "Which instructions changed between generations?",
  "How do the vendor's tools report stalls?",
];
const T0 = Date.parse("2026-10-24T00:00:00.000Z");
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();

async function scene(t: TestContext) {
  const r = await makeResearchRun(RUN, { contract: { questions: QUESTIONS } });
  t.after(() => r.close());
  const ledger = r.env.service.ledger as Ledger;
  const db = ledger.db;
  // 330 verified claims, more on the first questions, and 40 drafts.
  let c = 0;
  const claim = (question: number, verified: boolean) =>
    db
      .prepare(
        "insert into claim (id, run, lane, question, text, quotes, verified, created_at) values (?, ?, 'lane-1', ?, ?, '[]', ?, ?)",
      )
      .run(`c-${++c}`, RUN, question, `Claim ${c}.`, verified ? 1 : 0, at(c % 600));
  for (const [q, n] of [
    [0, 120],
    [1, 90],
    [2, 0],
    [3, 60],
    [4, 40],
    [5, 20],
  ] as const)
    for (let i = 0; i < n; i++) claim(q, true);
  for (let i = 0; i < 40; i++) claim(i % 6, false);
  const card = (
    question: number,
    version: number,
    certainty: string,
    evidence: number,
    measurement = 0,
    min = 100,
  ) =>
    db
      .prepare(
        "insert into question_card (run, question, version, answer, certainty, claims, gaps, by, created_at) values (?, ?, ?, 'An answer.', ?, '[]', ?, 'synth', ?)",
      )
      .run(
        RUN,
        question,
        version,
        certainty,
        JSON.stringify([
          ...Array.from({ length: evidence }, (_, i) => ({
            kind: "evidence",
            text: `Q${question} gap ${i + 1}: a vendor document`,
          })),
          ...Array.from({ length: measurement }, (_, i) => ({
            kind: "measurement",
            text: `Q${question} measure ${i + 1}`,
          })),
        ]),
        at(min),
      );
  // Q1 (index 0): low, 3 evidence gaps and a measurement; Q2: high, none; Q3: no card; Q4:
  // moderate, decided; Q5: none, saturated; Q6: low, 6 gaps. Earlier versions are not the card.
  card(0, 1, "none", 8);
  card(0, 2, "low", 3, 1);
  card(1, 1, "high", 0);
  card(3, 1, "moderate", 2);
  card(4, 1, "none", 1, 0, 50);
  card(5, 1, "low", 6);
  const review = Number(
    (
      db
        .prepare(
          "insert into review (run, goal, commit_sha, package, requested_at) values (?, 'research', 'corpus:1', '{}', ?) returning id",
        )
        .get(RUN, at(200)) as { id: number }
    ).id,
  );
  db.prepare(
    "insert into item_decision (run, kind, key, review, card_version, decision, certainty, decided_at) values (?, 'question', '3', ?, 1, 'answered', 'moderate', ?)",
  ).run(RUN, review, at(210));
  // Q5 (index 4): its last four tasks added no claim from a new site, and its card's certainty did not rise.
  for (let i = 0; i < 4; i++)
    db.prepare(
      "insert into experiment (id, run, title, added_by, state, question, yield, created_at, updated_at) values (?, ?, 't', 'planner', 'done', 4, ?, ?, ?)",
    ).run(
      `x-sat-${i}`,
      RUN,
      JSON.stringify({
        verified_claims: 2,
        by_question: [{ question: 4, verified_claims: 2, new_domain_claims: 0 }],
        new_domains: 0,
        domains: [],
        findings: 0,
        card_changes: 0,
      }),
      at(300 + i),
      at(301 + i),
    );
  return { ledger, db, card };
}

describe("the gap-driven plan (goal 117)", () => {
  test("weights from the cards: open gaps and low certainty weigh more; decided and saturated get none; no card weighs as the most open", async (t) => {
    const s = await scene(t);
    const state = researchState(s.ledger, RUN, { questions: QUESTIONS }, { lanes: 2 });
    assert.equal(state.window, 4);
    assert.equal(ceilingOf(state), 2);
    assert.deepEqual(
      state.questions.map((q) => q.verified_claims),
      [120, 90, 0, 60, 40, 20],
    );
    assert.deepEqual(
      state.questions.map((q) => q.card?.certainty ?? null),
      ["low", "high", null, "moderate", "none", "low"],
    );
    assert.deepEqual(state.questions[0]?.card?.evidence_gaps, [
      "Q0 gap 1: a vendor document",
      "Q0 gap 2: a vendor document",
      "Q0 gap 3: a vendor document",
    ]);
    assert.equal(state.questions[0]?.card?.measurement_gaps, 1);
    assert.deepEqual(
      state.questions.map((q) => [q.decided, q.saturated]),
      [
        [false, false],
        [false, false],
        [false, false],
        [true, false],
        [false, true],
        [false, false],
      ],
    );
    assert.deepEqual(state.questions[3]?.decision, {
      decision: "answered",
      certainty: "moderate",
      review: 1,
    });
    assert.deepEqual(state.questions[4]?.yield, {
      tasks: 4,
      verified_claims: 8,
      new_domain_claims: 0,
    });
    // low + 3 gaps; high + 0; no card: the most open (low + 6 = 9); decided; saturated; low + 6.
    assert.deepEqual(
      state.questions.map((q) => q.weight),
      [6, 1, 9, 0, 0, 9],
    );
    assert.equal(state.allSaturated, false);
    assert.equal(state.allDecided, false);
    // The floor: the weighed questions with open evidence gaps or no card, the heaviest first.
    assert.deepEqual(
      floorOf(state).map((q) => q.index),
      [2, 5, 0],
    );
    assert.deepEqual(
      floorOf(state, [0]).map((q) => q.index),
      [0, 2, 5],
      "a rule's question first",
    );
    // A newer card than the decision: the question is open again.
    s.card(3, 2, "moderate", 2);
    const again = researchState(s.ledger, RUN, { questions: QUESTIONS }, { lanes: 2 });
    assert.equal(again.questions[3]?.decided, false);
    assert.equal(again.questions[3]?.weight, 4);
  });

  test("a long round: the floor first, then by weight, never over the ceiling while another has gaps; gaps in turn", async (t) => {
    const s = await scene(t);
    const state = researchState(s.ledger, RUN, { questions: QUESTIONS }, { lanes: 2 });
    const plan = gapPlan(state, 120, { taken: () => [] });
    assert.equal(plan.length, 120);
    const order = plan.map((p) => p.question);
    // The floor: each question with open gaps (or no card) gets the round's first tasks.
    assert.deepEqual(order.slice(0, 3), [2, 5, 0]);
    assert.match(
      String(plan[0]?.why),
      /^the gap-driven plan: Question 3 \(index 2\) has no answer card yet, and no task in this round$/,
    );
    assert.match(
      String(plan[2]?.why),
      /Question 1 \(index 0\) has 3 open evidence gaps at certainty low, and no task in this round/,
    );
    // Never a decided or a saturated question.
    assert.ok(!order.includes(3) && !order.includes(4));
    // The ceiling: no question holds more than half of any 4 tasks in a row.
    for (let i = 0; i + 4 <= order.length; i++) {
      const w = order.slice(i, i + 4);
      for (const q of new Set(w))
        assert.ok(w.filter((x) => x === q).length <= 2, `tasks ${i}..${i + 3}: ${w.join(",")}`);
    }
    // Shares by weight: 9, 9, 6 and 1 of 25.
    const count = (q: number) => order.filter((x) => x === q).length;
    for (const [q, w] of [
      [2, 9],
      [5, 9],
      [0, 6],
      [1, 1],
    ] as const)
      assert.ok(Math.abs(count(q) - (120 * w) / 25) <= 1, `question ${q}: ${count(q)} tasks`);
    // Each task names a gap: a card's evidence gaps in turn, no card's own words, a card with none.
    const gaps = (q: number) => plan.filter((p) => p.question === q).map((p) => p.gap);
    assert.deepEqual(gaps(0).slice(0, 3).sort(), [
      "Q0 gap 1: a vendor document",
      "Q0 gap 2: a vendor document",
      "Q0 gap 3: a vendor document",
    ]);
    assert.deepEqual([...new Set(gaps(2))], [NO_CARD_GAP]);
    assert.deepEqual([...new Set(gaps(1))], [NO_GAP_NAMED]);
    assert.equal(new Set(gaps(5)).size, 6, "all six of the card's gaps get tasks");
  });

  test("a gap a waiting task names goes to the next task in turn; a task's details name its gap", async (t) => {
    const s = await scene(t);
    const state = researchState(s.ledger, RUN, { questions: QUESTIONS }, { lanes: 2 });
    const q0 = state.questions[0];
    assert.ok(q0);
    assert.equal(nextGap(q0, []), "Q0 gap 1: a vendor document");
    assert.equal(
      nextGap(q0, ["Q0 gap 1: a vendor document", "Q0 gap 2: a vendor document"]),
      "Q0 gap 3: a vendor document",
    );
    const plan = gapPlan(state, 1, {
      taken: (q) => (q === 2 ? [] : []),
      first: [0],
    });
    assert.deepEqual(
      plan.map((p) => [p.question, p.gap]),
      [[0, "Q0 gap 1: a vendor document"]],
    );
    assert.equal(
      gapOf("Evidence gap to close: Q0 gap 2: a vendor document\nQuestion 1 (index 0): Which?"),
      "Q0 gap 2: a vendor document",
    );
    assert.equal(gapOf("Question 1 (index 0): Which?"), undefined);
  });

  test("every open question saturated: those are weighed again; every question decided: all are", async (t) => {
    const s = await scene(t);
    // Saturate Q1, Q2, Q3 and Q6 too.
    for (const q of [0, 1, 2, 5])
      for (let i = 0; i < 4; i++)
        s.db
          .prepare(
            "insert into experiment (id, run, title, added_by, state, question, yield, created_at, updated_at) values (?, ?, 't', 'planner', 'done', ?, ?, ?, ?)",
          )
          .run(
            `x-${q}-${i}`,
            RUN,
            q,
            JSON.stringify({
              verified_claims: 0,
              by_question: [],
              new_domains: 0,
              domains: [],
              findings: 0,
              card_changes: 0,
            }),
            at(400 + i),
            at(401 + i),
          );
    const sat = researchState(s.ledger, RUN, { questions: QUESTIONS }, { lanes: 2 });
    assert.equal(sat.allSaturated, true);
    assert.deepEqual(
      sat.questions.map((q) => q.weight),
      [6, 1, 9, 0, 5, 9],
      "the saturated are weighed; the decided is not",
    );
    // Every question decided.
    const review = Number(
      (s.db.prepare("select id from review limit 1").get() as { id: number }).id,
    );
    for (const q of [0, 1, 2, 4, 5])
      s.db
        .prepare(
          "insert into item_decision (run, kind, key, review, card_version, decision, certainty, decided_at) values (?, 'question', ?, ?, ?, 'insufficient', null, ?)",
        )
        .run(RUN, String(q), review, q === 2 ? null : q === 0 ? 2 : 1, at(500));
    const done = researchState(s.ledger, RUN, { questions: QUESTIONS }, { lanes: 2 });
    assert.equal(done.allDecided, true);
    assert.ok(done.questions.every((q) => q.weight > 0));
  });
});
