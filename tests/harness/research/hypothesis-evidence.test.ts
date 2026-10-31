import assert from "node:assert/strict";
import { test } from "node:test";
import { SATURATION_TASKS } from "../../../src/core/research-check.ts";
import type { Ledger } from "../../../src/harness/ledger/index.ts";
import {
  hypothesisEvidence,
  hypothesisTask,
  hypothesisTasksDone,
  unevidencedHypotheses,
} from "../../../src/harness/research/hypothesis-evidence.ts";
import { standingDecisions } from "../../../src/harness/research/progress.ts";
import {
  itemsState,
  type ResearchPackage,
  type ResearchVerdicts,
  researchPackage,
  researchReviewDue,
} from "../../../src/harness/research/review/index.ts";
import { gapOf } from "../../../src/harness/research/shares.ts";
import { Reviews } from "../../../src/harness/reviews.ts";
import { makeResearchRun } from "../../helpers/research-run.ts";

const RUN = "r-1";
const QUESTIONS = ["What page size does a new database use?", "Which journal modes exist?"];
const REVIEWERS = ["reviewer-1", "reviewer-2", "reviewer-3"];

type H = ResearchVerdicts["hypotheses"][number];

test("an undecided with no claim for or against a hypothesis is no end: the plan gives it a task, and the panel sees it again", async (t) => {
  const r = await makeResearchRun(RUN, {
    contract: {
      questions: QUESTIONS,
      min_duration: "1h",
      max_duration: "4h",
      hypotheses: [
        "A new database uses a page size of 4096 bytes.",
        "Each table of a database is kept in a file of its own.",
      ],
    },
  });
  t.after(() => r.close());
  const ledger = r.env.service.ledger as Ledger;
  const queue = r.env.service.queue;
  const now = new Date().toISOString();
  ledger.db
    .prepare(
      "insert into source (id, run, url, final_url, domain, fetched_at, http_status, bytes, sha256, raw_path, text_path, fetched_by) values ('s-1', ?, 'https://docs.example/a', 'https://docs.example/a', 'docs.example', ?, 200, 10, 'x', '/dev/null', '/dev/null', 'lane-1')",
    )
    .run(RUN, now);
  const claim = ledger.db.prepare(
    "insert into claim (id, run, lane, question, text, quotes, verified, problems, created_at) values (?, ?, 'lane-1', ?, ?, ?, 1, '[]', ?)",
  );
  for (const [id, q, text] of [
    ["c-page", 0, "The default page size is 4096 bytes."],
    ["c-wal", 1, "WAL is one of the journal modes."],
  ] as const)
    claim.run(id, RUN, q, text, JSON.stringify([{ source: "s-1", quote: text }]), now);
  for (const [question, c] of [
    [0, "c-page"],
    [1, "c-wal"],
  ] as const)
    r.env.service.submitCards(
      RUN,
      {
        synthesizer: "synthesizer",
        cards: [
          {
            question,
            answer: "The claims answer it.",
            certainty: "high",
            claims: [c],
            borrowed: [],
            gaps: [],
            through: null,
          },
        ],
      },
      "supervisor",
    );
  ledger.db
    .prepare("update run set created_at = ? where id = ?")
    .run(new Date(Date.now() - 2 * 3_600_000).toISOString(), RUN);
  const [page, table] = ledger.db
    .prepare("select id from hypothesis where run = ? order by created_at, rowid")
    .all(RUN)
    .map((h) => String((h as { id: string }).id)) as [string, string];
  const contract = () => r.env.service.contractFor(RUN) as Parameters<typeof researchPackage>[2];
  const due = () => researchReviewDue(ledger, RUN, contract(), r.research.clock(RUN));
  const review = (hypotheses: (k: number) => H[]) => {
    const d = due();
    assert.ok(d.due, `not due: ${"why" in d ? d.why : ""}`);
    const pkg = researchPackage(ledger, RUN, contract());
    const id = new Reviews(ledger).requestResearch({ run: RUN, marker: d.marker, pkg, by: "s" });
    const p = new Reviews(ledger).pending(["research"]).at(-1) as ResearchPackage;
    return r.env.service.recordReviewPanel(
      id,
      REVIEWERS.map((reviewer, k) => ({
        reviewer,
        pass: false,
        reasons: "Checked.",
        research: {
          questions: p.decide.questions.map((index) => ({
            index,
            verdict: "answered" as const,
            certainty: "high" as const,
            answer: "The claims answer it.",
            claims: [index === 0 ? "c-page" : "c-wal"],
            gaps: "",
            next_experiments: "",
          })),
          hypotheses: hypotheses(k),
        },
      })),
      "supervisor",
    );
  };
  // Before any review nothing says no evidence exists: no task.
  assert.equal(hypothesisTask(ledger, queue, RUN, QUESTIONS, "planner"), undefined);

  // The panel supports one with a claim, and leaves the other undecided, citing nothing.
  const undecided = (id: string): H => ({
    id,
    verdict: "undecided",
    why: "No claim speaks to it.",
    claims: [],
  });
  assert.deepEqual(
    review(() => [
      { id: page, verdict: "supported", why: "The claim shows it.", claims: ["c-page"] },
      undecided(table),
    ]),
    { result: "review_failed" },
    "an undecided with no evidence is no end, so the review does not pass",
  );
  assert.equal(standingDecisions(ledger, RUN).get(`hypothesis:${table}`)?.decision, "undecided");
  assert.deepEqual(itemsState(ledger, RUN, 2).open, { questions: [], hypotheses: [table] });
  assert.equal(hypothesisEvidence(ledger, RUN).get(page), 1);
  assert.deepEqual(
    unevidencedHypotheses(ledger, RUN, standingDecisions(ledger, RUN)).map((h) => h.id),
    [table],
  );
  assert.match(String((due() as { why?: string }).why), /saw these items/);

  // The plan's task for it: no question (the author's hypotheses name none), its gap names it.
  const x = hypothesisTask(ledger, queue, RUN, QUESTIONS, "planner");
  assert.ok(x);
  assert.equal(x.question, null);
  assert.equal(x.family, "primary");
  assert.match(gapOf(x.details) ?? "", new RegExp(`^Hypothesis ${table} needs a verdict`));
  assert.match(x.details, /Each table of a database is kept in a file of its own/);
  assert.equal(
    hypothesisTask(ledger, queue, RUN, QUESTIONS, "planner"),
    undefined,
    "one task at a time",
  );

  // Done, it shows the panel the hypothesis again; up to SATURATION_TASKS tasks in all.
  const finish = (id: string) =>
    ledger.db
      .prepare("update experiment set state = 'done', updated_at = ? where id = ?")
      .run(new Date().toISOString(), id);
  finish(x.id);
  assert.equal(hypothesisTasksDone(ledger, RUN), 1);
  const again = due();
  assert.ok(again.due && again.marker.endsWith(":t1"), JSON.stringify(again));
  assert.deepEqual(again.hypotheses, [table]);
  for (let k = 1; k < SATURATION_TASKS; k++) {
    const next = hypothesisTask(ledger, queue, RUN, QUESTIONS, "planner");
    assert.ok(next, `task ${k + 1}`);
    finish(next.id);
  }
  assert.equal(hypothesisTask(ledger, queue, RUN, QUESTIONS, "planner"), undefined);

  // Undecided again, now citing claims both ways: an end, and the review passes.
  assert.deepEqual(
    review(() => [{ ...undecided(table), why: "The claims disagree.", claims: ["c-page"] }]),
    { result: "review_passed", accepted: true },
  );
  assert.deepEqual(itemsState(ledger, RUN, 2).open, { questions: [], hypotheses: [] });
  assert.deepEqual(unevidencedHypotheses(ledger, RUN, standingDecisions(ledger, RUN)), []);
});
