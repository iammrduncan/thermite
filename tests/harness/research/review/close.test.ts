import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ANSWERED, briefGaps } from "../../../../src/harness/research/review/index.ts";
import { Reviews } from "../../../../src/harness/reviews.ts";
import { briefText } from "../../../helpers/brief-text.ts";
import { goodReviewer } from "../../../helpers/research-paper.ts";
import { RESEARCH_QUESTIONS } from "../../../helpers/research-run.ts";
import {
  answered,
  done,
  type Env,
  type Ids,
  open,
  type Q,
  RUN,
  reviewer,
  scheduler,
  setup,
} from "./setup.ts";

/**
 * A passed review closes the research run with its decisions, hands-off or after the owner's
 * acceptance, and open questions' evidence gaps reach the next workers' brief.
 */

const lastFinal = (s: { ledger: Env["env"]["service"]["ledger"] }) =>
  String(
    (
      s.ledger.db
        .prepare("select body from report_version where kind = 'final' order by id desc limit 1")
        .get() as { body: string } | undefined
    )?.body ?? "",
  );

const notes = (s: { ledger: Env["env"]["service"]["ledger"] }) =>
  s.ledger.db.prepare("select by, kind, text from journal_note order by id").all() as {
    by: string;
    kind: string;
    text: string;
  }[];

describe("a passed review closes the run with its decisions (goals 112 and 117)", () => {
  test("hands-off: running trials end first, then the final report holds the decisions, and the run closes", async (t) => {
    const s = await setup(t);
    const ids = s.ids as Ids;
    // Trials that run until they are let go, on two lanes; one of them ends at once, so a lane
    // is free when the review is accepted.
    const releases: (() => void)[] = [];
    let started = 0;
    const held = () =>
      new Promise<typeof done>((resolve) => {
        started++;
        if (started === 1) resolve(done);
        else releases.push(() => resolve(done));
      });
    const sch = scheduler(s, held, 2);
    await sch.tick();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(started, 2, "two trials started; one of them still runs");
    const release = () => {
      for (const r of releases.splice(0)) r();
    };
    s.ranFor(3);
    const id = s.ask();
    assert.deepEqual(
      s.env.service.recordReviewPanel(
        id,
        [goodReviewer("reviewer-1", ids), goodReviewer("reviewer-2", ids)],
        "supervisor",
      ),
      { result: "review_passed", accepted: true },
    );
    // Hands-off, said in its event and in the journal, with the decisions.
    const decided = s.ledger.latestEventBody("review_decided", RUN) as Record<string, unknown>;
    assert.equal(decided.decision, "accepted");
    assert.equal(
      decided.note,
      "hands-off: the review panel passed it, and the run does not ask the owner",
    );
    assert.ok(
      notes(s).some(
        (n) =>
          n.by === "harness" &&
          n.text ===
            `Review ${id} decided 3 items by the majority of 2 reviewers: Question 1 answered, certainty moderate (2 of 2); Question 2 answered, certainty high (2 of 2); Hypothesis ${ids.hypothesis} supported (2 of 2).`,
      ),
      JSON.stringify(notes(s)),
    );
    const panelEvent = s.ledger.latestEventBody("review_panel", RUN) as Record<string, unknown>;
    assert.deepEqual(
      [panelEvent.result, panelEvent.decided, panelEvent.open],
      ["review_passed", 3, []],
    );
    // Its running trial ends first: no new trial starts on the free lane, and the run stays open.
    await sch.tick();
    assert.equal(started, 2, "no new trial");
    assert.equal(s.env.service.ledger.runs.get(RUN)?.status, "running");
    release();
    await sch.idle();
    // Until the supervisor says whether it has a final writer, the run waits (goal 112).
    await sch.tick();
    assert.equal(
      s.env.service.ledger.runs.get(RUN)?.status,
      "running",
      "it waits for the supervisor",
    );
    // A rig with no final writer: the run closes with the decisions, and says why it has no paper.
    await s.env.service.setAdvisors({ auditor: false, review_panel: 2 }, "supervisor");
    await sch.tick();
    const run = s.env.service.ledger.runs.get(RUN);
    assert.deepEqual([run?.status, run?.pause_reason], ["closed", ANSWERED]);
    const final = lastFinal(s);
    assert.match(final, /Research paper: none, no final writer on this rig\./);
    assert.match(
      final,
      new RegExp(
        `## The review panel's decisions\\nThe review panel's decisions give every question an end and every required hypothesis a verdict \\(review ${id}\\)\\. Each decision`,
      ),
    );
    assert.match(
      final,
      new RegExp(
        `### 1\\. ${RESEARCH_QUESTIONS[0]?.replace(/\?/g, "\\?")}\\n\\nDecision: answered, certainty moderate \\(review ${id}, card version 1; 2 of 2 reviewers\\)\\.\\n\\nThe first run archived 42 pages\\.\\n\\nCites: ${ids.claims.verified}\\.`,
      ),
    );
    assert.match(
      final,
      new RegExp(
        `## Hypotheses: the review panel's verdicts\\n- Stateless workers make long runs safe\\. \\(${ids.hypothesis}\\): supported \\(review ${id}; 2 of 2 reviewers\\)\\.`,
      ),
    );
    // Once.
    await sch.tick();
    assert.equal(
      Number(
        (
          s.ledger.db
            .prepare("select count(*) as n from event where kind = 'research_final'")
            .get() as { n: number }
        ).n,
      ),
      1,
    );
  });

  test("a run that asks the owner about reviews waits for accept_review; a rejection goes on until a card changes", async (t) => {
    const s = await setup(t, { assign: { ask_owner: { reviews: true } } });
    const ids = s.ids as Ids;
    const sch = scheduler(s);
    s.ranFor(3);
    const pass = [goodReviewer("reviewer-1", ids), goodReviewer("reviewer-2", ids)];
    const first = s.ask();
    assert.deepEqual(s.env.service.recordReviewPanel(first, pass, "supervisor"), {
      result: "review_passed",
    });
    assert.equal(new Reviews(s.ledger).byId(first)?.owner_decision, null);
    await sch.tick();
    await sch.idle();
    assert.equal(s.env.service.ledger.runs.get(RUN)?.status, "running", "it waits for the owner");
    const no = await s.env.service.applyCommand(
      s.env.sign("accept_review", {
        run: RUN,
        review: first,
        accept: false,
        note: "question 2 needs a primary source",
      }),
    );
    assert.ok(no.status === "applied" && no.accepted, JSON.stringify(no));
    await sch.tick();
    await sch.idle();
    assert.equal(s.env.service.ledger.runs.get(RUN)?.status, "running", "a rejection goes on");
    assert.ok(
      notes(s).some(
        (n) =>
          n.by === "owner" &&
          n.text.includes(`did not accept review ${first}`) &&
          n.text.includes("question 2 needs a primary source"),
      ),
    );
    assert.equal(s.due().due, false, "not asked again while its items' decisions stand");
    // A new card for question 2: asked again about it; the owner accepts, and the run closes.
    s.card(1, "A long campaign needs a clock the workers cannot stop.", [ids.claims.clock], "high");
    const second = s.ask();
    assert.deepEqual(s.pending().decide, { questions: [1], hypotheses: [] });
    s.env.service.recordReviewPanel(second, pass, "supervisor");
    const yes = await s.env.service.applyCommand(
      s.env.sign("accept_review", { run: RUN, review: second, accept: true }),
    );
    assert.ok(yes.status === "applied" && yes.accepted, JSON.stringify(yes));
    // This rig's supervisor has no final writer (goal 112).
    await s.env.service.setAdvisors({ auditor: false, review_panel: 2 }, "supervisor");
    await sch.tick();
    await sch.idle();
    await sch.tick();
    const run = s.env.service.ledger.runs.get(RUN);
    assert.deepEqual([run?.status, run?.pause_reason], ["closed", ANSWERED]);
    assert.match(
      lastFinal(s),
      new RegExp(`verdict \\(review ${second}\\), and the owner accepted them\\.`),
    );
  });

  test("open questions' evidence gaps reach the next workers' brief; measurements and failed answers stay out", async (t) => {
    const s = await setup(t);
    const ids = s.ids as Ids;
    const briefs: string[] = [];
    const sch = scheduler(s, async (spec) => {
      briefs.push(briefText(spec.brief));
      return done;
    });
    s.ranFor(3);
    const id = s.ask();
    const g = goodReviewer("reviewer-1", ids).research;
    s.env.service.recordReviewPanel(
      id,
      [
        reviewer(
          "reviewer-1",
          [
            g.questions[0] as Q,
            open(1, "a second, independent site on what keeps campaigns honest"),
          ],
          g.hypotheses,
        ),
        reviewer(
          "reviewer-2",
          [g.questions[0] as Q, open(1, "Benchmark the clock on the target box")],
          g.hypotheses,
        ),
        // An answer that fails code's check: the reviewer's problem, not the workers'.
        reviewer(
          "reviewer-3",
          [g.questions[0] as Q, answered(1, ["c-nope"], "It is 43.")],
          g.hypotheses,
        ),
      ],
      "supervisor",
    );
    const gaps = briefGaps(s.ledger, RUN) ?? "";
    assert.match(gaps, new RegExp(`^# What the review panel found missing \\(review ${id}\\)`));
    assert.match(
      gaps,
      new RegExp(
        `- Question 2 \\(index 1\\) \\(review ${id}\\): a second, independent site on what keeps campaigns honest`,
      ),
    );
    assert.doesNotMatch(gaps, /Benchmark|Question 1 \(index 0\)|c-nope|43/);
    assert.match(
      gaps,
      /\(One more gap asks for a measurement: a next experiment for the report, not work for this run\.\)/,
    );
    // Each reviewer that found an item open or failed the check has a note in the journal.
    assert.deepEqual(
      notes(s)
        .filter((n) => n.by.startsWith("review_panel:"))
        .map((n) => n.by),
      ["review_panel:reviewer-1", "review_panel:reviewer-2", "review_panel:reviewer-3"],
    );
    assert.match(
      notes(s).find((n) => n.by === "review_panel:reviewer-3")?.text ?? "",
      /Question 2: the answered verdict did not pass the check \(no claim c-nope; the number 43 is not in the claims it cites\)/,
    );
    await sch.tick();
    await sch.idle();
    assert.match(briefs.at(-1) ?? "", /# What the review panel found missing/);
    // A new card for question 2: its open decision no longer stands, and the gap leaves the brief.
    s.card(1, "A long campaign needs a clock the workers cannot stop.", [ids.claims.clock]);
    assert.equal(briefGaps(s.ledger, RUN), undefined);
    // The owner closes the run before it ends: its final report says so.
    s.research.report(RUN, "final");
    assert.match(
      lastFinal(s),
      /## The review panel's decisions\nThe run ended before the review panel's decisions gave every question an end: question 2 stayed open\./,
    );
    assert.match(
      lastFinal(s),
      /### 2\. .*\n\nNo decision stands: the review panel did not decide it on its newest card\./,
    );
  });
});
