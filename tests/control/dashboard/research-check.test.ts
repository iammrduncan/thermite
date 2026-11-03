import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { controlOnly, signIn } from "../../helpers/control-stack.ts";
import { ingestReport } from "../../helpers/control-store.ts";

/**
 * Goal 112 on control's side, from a rig's events: a research run's Overview says in one line
 * where the check that every question is answered stands; a passed review that waits for the
 * owner is a decision with the answers; a run closed because every question is answered reads
 * Completed.
 */

const PAGE = "/ui/campaigns/survey/runs/s-1";

async function control() {
  const { store, control: api } = controlOnly({ tokens: { rigs: { "rig-a": "t-a-abcdef" } } });
  const { page } = await signIn(api);
  let id = 0;
  const t0 = Date.now() - 3600_000;
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
  return { store, page, ingest, line };
}

const digest = (o: {
  elapsed_h: number;
  verified: number[];
  floor?: number;
}): { kind: string; subject: string; body: Record<string, unknown> } => ({
  kind: "research_digest",
  subject: "s-1",
  body: {
    questions: o.verified.map((v, i) => ({ question: `Question words ${i + 1}`, verified: v })),
    verified: o.verified.reduce((a, b) => a + b, 0),
    elapsed_ms: o.elapsed_h * 3_600_000,
    min_ms: 2 * 3_600_000,
    max_ms: null,
    min_verified_claims: o.floor ?? null,
    unsupported_numbers: 0,
    report: "# Report",
  },
});

const start = [
  {
    kind: "run_created",
    subject: "s-1",
    body: { campaign: "survey", version: 1, mode: "research", seed: { repo: "research" } },
  },
  { kind: "run_status", subject: "s-1", body: { status: "running", reason: null } },
];

describe("a research run's answer check on control (goal 112)", () => {
  test("the Overview says where the check stands, in one line, from the digests and the reviews", async () => {
    const c = await control();
    await c.ingest(...start, digest({ elapsed_h: 0.5, verified: [3, 0] }));
    assert.equal(
      await c.line(),
      "The check starts once the run has run for its minimum, 2.0 h. At the newest digest it had run 0.5 h.",
    );
    await c.ingest(digest({ elapsed_h: 3, verified: [3, 0] }));
    assert.equal(await c.line(), "Waiting for a verified claim on question 2.");
    await c.ingest(digest({ elapsed_h: 3.5, verified: [3, 1], floor: 5 }));
    assert.equal(await c.line(), "Waiting for verified claims: 4 of the 5 the campaign asks for.");
    await c.ingest(digest({ elapsed_h: 4, verified: [3, 2], floor: 5 }), {
      kind: "review_requested",
      subject: "s-1",
      body: { review: 1, goal: "research", commit: "corpus:5:0:c-1" },
    });
    assert.equal(
      await c.line(),
      "The review panel checks whether every question is answered (review 1).",
    );
    // A rig whose supervisor has no review panel: the check waits for one.
    c.store.reportedRigs.setSupervisor("rig-a", { advisors: null });
    assert.equal(
      await c.line(),
      "The check waits for a review panel: this rig's supervisor has no review panel set up. The run keeps researching.",
    );
    c.store.reportedRigs.setSupervisor("rig-a", { advisors: { roles: { review_panel: 3 } } });
    await c.ingest({
      kind: "review_panel",
      subject: "s-1",
      body: {
        review: 1,
        goal: "research",
        result: "review_failed",
        reviewers: 3,
        gaps: ["Question 2: missing: a second, independent site", "Hypothesis h-1: no verdict"],
      },
    });
    assert.equal(
      await c.line(),
      "Not yet: review 1 found gaps: Question 2: missing: a second, independent site; Hypothesis h-1: no verdict. The run goes on, and the review panel is asked again on new evidence.",
    );
    await c.ingest(digest({ elapsed_h: 5, verified: [3, 3], floor: 5 }));
    assert.match(String(await c.line()), /^Not yet: review 1 found gaps/);
  });

  test("a pass that waits for the owner is a decision with the answers; accepted and closed, the run reads Completed", async () => {
    const c = await control();
    await c.ingest(
      ...start,
      digest({ elapsed_h: 3, verified: [2, 2] }),
      {
        kind: "review_requested",
        subject: "s-1",
        body: { review: 4, goal: "research", commit: "corpus:4:0:c-9" },
      },
      {
        kind: "review_panel",
        subject: "s-1",
        body: {
          review: 4,
          goal: "research",
          result: "review_passed",
          reviewers: 3,
          questions: [
            { question: 0, answered_by: 3, answer: "Four <cards> support it.", claims: ["c-1"] },
            { question: 1, answered_by: 3, answer: "Yes, in the driver's notes.", claims: ["c-9"] },
          ],
          gaps: [],
        },
      },
    );
    assert.equal(
      await c.line(),
      "The review panel found every question answered (review 4). It waits for your acceptance in Needs you.",
    );
    const run = await c.page(PAGE);
    assert.match(run, /Accept that every question is answered\?/);
    assert.match(
      run,
      /<li value="1">Four &lt;cards&gt; support it\.<\/li><li value="2">Yes, in the driver's notes\.<\/li>/,
    );
    assert.match(run, /name="kind" value="accept_review"/);
    // Not a goal's review: the attempts tab lists none as one.
    assert.doesNotMatch(await c.page(`${PAGE}/attempts`), /Reviews of subjective goals/);
    assert.match(run, /<span class="label violet"><svg[^>]*>[\s\S]*?<\/svg>Review<\/span>/);
    await c.ingest({
      kind: "review_decided",
      subject: "s-1",
      body: { review: 4, goal: "research", decision: "accepted" },
    });
    assert.equal(
      await c.line(),
      "Answered: the review panel found every question answered (review 4). The run writes its final report and ends once its running trials end.",
    );
    await c.ingest(
      {
        kind: "research_final",
        subject: "s-1",
        body: digest({ elapsed_h: 3.2, verified: [2, 2] }).body,
      },
      {
        kind: "run_status",
        subject: "s-1",
        body: { status: "closed", reason: "every question is answered" },
      },
    );
    assert.equal(
      await c.line(),
      "Answered: the review panel found every question answered (review 4). The final report holds its answers and its verdicts on the hypotheses.",
    );
    assert.match(
      await c.page(PAGE),
      /· research · <span class="label ok"><svg[^>]*>[\s\S]*?<\/svg>Completed<\/span>/,
    );
  });

  test("a research run that ended at its maximum reads Finished, and says its questions were not found answered", async () => {
    const c = await control();
    await c.ingest(
      ...start,
      digest({ elapsed_h: 3, verified: [2, 2] }),
      {
        kind: "research_final",
        subject: "s-1",
        body: digest({ elapsed_h: 4, verified: [2, 2] }).body,
      },
      {
        kind: "run_status",
        subject: "s-1",
        body: { status: "closed", reason: "the research window is over" },
      },
    );
    assert.equal(
      await c.line(),
      "The run ended before the review panel found every question answered: its final report says so.",
    );
    assert.match(
      await c.page(PAGE),
      /· research · <span class="label muted"><svg[^>]*>[\s\S]*?<\/svg>Finished<\/span>/,
    );
  });
});
