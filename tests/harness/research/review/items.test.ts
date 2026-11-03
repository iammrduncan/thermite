import assert from "node:assert/strict";
import { describe, type TestContext, test } from "node:test";
import {
  PROGRESS_STOPPED,
  RESEARCH_REVIEW,
  SATURATION_TASKS,
} from "../../../../src/core/research-check.ts";
import type { ResearchTrialSpec } from "../../../../src/harness/agents/research/worker.ts";
import { Scheduler } from "../../../../src/harness/agents/scheduler/index.ts";
import { LocalRunner } from "../../../../src/harness/broker/runner.ts";
import type { Ledger } from "../../../../src/harness/ledger/index.ts";
import type { PaperPackage } from "../../../../src/harness/research/paper/index.ts";
import { standingDecisions } from "../../../../src/harness/research/progress.ts";
import type { Research } from "../../../../src/harness/research/research/index.ts";
import {
  ANSWERED,
  briefGaps,
  RESEARCH_PACKAGE_MAX,
  type ResearchPackage,
  type ResearchVerdicts,
  researchPackage,
  researchReviewDue,
} from "../../../../src/harness/research/review/index.ts";
import { Reviews } from "../../../../src/harness/reviews.ts";
import { makeResearchRun } from "../../../helpers/research-run.ts";

/**
 * Goal 117's item reviews at the scale of a long run: six questions with their answer cards,
 * three hundred verified claims from twenty sites, two dozen required hypotheses (the author's
 * and promoted ones) beside a pool of a hundred, five reviewers, and successive reviews. Each
 * item's decision is the majority of the answers that pass code's check, with the dissent kept;
 * a decision stands until its question's card changes; a review passes once every question has an
 * end and every required hypothesis a verdict. And the progress rule: a run whose open questions
 * are saturated, with no improvement for a quarter of its running time, ends with its open items
 * stated and its paper.
 */

const RUN = "r-1";
const QUESTIONS = Array.from(
  { length: 6 },
  (_, i) => `How does kernel family ${"ABCDEF"[i]} use the memory hierarchy?`,
);
const REVIEWERS = ["reviewer-1", "reviewer-2", "reviewer-3", "reviewer-4", "reviewer-5"];
const CLAIMS_PER_QUESTION = 50;

type Q = ResearchVerdicts["questions"][number];
type H = ResearchVerdicts["hypotheses"][number];

const done = {
  stopped: "no_submission" as const,
  turns: 0,
  toolCalls: 0,
  tokensIn: 0,
  tokensOut: 0,
};

const claimId = (q: number, i: number) => `c-q${q}n${String(i).padStart(4, "0")}`;

/** A research run with six questions, three hundred verified claims and a card for each question. */
async function longRun(
  t: TestContext,
  contract: Record<string, unknown> = {},
  o: { cards?: boolean } = {},
) {
  const r = await makeResearchRun(RUN, {
    contract: {
      questions: QUESTIONS,
      min_duration: "8h",
      max_duration: "48h",
      hypotheses: Array.from({ length: 12 }, (_, i) => `Family ${i} streams weights from memory.`),
      ...contract,
    },
  });
  t.after(() => r.close());
  const ledger = r.env.service.ledger as Ledger;
  const now = new Date().toISOString();
  const source = ledger.db.prepare(
    "insert into source (id, run, url, final_url, domain, fetched_at, http_status, bytes, sha256, raw_path, text_path, fetched_by) values (?, ?, ?, ?, ?, ?, 200, 10, 'x', '/dev/null', '/dev/null', 'lane-1')",
  );
  for (let k = 0; k < 40; k++) {
    const host = `docs.site${k % 20}.example`;
    source.run(`s-${k}`, RUN, `https://${host}/p${k}`, `https://${host}/p${k}`, host, now);
  }
  const claim = ledger.db.prepare(
    "insert into claim (id, run, lane, question, text, quotes, verified, problems, created_at) values (?, ?, 'lane-1', ?, ?, ?, 1, '[]', ?)",
  );
  const n = (contract.questions as string[] | undefined)?.length ?? QUESTIONS.length;
  for (let q = 0; q < n; q++)
    for (let i = 0; i < CLAIMS_PER_QUESTION; i++)
      claim.run(
        claimId(q, i),
        RUN,
        q,
        `Kernel family ${"ABCDEF"[q]} variant ${i} moves ${100 + i} MB per step through shared memory.`,
        JSON.stringify([
          { source: `s-${(q * 7 + i) % 40}`, quote: `variant ${i} moves ${100 + i} MB per step` },
          { source: `s-${(q * 7 + i + 13) % 40}`, quote: `moves ${100 + i} MB per step` },
        ]),
        now,
      );
  // Twelve promoted hypotheses beside the author's twelve, and a pool of a hundred.
  const hyp = ledger.db.prepare(
    "insert into hypothesis (id, run, lane, text, supporting, status, question, created_at, updated_at) values (?, ?, 'lane-1', ?, ?, ?, ?, ?, ?)",
  );
  for (let i = 0; i < 112; i++)
    hyp.run(
      `h-pool${String(i).padStart(6, "0")}`,
      RUN,
      `Variant ${i} of a family is bound by bandwidth.`,
      JSON.stringify([claimId(i % n, i % CLAIMS_PER_QUESTION)]),
      i < 12 ? "promoted" : "pool",
      i % n,
      now,
      now,
    );
  const card = (question: number, from: number, certainty = "moderate") => {
    const out = r.env.service.submitCards(
      RUN,
      {
        synthesizer: "synthesizer",
        cards: [
          {
            question,
            answer: `Family ${"ABCDEF"[question]} moves its weights through shared memory, as its variants show.`,
            certainty,
            claims: Array.from({ length: 40 }, (_, i) => claimId(question, from + i)),
            borrowed: [],
            gaps: [{ kind: "evidence", text: "a vendor guide on the cache policy" }],
            through: null,
          },
        ],
      },
      "supervisor",
    ).results[0];
    assert.ok(out?.accepted, JSON.stringify(out));
    return out.version;
  };
  if (o.cards !== false) for (let q = 0; q < n; q++) card(q, 0);
  ledger.db
    .prepare("update run set created_at = ? where id = ?")
    .run(new Date(Date.now() - 10 * 3_600_000).toISOString(), RUN);
  const contractNow = () => r.env.service.contractFor(RUN) as Parameters<typeof researchPackage>[2];
  const due = () => researchReviewDue(ledger, RUN, contractNow(), r.research.clock(RUN));
  const ask = () => {
    const d = due();
    assert.ok(d.due, `not due: ${"why" in d ? d.why : ""}`);
    const pkg = researchPackage(ledger, RUN, contractNow());
    assert.ok(JSON.stringify(pkg).length <= RESEARCH_PACKAGE_MAX);
    const id = new Reviews(ledger).requestResearch({ run: RUN, marker: d.marker, pkg, by: "s" });
    return { id, pkg: new Reviews(ledger).pending(["research"]).at(-1) as ResearchPackage };
  };
  const events = (kind: string) =>
    ledger.db
      .prepare("select body from event where kind = ? and subject = ? order by id")
      .all(kind, RUN)
      .map((e) => JSON.parse(String((e as { body: string }).body)) as Record<string, unknown>);
  return { ...r, ledger, card, due, ask, events, contractNow };
}

const answered = (index: number, certainty: "high" | "moderate" | "low", from = 0): Q => ({
  index,
  verdict: "answered",
  certainty,
  answer: `Family ${"ABCDEF"[index]} moves its weights through shared memory.`,
  claims: [claimId(index, from), claimId(index, from + 1)],
  gaps: "",
  next_experiments: "",
});
const open = (index: number, gaps = "a vendor guide on the cache policy"): Q => ({
  index,
  verdict: "open",
  certainty: null,
  answer: "",
  claims: [],
  gaps,
  next_experiments: "",
});
const insufficient = (index: number): Q => ({
  index,
  verdict: "insufficient",
  certainty: null,
  answer: `Family ${"ABCDEF"[index]} moves its weights through shared memory.`,
  claims: [claimId(index, 0)],
  gaps: "",
  next_experiments: "Time each variant on the target card.",
});
/** An answer that fails code's check: it cites a claim the run does not have. */
const failing = (index: number): Q => ({ ...answered(index, "high"), claims: ["c-nothere01"] });
const verdict = (id: string, v: "supported" | "refuted" | "undecided", from = 0): H => ({
  id,
  verdict: v,
  why: "The claims show it.",
  claims: v === "undecided" ? [] : [claimId(0, from)],
});

describe("item reviews at the scale of a long run (goal 117)", () => {
  test("successive reviews: majorities with dissent, a tie, failed checks, decisions that stand, a new card reopening a question, and the pass", async (t) => {
    const s = await longRun(t);
    const hyps = s.ledger.db
      .prepare(
        "select id from hypothesis where run = ? and status in ('author', 'promoted') order by created_at, rowid",
      )
      .all(RUN)
      .map((h) => String((h as { id: string }).id));
    assert.equal(hyps.length, 24, "the author's twelve and twelve promoted; the pool is left out");

    // Review 1: every item to decide.
    const r1 = s.ask();
    assert.deepEqual(r1.pkg.decide.questions, [0, 1, 2, 3, 4, 5]);
    assert.deepEqual(r1.pkg.decide.hypotheses, hyps);
    assert.equal(r1.pkg.hypotheses.length, 24);
    assert.equal(r1.pkg.questions[0]?.claims.length, 40);
    assert.equal(r1.pkg.corpus.verified_claims, 300);
    assert.equal(
      r1.pkg.corpus.domains,
      20,
      "registrable domains: docs.site0.example is site0.example",
    );
    // Per reviewer, in REVIEWERS order: each question's answer, and the hypotheses' verdicts.
    const q: Q[][] = [
      [
        answered(0, "high"),
        answered(0, "high"),
        answered(0, "moderate"),
        answered(0, "low"),
        answered(0, "high"),
      ],
      [
        answered(1, "moderate"),
        answered(1, "moderate"),
        answered(1, "low"),
        open(1),
        open(1, "a primary source on the prefetcher"),
      ],
      [
        answered(2, "high"),
        answered(2, "low"),
        open(2),
        open(2, "an errata sheet"),
        insufficient(2),
      ],
      [insufficient(3), insufficient(3), insufficient(3), failing(3), open(3)],
      [failing(4), failing(4), failing(4), failing(4), failing(4)],
      [open(5), open(5), open(5), open(5), answered(5, "high")],
    ];
    const h = (k: number): H[] =>
      hyps.flatMap((id, i) => {
        if (i < 20) return [verdict(id, "supported")];
        if (i < 22) return [verdict(id, k < 3 ? "refuted" : "supported")];
        if (i === 22) return [verdict(id, k < 2 ? "supported" : k < 4 ? "refuted" : "undecided")];
        return []; // hypothesis 23: no reviewer answers it
      });
    const results1 = REVIEWERS.map((name, k) => ({
      reviewer: name,
      pass: false,
      reasons: "Checked.",
      research: { questions: q.map((x) => x[k] as Q), hypotheses: h(k) },
    }));
    assert.deepEqual(s.env.service.recordReviewPanel(r1.id, results1, "supervisor"), {
      result: "review_failed",
    });
    assert.equal(
      Number(
        (
          s.ledger.db
            .prepare("select count(*) as n from review_item where review = ?")
            .get(r1.id) as {
            n: number;
          }
        ).n,
      ),
      5 * 30,
      "every reviewer's answer to every item",
    );
    const decided = s.events("item_decided");
    assert.equal(decided.length, 30);
    const byKey = new Map(decided.map((d) => [`${String(d.kind)}:${String(d.key)}`, d]));
    const shape = (k: string) => {
      const d = byKey.get(k) as Record<string, unknown>;
      return [
        d.decision,
        d.certainty,
        (d.dissent as { reviewer: string; verdict: string }[]).map(
          (x) => `${x.reviewer}:${x.verdict}`,
        ),
      ];
    };
    assert.deepEqual(shape("question:0"), ["answered", "high", []], "the median of five");
    assert.deepEqual(shape("question:1"), [
      "answered",
      "moderate",
      ["reviewer-4:open", "reviewer-5:open"],
    ]);
    assert.deepEqual(
      shape("question:2"),
      ["open", null, ["reviewer-1:answered", "reviewer-2:answered", "reviewer-5:insufficient"]],
      "a tie of two and two is open",
    );
    assert.deepEqual(
      shape("question:3"),
      ["insufficient", null, ["reviewer-5:open"]],
      "the failed check does not count",
    );
    assert.deepEqual(shape("question:4"), ["open", null, []], "no answer passed the check");
    assert.deepEqual(shape("question:5"), ["open", null, ["reviewer-5:answered"]]);
    assert.deepEqual(shape(`hypothesis:${hyps[0]}`), ["supported", null, []]);
    assert.deepEqual(shape(`hypothesis:${hyps[20]}`), [
      "refuted",
      null,
      ["reviewer-4:supported", "reviewer-5:supported"],
    ]);
    assert.equal(
      (byKey.get(`hypothesis:${hyps[22]}`) as { decision: string }).decision,
      "undecided",
      "a tie",
    );
    assert.equal(
      (byKey.get(`hypothesis:${hyps[23]}`) as { decision: string }).decision,
      "undecided",
      "no verdict",
    );
    // Every dissent's reasons are short.
    for (const d of decided)
      for (const x of d.dissent as { reasons: string }[]) assert.ok(x.reasons.length <= 300);
    // The events the Reviews tab reads.
    const items = s.events("review_items");
    assert.deepEqual(
      items.map((e) => e.reviewer),
      REVIEWERS,
    );
    const first = items[0] as { review: number; items: Record<string, unknown>[] };
    assert.equal(first.review, r1.id);
    assert.deepEqual(Object.keys(first.items[0] ?? {}).sort(), [
      "card_version",
      "certainty",
      "claims",
      "key",
      "kind",
      "problems",
      "reasons",
      "verdict",
    ]);
    assert.deepEqual(
      [
        first.items[0]?.kind,
        first.items[0]?.key,
        first.items[0]?.card_version,
        first.items[0]?.verdict,
      ],
      ["question", "0", 1, "answered"],
    );
    const fourth = (items[3] as { items: Record<string, unknown>[] }).items;
    assert.deepEqual(fourth.find((x) => x.key === "3")?.problems, ["no claim c-nothere01"]);
    assert.equal(fourth.find((x) => x.key === hyps[23])?.verdict, "none");
    const panel = s.events("review_panel").at(-1) as Record<string, unknown>;
    assert.deepEqual([panel.result, panel.decided, panel.open], ["review_failed", 30, [2, 4, 5]]);
    assert.deepEqual(
      (panel.questions as { question: number; answered_by: number; decision: string }[]).map(
        (x) => [x.question, x.answered_by, x.decision],
      ),
      [
        [0, 5, "answered"],
        [1, 3, "answered"],
        [2, 3, "open"],
        [3, 3, "insufficient"],
        [4, 0, "open"],
        [5, 1, "open"],
      ],
    );
    // The workers' brief: the open questions' evidence gaps, from the reviewers who said open.
    const gaps = briefGaps(s.ledger, RUN) ?? "";
    assert.match(
      gaps,
      /- Question 3 \(index 2\) \(review \d+\): a vendor guide on the cache policy \/ an errata sheet/,
    );
    assert.match(
      gaps,
      /- Question 6 \(index 5\) \(review \d+\): a vendor guide on the cache policy/,
    );
    assert.doesNotMatch(gaps, /Question 5 \(index 4\)|Question 2 \(index 1\)/);

    // Nothing changed: no review.
    const still = s.due();
    assert.equal(still.due, false);
    assert.match("why" in still ? still.why : "", /every item has a decision that stands/);

    // New cards for questions 3 and 5: review 2 decides them alone.
    s.card(2, 10);
    s.card(4, 10);
    const r2 = s.ask();
    assert.deepEqual(r2.pkg.decide, { questions: [2, 4], hypotheses: [] });
    assert.deepEqual(
      r2.pkg.questions.filter((x) => x.decide).map((x) => [x.index, x.card?.version]),
      [
        [2, 2],
        [4, 2],
      ],
    );
    assert.equal(r2.pkg.questions[1]?.standing?.decision, "answered");
    const results2 = REVIEWERS.map((name, k) => ({
      reviewer: name,
      pass: true,
      reasons: "Checked.",
      research: {
        questions: [
          k < 4 ? answered(2, k < 2 ? "high" : "moderate", 10) : open(2),
          k < 3 ? insufficient(4) : open(4),
        ],
        hypotheses: [],
      },
    }));
    assert.deepEqual(s.env.service.recordReviewPanel(r2.id, results2, "supervisor"), {
      result: "review_failed",
    });
    let standing = standingDecisions(s.ledger, RUN);
    assert.deepEqual(
      [standing.get("question:2")?.decision, standing.get("question:2")?.certainty],
      ["answered", "moderate"],
      "the lower middle of four",
    );
    assert.equal(standing.get("question:4")?.decision, "insufficient");
    assert.equal(standing.get("question:0")?.review, r1.id, "question 1's decision stands");

    // A new card for question 1, answered before: it is open again until it is decided again.
    s.card(0, 5, "high");
    standing = standingDecisions(s.ledger, RUN);
    assert.equal(standing.get("question:0"), undefined);
    const r3 = s.ask();
    assert.deepEqual(r3.pkg.decide, { questions: [0], hypotheses: [] });
    const results3 = REVIEWERS.map((name) => ({
      reviewer: name,
      pass: true,
      reasons: "Checked.",
      research: { questions: [answered(0, "high", 5)], hypotheses: [] },
    }));
    assert.deepEqual(s.env.service.recordReviewPanel(r3.id, results3, "supervisor"), {
      result: "review_failed",
    });
    assert.deepEqual((s.events("review_panel").at(-1) as { open: number[] }).open, [5]);

    // Question 6's new card, and the review that gives it an end: every item has one, the pass.
    s.card(5, 3);
    const r4 = s.ask();
    assert.deepEqual(r4.pkg.decide, { questions: [5], hypotheses: [] });
    const results4 = REVIEWERS.map((name, k) => ({
      reviewer: name,
      pass: true,
      reasons: "Checked.",
      research: { questions: [k < 3 ? answered(5, "low", 3) : open(5)], hypotheses: [] },
    }));
    assert.deepEqual(s.env.service.recordReviewPanel(r4.id, results4, "supervisor"), {
      result: "review_passed",
      accepted: true,
    });
    const end = researchReviewDue(s.ledger, RUN, s.contractNow(), s.research.clock(RUN));
    assert.equal(
      "why" in end ? end.why : "",
      "the review panel's decisions gave every item an end",
    );
    assert.equal(
      s.ledger.db.prepare("select count(*) as n from review where goal = ?").get(RESEARCH_REVIEW)
        ?.n,
      4,
    );
    assert.equal(briefGaps(s.ledger, RUN), undefined, "no question stands open");
    // The run ended: its cards, and so its decisions, stay as they were, for its paper.
    s.ledger.db
      .prepare(
        "insert into claim (id, run, lane, question, text, quotes, verified, problems, created_at) values ('c-late0001', ?, 'lane-1', 0, 'A late claim.', '[]', 1, '[]', ?)",
      )
      .run(RUN, new Date().toISOString());
    assert.equal(
      s.env.service.cardPackages().filter((p) => p.run === RUN).length,
      0,
      "no card is asked of a run that ended",
    );
    assert.throws(() => s.card(0, 2), /run r-1 has ended: its answer cards stay as they were/);
    assert.equal(standingDecisions(s.ledger, RUN).size, 30);
    // The final report holds the decisions with the dissent.
    const final = s.research.report(RUN, "final").body;
    assert.match(
      final,
      /### 2\. How does kernel family B use the memory hierarchy\?\n\nDecision: answered, certainty moderate \(review \d+, card version 1; 3 of 5 reviewers\)\./,
    );
    assert.match(
      final,
      /- Dissent: reviewer-4: open: Evidence gaps: a vendor guide on the cache policy/,
    );
    assert.match(
      final,
      /### 5\. [^\n]+\n\nDecision: insufficient \(the best answer sources allow\) \(review \d+, card version 2; 3 of 5 reviewers\)\.[\s\S]*?Next experiments: Time each variant on the target card\./,
    );
  });
});

describe("the progress rule ends a run that stopped adding (goal 117)", () => {
  /** A scheduler for the run, its research trials doing nothing. */
  const scheduler = (s: Awaited<ReturnType<typeof longRun>>) =>
    new Scheduler({
      service: s.env.service,
      runner: new LocalRunner(s.env.service.paths.scratchDir),
      model: {
        baseUrl: "http://127.0.0.1:9",
        model: "m",
        apiKey: "k",
        contextWindow: 1,
        maxTokens: 1,
      },
      owner: "s",
      research: s.research as Research,
      runTrial: async () => done,
      runResearchTrial: async (_spec: ResearchTrialSpec) => done,
      maxConcurrent: 1,
    });

  test("open questions saturated and no improvement for a quarter of the running time: research_progress, research_stopped, the paper and the close", async (t) => {
    // Two questions, no hypotheses, so the scene is small: question 1 answered six hours ago,
    // question 2 decided open then, and its last tasks added nothing.
    const s = await longRun(
      t,
      { questions: QUESTIONS.slice(0, 2), hypotheses: undefined },
      { cards: false },
    );
    s.ledger.db.prepare("update hypothesis set status = 'pool' where run = ?").run(RUN);
    const ago = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
    const review = Number(
      s.ledger.db
        .prepare(
          "insert into review (run, goal, commit_sha, package, requested_at, panel, panel_result, panel_at) values (?, 'research', 'items:old', '{}', ?, '[]', 'review_failed', ?) returning id",
        )
        .get(RUN, ago(6.5), ago(6))?.id,
    );
    const decide = (key: string, decision: string, certainty: string | null) =>
      s.ledger.db
        .prepare(
          "insert into item_decision (run, kind, key, review, card_version, decision, certainty, decided_at) values (?, 'question', ?, ?, 1, ?, ?, ?)",
        )
        .run(RUN, key, review, decision, certainty, ago(6));
    decide("0", "answered", "high");
    decide("1", "open", null);
    // Each question's card, written seven hours ago (and since then, none).
    const card = s.ledger.db.prepare(
      "insert into question_card (run, question, version, answer, certainty, claims, gaps, by, created_at) values (?, ?, 1, 'Family A moves its weights through shared memory.', ?, ?, '[]', 'synthesizer', ?)",
    );
    card.run(RUN, 0, "high", JSON.stringify([claimId(0, 0)]), ago(7));
    card.run(RUN, 1, "low", JSON.stringify([claimId(1, 0)]), ago(7));
    const task = s.ledger.db.prepare(
      "insert into experiment (id, run, title, added_by, state, question, yield, created_at, updated_at) values (?, ?, 't', 'planner', 'done', 1, ?, ?, ?)",
    );
    const nothing = JSON.stringify({
      verified_claims: 0,
      by_question: [{ question: 1, verified_claims: 0, new_domain_claims: 0 }],
      new_domains: 0,
      domains: [],
      findings: 0,
      card_changes: 0,
    });
    for (let k = 0; k < SATURATION_TASKS; k++)
      task.run(`x-${k}`, RUN, nothing, ago(5 - k), ago(4.9 - k));
    const sch = scheduler(s);
    const digestDue = () =>
      s.ledger.db
        .prepare("update report_version set created_at = '2000-01-01T00:00:00.000Z'")
        .run();

    // A review that waits may still improve an item: the rule holds, but the run goes on.
    const waiting = Number(
      s.ledger.db
        .prepare(
          "insert into review (run, goal, commit_sha, package, requested_at) values (?, 'research', 'items:waiting', '{}', ?) returning id",
        )
        .get(RUN, ago(0.1))?.id,
    );
    await sch.tick();
    await sch.idle();
    let progress = s.events("research_progress").at(-1) as Record<string, unknown>;
    assert.deepEqual([progress.open, progress.saturated, progress.stopped], [[1], [1], false]);
    assert.equal(s.events("research_stopped").length, 0);
    s.ledger.db
      .prepare(
        "update review set panel = '[]', panel_result = 'review_failed', panel_at = ? where id = ?",
      )
      .run(ago(0.05), waiting);

    // The next digest: the rule ends the run, with its open items stated.
    digestDue();
    await sch.tick();
    await sch.idle();
    progress = s.events("research_progress").at(-1) as Record<string, unknown>;
    assert.deepEqual([progress.open, progress.saturated, progress.stopped], [[1], [1], true]);
    assert.ok(Number(progress.since_ms) >= 5.9 * 3_600_000, String(progress.since_ms));
    assert.ok(
      Math.abs(Number(progress.needed_ms) - 0.25 * s.research.clock(RUN).elapsed_ms) < 60_000,
      "a quarter of the running time, more than a quarter of the minimum",
    );
    assert.equal(typeof progress.last_improvement, "string");
    const stopped = s.events("research_stopped").at(-1) as Record<string, unknown>;
    assert.deepEqual(
      [stopped.reason, stopped.open],
      [PROGRESS_STOPPED, { questions: [1], hypotheses: [] }],
    );
    assert.equal(s.ledger.runs.get(RUN)?.status, "running", "it closes once its paper is in");
    assert.match(
      String(
        (
          s.ledger.db
            .prepare(
              "select body from report_version where kind = 'digest' order by id desc limit 1",
            )
            .get() as { body: string }
        ).body,
      ),
      /Answer check: research stopped adding \(the progress rule\); open: Question 2 \(index 1\)/,
    );
    // No new review and no new trial: the run waits for its paper.
    assert.equal(s.due().due, false);

    // The final writer is asked; its package says how the run ended and which question stayed open.
    await s.env.service.setAdvisors(
      { auditor: false, review_panel: 3, writer: true },
      "supervisor",
    );
    await sch.tick();
    const pkg = s.env.service.paperPackages()[0] as PaperPackage;
    assert.deepEqual(pkg.end, { reason: PROGRESS_STOPPED, open: [2], open_hypotheses: [] });
    assert.deepEqual(
      pkg.questions.map((x) => [x.number, x.decision, x.certainty, x.stayed_open]),
      [
        [1, "answered", "high", false],
        [2, "open", null, true],
      ],
    );
    const v = claimId(0, 0);
    const c = claimId(1, 0);
    const paper = [
      "# How two kernel families use the memory hierarchy",
      "## Abstract",
      `Family A moves its weights through shared memory [${v}]. The evidence on family B stays open [${c}].`,
      "## Introduction",
      "This run asked how two kernel families use the memory hierarchy.",
      "## Method",
      "The workers read archived sources, and the harness verified each claim against them.",
      "## Results",
      `Family A moves its weights through shared memory [${v}]. The review panel found this answer with high certainty.`,
      `The question on family B stays open. The sources show only part of the answer [${c}].`,
      "## Limitations",
      "The question on family B stays open: no source gave the cache policy.",
      "## Future work",
      `Find a vendor guide on the cache policy [${c}].`,
    ].join("\n\n");
    const out = s.env.service.submitPaper(
      RUN,
      { writer: "teacher-1", paper, experiments: [], ste: { checked: false, why: "no checker" } },
      "supervisor",
    );
    assert.ok(out.accepted, JSON.stringify(out));
    await sch.idle();
    await sch.tick();
    const run = s.ledger.runs.get(RUN);
    assert.deepEqual([run?.status, run?.pause_reason], ["closed", PROGRESS_STOPPED]);
    assert.notEqual(run?.pause_reason, ANSWERED);
    const final = String(
      (
        s.ledger.db
          .prepare("select body from report_version where kind = 'final' order by id desc limit 1")
          .get() as { body: string }
      ).body,
    );
    assert.ok(final.startsWith("# How two kernel families use the memory hierarchy"));
    assert.match(final, /Research stopped adding \(the progress rule\): question 2 stayed open\./);
  });

  test("no stop before the minimum, nor while the run still improves", async (t) => {
    const s = await longRun(t, { questions: QUESTIONS.slice(0, 2), hypotheses: undefined });
    const sch = scheduler(s);
    // Before the minimum (8h): no progress event at all.
    s.ledger.db
      .prepare("update run set created_at = ? where id = ?")
      .run(new Date(Date.now() - 3 * 3_600_000).toISOString(), RUN);
    await sch.tick();
    await sch.idle();
    assert.equal(s.events("research_progress").length, 0);
    // After it, with the cards just written (an improvement now) and no saturated question.
    s.ledger.db
      .prepare("update run set created_at = ? where id = ?")
      .run(new Date(Date.now() - 10 * 3_600_000).toISOString(), RUN);
    s.ledger.db.prepare("update report_version set created_at = '2000-01-01T00:00:00.000Z'").run();
    await sch.tick();
    await sch.idle();
    const p = s.events("research_progress").at(-1) as Record<string, unknown>;
    assert.equal(p.stopped, false);
    assert.deepEqual(p.saturated, []);
    assert.ok(Number(p.since_ms) < 60_000, "the cards improved the run just now");
    assert.equal(s.events("research_stopped").length, 0);
    assert.equal(s.ledger.runs.get(RUN)?.status, "running");
  });
});
