import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { MEASURES_NOTHING } from "../../../../src/core/research-check.ts";
import { createHarnessApi } from "../../../../src/harness/api/index.ts";
import { researchPackage } from "../../../../src/harness/research/review/index.ts";
import { Reviews } from "../../../../src/harness/reviews.ts";
import { researchFixture } from "../../../helpers/fixtures.ts";
import { RESEARCH_QUESTIONS } from "../../../helpers/research-run.ts";
import { answered, type Ids, open, RUN, reviewer, setup } from "./setup.ts";

/**
 * The research review's package (researchPackage): each question's newest card with its claims and
 * rubric, the required hypotheses and the items to decide; shortened to fit; and only for a
 * supervisor that asks for research reviews.
 */

const tokens = { supervisor: "sup-token", proposer: "prop-token" };

describe("the research review's package (goal 117)", () => {
  test("each question's newest card with the claims it cites and its rubric, the required hypotheses, the items to decide; no lane or model", async (t) => {
    const s = await setup(t, {
      contract: { rubrics: ["How many pages, and when.", "What keeps it honest, and why."] },
    });
    const ids = s.ids as Ids;
    s.ranFor(3);
    const id = s.ask();
    const pkg = s.pending();
    assert.equal(pkg.id, id);
    assert.equal(pkg.kind, "research");
    assert.equal(pkg.topic, researchFixture.topic);
    assert.deepEqual(pkg.decide, { questions: [0, 1], hypotheses: [ids.hypothesis] });
    assert.deepEqual(
      pkg.questions.map((q) => [q.index, q.label, q.text, q.rubric, q.decide, q.card?.version]),
      [
        [0, "Question 1 (index 0)", RESEARCH_QUESTIONS[0], "How many pages, and when.", true, 1],
        [
          1,
          "Question 2 (index 1)",
          RESEARCH_QUESTIONS[1],
          "What keeps it honest, and why.",
          true,
          1,
        ],
      ],
    );
    assert.deepEqual(pkg.questions[0]?.claims, [
      {
        id: ids.claims.verified,
        text: "The first run archived 42 pages.",
        quotes: ["The harness archived 42 pages in its first run."],
        domains: ["127.0.0.1"],
        corroborated: false,
      },
    ]);
    assert.deepEqual(pkg.questions[1]?.card?.gaps, [
      { kind: "evidence", text: "a second, independent site" },
    ]);
    assert.deepEqual(
      pkg.hypotheses.map((h) => [h.id, h.text, h.status, h.decide]),
      [[ids.hypothesis, "Stateless workers make long runs safe.", "author", true]],
    );
    assert.ok(pkg.criteria.some((c) => c.includes(MEASURES_NOTHING)));
    assert.equal(pkg.corpus.verified_claims, 2);
    // Nothing about which lane, trial or model wrote what.
    const text = JSON.stringify(pkg);
    assert.ok(!/lane|trial|model/i.test(text), text);
  });

  test("a large package is shortened to fit: the items that stand lose their claims first, and it says so", async (t) => {
    const s = await setup(t);
    const ids = s.ids as Ids;
    const insert = s.ledger.db.prepare(
      "insert into claim (id, run, lane, question, text, quotes, verified, problems, created_at) values (?, ?, ?, ?, ?, ?, 1, '[]', ?)",
    );
    const quotes = JSON.stringify(
      Array.from({ length: 5 }, () => ({ source: ids.sources[0], quote: "q".repeat(1500) })),
    );
    const bulk = (q: number, k: number) =>
      Array.from({ length: 50 }, (_, i) => {
        const id = `c-bulk${q}x${k}x${String(i).padStart(3, "0")}`;
        insert.run(
          id,
          RUN,
          "lane-1",
          q,
          `Claim ${"w".repeat(3000)}`,
          quotes,
          new Date().toISOString(),
        );
        return id;
      });
    s.card(0, "The first run archived 42 pages.", [ids.claims.verified, ...bulk(0, 1)]);
    s.card(1, "A long campaign needs a clock.", [ids.claims.clock, ...bulk(1, 1)]);
    s.ranFor(3);
    const full = researchPackage(s.ledger, RUN, s.contract());
    assert.ok(JSON.stringify(full).length <= 200_000);
    assert.match(
      String(full.shortened),
      /^To keep this package short, the claims of the items whose decision stands are not shown, and each item to decide shows its first 26 cited claims, without quotes/,
    );
    const q0 = full.questions[0];
    assert.deepEqual(
      [q0?.claims.length, q0?.claims_not_shown],
      [26, 25],
      "every cited claim is counted",
    );
    assert.deepEqual([q0?.claims[0]?.quotes, q0?.claims[0]?.quotes_not_shown], [[], 1]);
    // Question 1 decided (it stands): its claims go before question 2's.
    const id = s.ask();
    s.env.service.recordReviewPanel(
      id,
      [
        reviewer("reviewer-1", [
          answered(0, [ids.claims.verified], "The first run archived 42 pages."),
          open(1, "a second site"),
        ]),
        reviewer("reviewer-2", [
          answered(0, [ids.claims.verified], "The first run archived 42 pages."),
          open(1, "a second site"),
        ]),
      ],
      "supervisor",
    );
    s.card(1, "A long campaign needs a clock.", [ids.claims.clock, ...bulk(1, 2)]);
    const next = researchPackage(s.ledger, RUN, s.contract());
    assert.ok(JSON.stringify(next).length <= 200_000);
    assert.deepEqual(next.decide.questions, [1]);
    assert.equal(next.questions[0]?.claims.length, 0, "the question that stands shows no claims");
    assert.equal(next.questions[0]?.claims_not_shown, 51);
    assert.equal(next.questions[1]?.claims.length, 51, "the question to decide keeps them all");
    assert.match(
      String(next.shortened),
      /the claims of the items whose decision stands are not shown, and the other claims are shown without their quotes\. When you have the tools/,
    );
  });

  test("a supervisor that does not ask for research reviews never gets one", async (t) => {
    const s = await setup(t);
    s.ranFor(3);
    s.ask();
    assert.deepEqual(new Reviews(s.ledger).pending(), [], "pending() alone: goal reviews only");
    const api = createHarnessApi(s.env.service, tokens);
    const get = async (path: string) =>
      (
        (await (
          await api.request(path, { headers: { authorization: `Bearer ${tokens.supervisor}` } })
        ).json()) as { reviews: { kind?: string }[] }
      ).reviews;
    assert.deepEqual(
      await get("/v1/reviews/pending"),
      [],
      "an older supervisor asks with no kinds",
    );
    assert.deepEqual(
      (await get("/v1/reviews/pending?kinds=goal,research")).map((r) => r.kind),
      ["research"],
    );
    assert.deepEqual(await get("/v1/reviews/pending?kinds=goal"), []);
  });
});
