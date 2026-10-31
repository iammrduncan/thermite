import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import type { ResearchTrialSpec } from "../../../../src/harness/agents/research/worker.ts";
import { Scheduler } from "../../../../src/harness/agents/scheduler/index.ts";
import { LocalRunner } from "../../../../src/harness/broker/runner.ts";
import type { Research } from "../../../../src/harness/research/research/index.ts";
import {
  RESEARCH_REVIEW,
  type ResearchPackage,
  type ResearchVerdicts,
  researchPackage,
  researchReviewDue,
} from "../../../../src/harness/research/review/index.ts";
import { Reviews } from "../../../../src/harness/reviews.ts";
import { fillResearch, makeResearchRun, writeCards } from "../../../helpers/research-run.ts";

/**
 * What the research review's tests (research/review.ts) share: a research run with its questions,
 * cards and hypotheses, a reviewer's answers, and a scheduler for the run.
 *
 * Goals 112 and 117: a research run's items are its questions, each with its answer card, and its
 * required hypotheses. After the minimum running time, at a digest, code asks the review panel
 * about the items with no standing decision, once every question has a card; code checks each
 * reviewer's answers; each item is decided by the majority, and the decision stands until the
 * question's card changes. A review that leaves every question at an end and every required
 * hypothesis with a verdict passes, and closes the run with its final report, hands-off or after
 * the owner's acceptance; open questions' evidence gaps reach the workers' briefs.
 */

export const RUN = "r-1";

export type Env = Awaited<ReturnType<typeof makeResearchRun>>;
export type Ids = Awaited<ReturnType<typeof fillResearch>>;
export type Q = ResearchVerdicts["questions"][number];
export type H = ResearchVerdicts["hypotheses"][number];

export const done = {
  stopped: "no_submission" as const,
  turns: 0,
  toolCalls: 0,
  tokensIn: 0,
  tokensOut: 0,
};

export const answered = (
  index: number,
  claims: string[],
  answer: string,
  certainty: "high" | "moderate" | "low" = "high",
): Q => ({ index, verdict: "answered", certainty, answer, claims, gaps: "", next_experiments: "" });
export const open = (index: number, gaps: string): Q => ({
  index,
  verdict: "open",
  certainty: null,
  answer: "",
  claims: [],
  gaps,
  next_experiments: "",
});
export const reviewer = (name: string, questions: Q[], hypotheses: H[] = []) => ({
  reviewer: name,
  pass: questions.every((q) => q.verdict !== "open"),
  reasons: "Checked against the criteria.",
  research: { questions, hypotheses },
});

export async function setup(
  t: TestContext,
  o: {
    contract?: Record<string, unknown>;
    assign?: Record<string, unknown>;
    fill?: boolean;
    cards?: boolean;
  } = {},
) {
  const r = await makeResearchRun(RUN, o);
  t.after(() => r.close());
  const ids = o.fill === false ? undefined : await fillResearch(r);
  if (ids && o.cards !== false) writeCards(r, ids);
  const ledger = r.env.service.ledger;
  /** The run has run for this many hours (its clock counts from its creation). */
  const ranFor = (hours: number) =>
    ledger.db
      .prepare("update run set created_at = ? where id = ?")
      .run(new Date(Date.now() - hours * 3_600_000).toISOString(), RUN);
  /** The newest report is old, so the next step writes a digest. */
  const digestDue = () =>
    ledger.db.prepare("update report_version set created_at = '2000-01-01T00:00:00.000Z'").run();
  const contract = () => r.env.service.contractFor(RUN) as Parameters<typeof researchReviewDue>[2];
  const due = () => researchReviewDue(ledger, RUN, contract(), r.research.clock(RUN));
  /** Asks the review panel as the scheduler does at a digest. Returns the review's id. */
  const ask = () => {
    const d = due();
    assert.ok(d.due, `not due: ${"why" in d ? d.why : ""}`);
    return new Reviews(ledger).requestResearch({
      run: RUN,
      marker: d.marker,
      pkg: researchPackage(ledger, RUN, contract()),
      by: "s",
    });
  };
  const reviews = () =>
    ledger.db
      .prepare("select * from review where run = ? and goal = ? order by id")
      .all(RUN, RESEARCH_REVIEW) as Record<string, unknown>[];
  /** A new card for a question, as the synthesizer writes one: its version. */
  const card = (question: number, answer: string, claims: string[], certainty = "moderate") => {
    const out = r.env.service.submitCards(
      RUN,
      {
        synthesizer: "synthesizer",
        cards: [{ question, answer, certainty, claims, borrowed: [], gaps: [], through: null }],
      },
      "supervisor",
    ).results[0];
    assert.ok(out?.accepted, JSON.stringify(out));
    return out.version;
  };
  const pending = () =>
    new Reviews(ledger).pending(["research"]).at(-1) as ResearchPackage & { id: number };
  return { ...r, ids, ledger, ranFor, digestDue, due, ask, reviews, card, pending, contract };
}

/** A scheduler for the run, its research trials run by `trial`, `concurrent` at once. */
export function scheduler(
  env: Env,
  trial: (spec: ResearchTrialSpec, signal: AbortSignal) => Promise<typeof done> = async () => done,
  concurrent = 1,
) {
  return new Scheduler({
    service: env.env.service,
    runner: new LocalRunner(env.env.service.paths.scratchDir),
    model: {
      baseUrl: "http://127.0.0.1:9",
      model: "m",
      apiKey: "k",
      contextWindow: 1,
      maxTokens: 1,
    },
    owner: "s",
    research: env.research as Research,
    runTrial: async () => done,
    runResearchTrial: trial,
    maxConcurrent: concurrent,
  });
}
