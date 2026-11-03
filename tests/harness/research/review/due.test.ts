import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseContract } from "../../../../src/core/contract.ts";
import { researchFixture } from "../../../helpers/fixtures.ts";
import { goodReviewer } from "../../../helpers/research-paper.ts";
import { writeCards } from "../../../helpers/research-run.ts";
import { type Env, type Ids, open, type Q, RUN, reviewer, scheduler, setup } from "./setup.ts";

/**
 * When code asks the review panel about a research run's items (researchReviewDue): only after the
 * minimum running time, at a digest, once every question has an answer card, never again on items
 * that did not change, and not while a review waits.
 */

const lastDigest = (s: { ledger: Env["env"]["service"]["ledger"] }) =>
  String(
    (
      s.ledger.db
        .prepare("select body from report_version where kind = 'digest' order by id desc limit 1")
        .get() as { body: string } | undefined
    )?.body ?? "",
  );

describe("when the review panel is asked about a research run's items (goals 112 and 117)", () => {
  test("only after the minimum, at a digest, once every question has an answer card; never again on items that did not change", async (t) => {
    const s = await setup(t, { cards: false });
    const ids = s.ids as Ids;
    const sch = scheduler(s);
    // Before the minimum (2h): a digest asks nothing, and says when the check starts.
    s.digestDue();
    await sch.tick();
    await sch.idle();
    assert.equal(s.reviews().length, 0, "no review before the minimum");
    assert.match(lastDigest(s), /Answer check: it starts after the minimum running time/);
    // After it, but no answer card yet: none.
    s.ranFor(3);
    s.digestDue();
    await sch.tick();
    await sch.idle();
    assert.equal(s.reviews().length, 0);
    const bare = s.due();
    assert.equal("why" in bare ? bare.why : "", "questions 1, 2 have no answer card yet");
    // Both cards: the next digest asks once, about every item.
    writeCards(s, ids);
    s.digestDue();
    await sch.tick();
    await sch.idle();
    assert.equal(s.reviews().length, 1, "one review at the digest after the cards");
    assert.match(lastDigest(s), /Answer check: the review panel checks review \d+\./);
    const first = Number(s.reviews()[0]?.id);
    assert.deepEqual(s.pending().decide, { questions: [0, 1], hypotheses: [ids.hypothesis] });
    assert.match(String(s.reviews()[0]?.commit_sha), /^items:0v1\.1v1:h1-[0-9a-f]{12}$/);
    // The next digest, the review still waiting: none more.
    s.digestDue();
    await sch.tick();
    await sch.idle();
    assert.equal(s.reviews().length, 1, "none while one waits");
    // Question 1 answered, question 2 open, the hypothesis supported: decisions that stand.
    const good = goodReviewer("reviewer-1", ids).research;
    const r = (name: string) =>
      reviewer(
        name,
        [
          good.questions[0] as Q,
          open(1, "a second, independent site on what keeps campaigns honest"),
        ],
        good.hypotheses,
      );
    assert.deepEqual(
      s.env.service.recordReviewPanel(first, [r("reviewer-1"), r("reviewer-2")], "supervisor"),
      { result: "review_failed" },
    );
    // Nothing changed: no review is asked, at this digest or the next.
    for (let k = 0; k < 2; k++) {
      s.digestDue();
      await sch.tick();
      await sch.idle();
    }
    assert.equal(s.reviews().length, 1, "no item changed: no review");
    const again = s.due();
    assert.equal(
      "why" in again ? again.why : "",
      "every item has a decision that stands: a question is reviewed again when its answer card changes",
    );
    assert.match(
      lastDigest(s),
      /Answer check: not yet\. 1 of 2 questions have an end, and 1 of 1 required hypotheses a verdict; open: Question 2 \(index 1\) \(open in review \d+\); every item has a decision that stands/,
    );
    // A new card for question 2: the next digest asks about it alone, question 1 standing.
    const b = (await s.research.fetch(RUN, "lane-1", `${s.base}/b.html`)) as { source: string };
    const more = s.research.addClaim(RUN, "lane-1", {
      text: "Long research campaigns need a clock.",
      quotes: [
        {
          source: b.source,
          quote: "Long research campaigns need a clock the workers cannot stop.",
        },
      ],
      question: 1,
    });
    assert.equal(s.card(1, "A long campaign needs a clock.", [ids.claims.clock, more.claim]), 2);
    s.digestDue();
    await sch.tick();
    await sch.idle();
    assert.equal(s.reviews().length, 2, "a new card: a new review");
    assert.notEqual(s.reviews()[0]?.commit_sha, s.reviews()[1]?.commit_sha);
    const pkg = s.pending();
    assert.deepEqual(pkg.decide, { questions: [1], hypotheses: [] });
    assert.equal(pkg.questions[0]?.decide, false);
    assert.equal(pkg.questions[0]?.standing?.decision, "answered");
    assert.equal(pkg.questions[1]?.card?.version, 2);
    assert.equal(pkg.hypotheses[0]?.standing?.decision, "supported");
  });

  test("a campaign's floor of verified claims holds the check", async (t) => {
    const s = await setup(t, { contract: { min_verified_claims: 3 } });
    const ids = s.ids as Ids;
    s.ranFor(3);
    let d = s.due();
    assert.equal(d.due, false);
    assert.match(
      "why" in d ? d.why : "",
      /the run has 2 verified claims of the 3 the campaign asks for/,
    );
    const a = (await s.research.fetch(RUN, "lane-1", `${s.base}/a.html`)) as { source: string };
    s.research.addClaim(RUN, "lane-1", {
      text: "Stateless workers lose nothing when they crash.",
      quotes: [{ source: a.source, quote: "Stateless workers lose nothing when they crash." }],
      question: 1,
    });
    d = s.due();
    assert.equal(d.due, true, JSON.stringify(d));
    assert.ok(ids);
  });

  test("while a review waits for the review panel or for the owner, a new card asks nothing more", async (t) => {
    const s = await setup(t, { assign: { ask_owner: { reviews: true } } });
    const ids = s.ids as Ids;
    s.ranFor(3);
    const first = s.ask();
    s.card(0, "The first run archived 42 pages, as its archive shows.", [ids.claims.verified]);
    let d = s.due();
    assert.equal("why" in d ? d.why : "", `review ${first} waits`);
    // Passed, and waiting for the owner's acceptance: still none.
    assert.deepEqual(
      s.env.service.recordReviewPanel(
        first,
        [goodReviewer("reviewer-1", ids), goodReviewer("reviewer-2", ids)],
        "supervisor",
      ),
      { result: "review_failed" },
      "question 1's card changed while the panel reviewed it: its decision does not stand",
    );
    d = s.due();
    assert.equal(d.due, true, "question 1's newer card is to decide");
    const second = s.ask();
    assert.deepEqual(s.pending().decide, { questions: [0], hypotheses: [] });
    assert.deepEqual(
      s.env.service.recordReviewPanel(
        second,
        [goodReviewer("reviewer-1", ids), goodReviewer("reviewer-2", ids)],
        "supervisor",
      ),
      { result: "review_passed" },
    );
    s.card(1, "A long campaign needs a clock the workers cannot stop.", [ids.claims.clock], "high");
    d = s.due();
    assert.equal("why" in d ? d.why : "", `review ${second} waits`);
  });

  test("min_verified_claims is a whole number from 1, and a contract without it keeps its hash", () => {
    const base = { ...researchFixture };
    const without = parseContract(base);
    assert.ok(without.ok);
    assert.equal("min_verified_claims" in without.contract, false, "no default");
    const withIt = parseContract({ ...base, min_verified_claims: 5 });
    assert.ok(withIt.ok);
    assert.notEqual(withIt.sha, without.sha);
    assert.equal(parseContract({ ...base, min_verified_claims: 0 }).ok, false);
    assert.equal(parseContract({ ...base, min_verified_claims: 2.5 }).ok, false);
  });
});
