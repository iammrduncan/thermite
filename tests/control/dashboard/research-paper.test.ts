import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { queueSeedOf } from "../../../src/control/kb/index.ts";
import { controlOnly, signIn } from "../../helpers/control-stack.ts";
import { ingestReport } from "../../helpers/control-store.ts";

/**
 * Goal 112's research paper on control's side, from a rig's events: the research Overview's
 * Answer check line says when the final writer is at work and when the paper is in, the run's
 * brief shows the writer at work, the run's page links the paper and shows it, and the paper's
 * next experiments are past research a new run can take into its queue.
 */

const PAGE = "/ui/campaigns/survey/runs/s-1";

async function control() {
  const { store, control: api } = controlOnly({ tokens: { rigs: { "rig-a": "t-a-abcdef" } } });
  const { get, page } = await signIn(api);
  let id = 0;
  const t0 = Date.now() - 3600_000;
  /** The rig's report of these events, once control applied them from the events stream. */
  const ingest = async (
    ...events: { kind: string; subject: string; body: Record<string, unknown> }[]
  ) => {
    await ingestReport(store, {
      rig: "rig-a",
      ledger_id: "ledger-a",
      cursor: id,
      next: id + events.length,
      events: events.map((e) => ({
        id: ++id,
        at: new Date(t0 + id * 1000).toISOString(),
        actor: "harness",
        ...e,
      })),
      summary: {},
    });
  };
  /** The Overview's one line on the answer check, without markup. */
  const line = async () =>
    (/<div class="small rcheck"[^>]*><b>Answer check:<\/b> ([^<]*)<\/div>/.exec(await page(PAGE)) ??
      [])[1];
  return { store, get, page, ingest, line };
}

const digest = {
  questions: [
    { question: "Question words 1", verified: 2 },
    { question: "Question words 2", verified: 2 },
  ],
  verified: 4,
  elapsed_ms: 3 * 3_600_000,
  min_ms: 2 * 3_600_000,
  max_ms: null,
  min_verified_claims: null,
  unsupported_numbers: 0,
  report: "# Report",
};

/** A research run whose review the review panel passed, accepted hands-off. */
const answered = [
  {
    kind: "run_created",
    subject: "s-1",
    body: { campaign: "survey", version: 1, mode: "research", seed: { repo: "research" } },
  },
  { kind: "run_status", subject: "s-1", body: { status: "running", reason: null } },
  { kind: "research_digest", subject: "s-1", body: digest },
  {
    kind: "review_requested",
    subject: "s-1",
    body: { review: 4, goal: "research", commit: "corpus:4:0:c-9" },
  },
  {
    kind: "review_panel",
    subject: "s-1",
    body: { review: 4, goal: "research", result: "review_passed", reviewers: 2, gaps: [] },
  },
  {
    kind: "review_decided",
    subject: "s-1",
    body: { review: 4, goal: "research", decision: "accepted" },
  },
];

const PAPER = "# What the runs show\n\n## Summary\n\nThe first run kept <b>42</b> pages [c-1].\n";

describe("a research run's paper on control (goal 112)", () => {
  test("the Answer check line says when the final writer is at work and when the paper is in; the run's page links the paper", async () => {
    const c = await control();
    await c.ingest(...answered);
    await c.ingest({
      kind: "research_paper_requested",
      subject: "s-1",
      body: { review: 4, figures: { sources: 2 } },
    });
    assert.equal(
      await c.line(),
      "Answered: the review panel found every question answered (review 4). The final writer is writing the paper. The run ends once the paper is in and its running trials end.",
    );
    // The run's brief: the final writer at work.
    assert.match(
      await c.page(PAGE),
      /<span class="br-who">writer<\/span><span class="br-what">the final writer is writing the paper<\/span>/,
    );
    await c.ingest({
      kind: "research_paper_refused",
      subject: "s-1",
      body: {
        review: 4,
        writer: "teacher-1",
        count: 2,
        problems: ["line 3: no claim c-7", 'Results has no "### Question 2" section'],
        ste_checked: true,
      },
    });
    assert.equal(
      await c.line(),
      "Answered: the review panel found every question answered (review 4). The final writer is writing the paper; the harness refused its last draft (line 3: no claim c-7). The run ends once the paper is in and its running trials end.",
    );
    const history = await c.page(`${PAGE}/history`);
    assert.match(history, /The final writer was asked to write the research paper\./);
    assert.match(
      history,
      /The harness refused the final writer's paper: 2 problems, the first: line 3: no claim c-7\./,
    );
    // No link while there is no paper.
    assert.equal((await c.get("/ui/campaigns/survey/runs/s-1/paper.md")).status, 404);
    await c.ingest({
      kind: "research_paper_accepted",
      subject: "s-1",
      body: {
        review: 4,
        writer: "teacher-1",
        ste: { checked: true, version: "1", issue: "9", counts: { error: 0, warning: 1, info: 0 } },
        cited_claims: 1,
        experiments: [{ id: "x-0123456789ab", title: "Count on a second site", why: "One site." }],
        chars: PAPER.length,
        paper: PAPER,
      },
    });
    assert.equal(
      await c.line(),
      "Answered: the review panel found every question answered (review 4). The research paper is in, checked against the rig's STE checker. The run ends once its running trials end.",
    );
    const run = await c.page(PAGE);
    assert.doesNotMatch(run, /the final writer is writing the paper/);
    assert.match(
      run,
      /<b>Research paper:<\/b> by the final writer teacher-1, checked against the rig's STE checker; 1 next experiment kept in the knowledge base\. <a href="\/ui\/campaigns\/survey\/runs\/s-1\/paper\.md">paper\.md<\/a>/,
    );
    // The paper itself beside the latest report, as text.
    assert.match(
      run,
      /<summary[^>]*>Research paper<\/summary><pre class="report"[^>]*># What the runs show\n\n## Summary\n\nThe first run kept &lt;b&gt;42&lt;\/b&gt; pages \[c-1\]\.\n<\/pre>/,
    );
    const file = await c.get("/ui/campaigns/survey/runs/s-1/paper.md");
    assert.equal(file.status, 200);
    assert.equal(file.headers.get("content-type"), "text/plain; charset=utf-8");
    assert.equal(await file.text(), PAPER);
    assert.match(
      await c.page(`${PAGE}/history`),
      /The research paper passed the harness's checks and the rig's STE checker\. It cites 1 claims, and 1 next experiment went to the knowledge base\./,
    );
    // Closed: the final report starts with the paper.
    await c.ingest(
      { kind: "research_final", subject: "s-1", body: { ...digest, paper: true } },
      {
        kind: "run_status",
        subject: "s-1",
        body: { status: "closed", reason: "every question is answered" },
      },
    );
    assert.equal(
      await c.line(),
      "Answered: the review panel found every question answered (review 4). The final report starts with the research paper, then the review panel's answers and its verdicts on the hypotheses.",
    );
  });

  test("a rig with no final writer: the run closes with the review panel's answers, and the line says there is no paper", async () => {
    const c = await control();
    await c.ingest(
      ...answered,
      {
        kind: "research_final",
        subject: "s-1",
        body: { ...digest, paper: false, no_paper: "no final writer on this rig" },
      },
      {
        kind: "run_status",
        subject: "s-1",
        body: { status: "closed", reason: "every question is answered" },
      },
    );
    assert.equal(
      await c.line(),
      "Answered: the review panel found every question answered (review 4). The final report holds its answers and its verdicts on the hypotheses. There is no research paper: no final writer on this rig.",
    );
  });

  test("the paper's next experiments are experiments of the campaign's folder, which Start a run takes into a new run's queue", async () => {
    const c = await control();
    await c.ingest(...answered, {
      kind: "research_paper_accepted",
      subject: "s-1",
      body: {
        review: 4,
        writer: "teacher-1",
        ste: { checked: false, why: "the rig has no STE checker" },
        cited_claims: 1,
        experiments: [
          {
            id: "x-0123456789ab",
            title: "Count the pages on a second site",
            why: "Every claim comes from one site.",
            details: "Fetch the same pages from a mirror.",
            findings: ["f-1"],
            claims: [],
            rests_on: ["finding f-1: The harness kept its first run's pages."],
          },
        ],
        chars: PAPER.length,
        paper: PAPER,
      },
    });
    const kb = c.store.kb();
    const items = kb.search("", ["survey"], { kinds: ["experiment"] });
    assert.equal(items.length, 1);
    const x = items[0];
    assert.ok(x);
    assert.equal(x.by, "writer:teacher-1");
    assert.equal(x.run, "s-1");
    const seed = queueSeedOf(x, kb.resultOf(x));
    assert.deepEqual(seed, {
      title: "Count the pages on a second site",
      details:
        "Fetch the same pages from a mirror.\nIt rests on, from the research paper of run s-1:\n- finding f-1: The harness kept its first run's pages.\nFrom s-1 (survey).",
      why: "Every claim comes from one site.",
      by: "writer:teacher-1",
      state: "queued",
      from: { run: "s-1", id: "x-0123456789ab" },
    });
  });
});
