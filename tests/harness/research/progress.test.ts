import assert from "node:assert/strict";
import { describe, type TestContext, test } from "node:test";
import { SATURATION_TASKS } from "../../../src/core/research-check.ts";
import type { Ledger } from "../../../src/harness/ledger/index.ts";
import {
  lastImprovement,
  progressStopped,
  questionSaturated,
  standingDecisions,
} from "../../../src/harness/research/progress.ts";
import { makeResearchRun } from "../../helpers/research-run.ts";

const RUN = "r-1";
const T0 = Date.parse("2026-10-24T00:00:00.000Z");
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();

async function scene(t: TestContext) {
  const r = await makeResearchRun(RUN);
  t.after(() => r.close());
  const ledger = r.env.service.ledger as Ledger;
  const review = Number(
    ledger.db
      .prepare(
        "insert into review (run, goal, commit_sha, package, requested_at) values (?, 'research', 'corpus:1', '{}', ?) returning id",
      )
      .get(RUN, at(0))?.id,
  );
  const card = (question: number, version: number, certainty: string, min: number) =>
    ledger.db
      .prepare(
        "insert into question_card (run, question, version, answer, certainty, by, created_at) values (?, ?, ?, 'A.', ?, 's', ?)",
      )
      .run(RUN, question, version, certainty, at(min));
  const decide = (
    kind: string,
    key: string,
    decision: string,
    certainty: string | null,
    version: number | null,
    min: number,
  ) =>
    ledger.db
      .prepare(
        "insert into item_decision (run, kind, key, review, card_version, decision, certainty, decided_at) values (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(RUN, kind, key, review, version, decision, certainty, at(min));
  let n = 0;
  const task = (question: number, newDomainClaims: number, min: number) =>
    ledger.db
      .prepare(
        "insert into experiment (id, run, title, added_by, state, question, yield, created_at, updated_at) values (?, ?, 't', 'planner', 'done', ?, ?, ?, ?)",
      )
      .run(
        `x-${++n}`,
        RUN,
        question,
        JSON.stringify({
          verified_claims: newDomainClaims,
          by_question: [
            { question, verified_claims: newDomainClaims, new_domain_claims: newDomainClaims },
          ],
          new_domains: newDomainClaims,
          domains: [],
          findings: 0,
          card_changes: 0,
        }),
        at(min),
        at(min + 1),
      );
  return { ledger, card, decide, task };
}

describe("a research run's progress (goal 117)", () => {
  test("a question's decision stands until its card has a newer version", async (t) => {
    const s = await scene(t);
    s.card(0, 1, "moderate", 10);
    s.decide("question", "0", "answered", "moderate", 1, 20);
    s.decide("hypothesis", "h-1", "supported", null, null, 20);
    assert.equal(standingDecisions(s.ledger, RUN).get("question:0")?.decision, "answered");
    s.card(0, 2, "high", 30);
    const now = standingDecisions(s.ledger, RUN);
    assert.equal(now.get("question:0"), undefined, "a newer card: to review again");
    assert.equal(now.get("hypothesis:h-1")?.decision, "supported");
  });

  test(`a question is saturated after ${SATURATION_TASKS} tasks that added nothing new and left its card's certainty where it was`, async (t) => {
    const s = await scene(t);
    s.card(1, 1, "low", 50);
    for (let k = 0; k < SATURATION_TASKS - 1; k++) s.task(1, 0, 100 + k * 10);
    assert.equal(questionSaturated(s.ledger, RUN, 1), false, "too few tasks");
    s.task(1, 0, 140);
    assert.equal(questionSaturated(s.ledger, RUN, 1), true);
    // Its card rewritten at the same certainty while they ran (each round's synthesis): still
    // saturated, or a run whose cards keep changing in words could never end.
    s.card(1, 2, "low", 120);
    s.card(1, 3, "low", 130);
    assert.equal(questionSaturated(s.ledger, RUN, 1), true);
    // A card whose certainty rose while they ran: not saturated.
    s.card(1, 4, "moderate", 135);
    assert.equal(questionSaturated(s.ledger, RUN, 1), false);
    // A question whose newest task found a new domain: not saturated.
    for (let k = 0; k < SATURATION_TASKS - 1; k++) s.task(0, 0, 100 + k * 10);
    s.task(0, 2, 140);
    assert.equal(questionSaturated(s.ledger, RUN, 0), false);
  });

  test("the last improvement is a better decision or a more certain card; a worse one is not", async (t) => {
    const s = await scene(t);
    assert.equal(lastImprovement(s.ledger, RUN), null);
    s.decide("question", "0", "open", null, 1, 10);
    assert.equal(lastImprovement(s.ledger, RUN), null, "open is no improvement");
    s.decide("question", "0", "answered", "low", 1, 20);
    s.card(1, 1, "low", 30);
    s.card(1, 2, "moderate", 40);
    s.decide("question", "0", "insufficient", null, 2, 50);
    assert.equal(lastImprovement(s.ledger, RUN), at(40));
  });

  test("the progress rule: open questions saturated and no improvement for a quarter of the running time", async (t) => {
    const s = await scene(t);
    const questions = 2;
    // Question 1 ended; question 2 open and saturated.
    s.card(0, 1, "high", 10);
    s.decide("question", "0", "answered", "high", 1, 60);
    for (let k = 0; k < SATURATION_TASKS; k++) s.task(1, 0, 100 + k * 10);
    // A clock of running time: 8 hours at most, as minutes since T0.
    const clockAt = (nowMin: number) => (when?: number) => ({
      elapsed_ms: (when ?? T0 + nowMin * 60_000) - T0,
      min_ms: 8 * 3_600_000,
    });
    // At 8 h, the last improvement at 1 h: 7 h without, more than a quarter of 8 h.
    const late = progressStopped(s.ledger, RUN, questions, clockAt(480));
    assert.deepEqual([late.stopped, late.open], [true, [1]]);
    // Before the minimum: never.
    assert.equal(progressStopped(s.ledger, RUN, questions, clockAt(300)).stopped, false);
    // An improvement 1 h ago, at 8 h: less than a quarter (2 h).
    s.decide("question", "1", "insufficient", null, null, 420);
    s.decide("question", "1", "open", null, null, 421);
    assert.equal(progressStopped(s.ledger, RUN, questions, clockAt(480)).stopped, false);
  });
});
