import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { CheckedReviewer } from "../../../../src/harness/research/review/index.ts";
import { Reviews } from "../../../../src/harness/reviews.ts";
import { goodReviewer } from "../../../helpers/research-paper.ts";
import { answered, type H, type Ids, open, RUN, reviewer, setup } from "./setup.ts";

/**
 * Code checks the review panel's answers: citations, drafts, numbers, certainty, gaps, next
 * experiments, verdicts and the number of reviewers; each item is decided by the majority.
 */

describe("code checks the review panel's answers (goal 117)", () => {
  test("a bad citation, a draft, a number not in the cited claims, a missing certainty, gaps or next experiments, a missing verdict and too few reviewers", async (t) => {
    const s = await setup(t);
    const ids = s.ids as Ids;
    s.ranFor(3);
    const id = s.ask();
    const good = goodReviewer("reviewer-1", ids);
    assert.throws(
      () => s.env.service.recordReviewPanel(id, [good], "supervisor"),
      /at least 2 reviewers/,
    );
    const bad = reviewer("reviewer-2", [
      // A number its claims do not have, and a claim that does not exist.
      answered(0, [ids.claims.verified, "c-nope"], "The first run archived 43 pages."),
      // A draft claim, and no certainty.
      { ...answered(1, [ids.claims.draft], "A clock keeps it honest."), certainty: null },
    ]);
    const thin = reviewer("reviewer-3", [
      {
        index: 0,
        verdict: "insufficient",
        certainty: null,
        answer: "42 pages.",
        claims: [ids.claims.verified],
        gaps: "",
        next_experiments: "",
      },
      open(1, " "),
    ]);
    assert.deepEqual(s.env.service.recordReviewPanel(id, [good, bad, thin], "supervisor"), {
      result: "review_passed",
      accepted: true,
    });
    const row = new Reviews(s.ledger).byId(id) as { panel: string };
    const panel = JSON.parse(row.panel) as CheckedReviewer[];
    assert.deepEqual(
      panel[0]?.questions.map((q) => q.valid),
      [true, true],
    );
    const r2 = panel[1] as CheckedReviewer;
    assert.deepEqual(r2.questions[0]?.problems, [
      "no claim c-nope",
      "the number 43 is not in the claims it cites",
    ]);
    assert.deepEqual(r2.questions[1]?.problems, [
      "an answered verdict needs its certainty: high, moderate or low",
      `claim ${ids.claims.draft} is a draft, not verified`,
    ]);
    assert.deepEqual(r2.hypotheses[0]?.problems, [
      "the reviewer gave no verdict on this hypothesis",
    ]);
    const r3 = panel[2] as CheckedReviewer;
    assert.deepEqual(r3.questions[0]?.problems, [
      "an insufficient verdict names what is missing, which only a measurement could settle, in next_experiments",
    ]);
    assert.deepEqual(r3.questions[1]?.problems, ["an open verdict names the evidence gaps"]);
    // Every reviewer's answer per item is kept, as checked.
    const items = s.ledger.db
      .prepare(
        "select reviewer, kind, key, verdict, problems from review_item where review = ? order by id",
      )
      .all(id) as {
      reviewer: string;
      kind: string;
      key: string;
      verdict: string;
      problems: string;
    }[];
    assert.equal(items.length, 9, "3 reviewers × (2 questions + 1 hypothesis)");
    assert.deepEqual(
      items.filter((x) => x.reviewer === "reviewer-2").map((x) => [x.kind, x.key, x.verdict]),
      [
        ["question", "0", "answered"],
        ["question", "1", "answered"],
        ["hypothesis", ids.hypothesis, "none"],
      ],
    );
    // A failed check does not count: reviewer-1's answers alone decide each item.
    const decided = s.ledger.db
      .prepare(
        "select key, decision, certainty, dissent from item_decision where review = ? order by id",
      )
      .all(id) as { key: string; decision: string; certainty: string | null; dissent: string }[];
    assert.deepEqual(
      decided.map((d) => [d.key, d.decision, d.certainty, JSON.parse(d.dissent)]),
      [
        ["0", "answered", "moderate", []],
        ["1", "answered", "high", []],
        [ids.hypothesis, "supported", null, []],
      ],
    );
  });

  test("a verdict needs its claims (supported or refuted) or its why (undecided); a tie of what passes is undecided", async (t) => {
    const s = await setup(t);
    const ids = s.ids as Ids;
    s.ranFor(3);
    const id = s.ask();
    const g = goodReviewer("reviewer-1", ids).research;
    const with_ = (name: string, h: H) => reviewer(name, g.questions, [h]);
    s.env.service.recordReviewPanel(
      id,
      [
        with_("reviewer-1", {
          id: ids.hypothesis,
          verdict: "supported",
          why: "It shows.",
          claims: [ids.claims.verified],
        }),
        with_("reviewer-2", { id: ids.hypothesis, verdict: "supported", why: "yes", claims: [] }),
        with_("reviewer-3", { id: ids.hypothesis, verdict: "undecided", why: " ", claims: [] }),
        with_("reviewer-4", {
          id: ids.hypothesis,
          verdict: "refuted",
          why: "No.",
          claims: [ids.claims.clock],
        }),
      ],
      "supervisor",
    );
    const panel = JSON.parse(
      String((new Reviews(s.ledger).byId(id) as { panel: string }).panel),
    ) as CheckedReviewer[];
    assert.deepEqual(panel[1]?.hypotheses[0]?.problems, ["a supported verdict cites no claim"]);
    assert.deepEqual(panel[2]?.hypotheses[0]?.problems, ["an undecided verdict needs its why"]);
    const d = s.ledger.latestEventBody("item_decided", RUN) as Record<string, unknown>;
    assert.deepEqual(
      [d.kind, d.key, d.decision],
      ["hypothesis", ids.hypothesis, "undecided"],
      "one supported and one refuted passed: a tie",
    );
    assert.deepEqual(
      (d.dissent as { reviewer: string; verdict: string }[]).map((x) => [x.reviewer, x.verdict]),
      [
        ["reviewer-1", "supported"],
        ["reviewer-4", "refuted"],
      ],
    );
  });
});
