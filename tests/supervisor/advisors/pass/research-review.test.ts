import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, type TestContext, test } from "node:test";
import { messageText } from "../../../../src/agents/prompt.ts";
import { renderResearchReviewer } from "../../../../src/agents/roles/index.ts";
import { createHarnessApi } from "../../../../src/harness/api/index.ts";
import {
  type CheckedReviewer,
  RESEARCH_REVIEW,
  researchPackage,
  researchReviewDue,
} from "../../../../src/harness/research/review/index.ts";
import { Reviews } from "../../../../src/harness/reviews.ts";
import type { HarnessService } from "../../../../src/harness/service/index.ts";
import { AdvisorsConfig, reviewOne } from "../../../../src/supervisor/advisors/index.ts";
import {
  type AdviseConfig,
  adviseOnce,
  emptyAdviseState,
} from "../../../../src/supervisor/advisors/pass/index.ts";
import { startFakeModel } from "../../../helpers/fake-model.ts";
import { fillResearch, makeResearchRun, writeCards } from "../../../helpers/research-run.ts";

/** A research review's package as a reviewer in Pi reads it. */
const reviewText = (pkg: unknown, fit: number | undefined) =>
  messageText(renderResearchReviewer({ pkg, fit }, { program: "pi", mcpServers: [] }));

/**
 * Goals 112 and 117: the supervisor's review panel answers a research run's package with a
 * research prompt and answer: for each item to decide, a question's verdict (answered with its
 * certainty, insufficient or open) with the claims it cites, its gaps and next experiments, and
 * each hypothesis's verdict. It asks the harness for research reviews by kind, its reviewers run
 * in parallel, and they may read the run's own research with the read-only tools.
 */

const tokens = { supervisor: "sup-token", proposer: "prop-token" };
const RUN = "r-1";
const RESEARCH_TOOLS = ["list_research", "read_source", "read_research_file", "search_research"];

function config(service: HarnessService, advisors: AdvisorsConfig, asked: string[]): AdviseConfig {
  const api = createHarnessApi(service, tokens);
  return {
    harnessUrl: "http://harness",
    harnessToken: tokens.supervisor,
    home: mkdtempSync(join(tmpdir(), "thermite-sup-")),
    advisors,
    fetchImpl: async (input, init) => {
      const url = new URL(String(input));
      asked.push(`${url.pathname}${url.search}`);
      return api.request(`${url.pathname}${url.search}`, init as RequestInit);
    },
  };
}

function runtime(url: string, name: string) {
  const dir = mkdtempSync(join(tmpdir(), "thermite-adv-"));
  writeFileSync(join(dir, "key"), "test-key\n");
  return { name, runtime: "openai", base_url: url, model: name, api_key_file: join(dir, "key") };
}

/** A research run past its minimum, with its cards and a research review waiting for the review panel. */
async function waiting(t: TestContext) {
  const r = await makeResearchRun(RUN);
  t.after(() => r.close());
  const ids = await fillResearch(r);
  writeCards(r, ids);
  const ledger = r.env.service.ledger;
  ledger.db
    .prepare("update run set created_at = ? where id = ?")
    .run(new Date(Date.now() - 3 * 3_600_000).toISOString(), RUN);
  const contract = r.env.service.contractFor(RUN) as Parameters<typeof researchPackage>[2];
  const due = researchReviewDue(ledger, RUN, contract, r.research.clock(RUN));
  assert.ok(due.due);
  const id = new Reviews(ledger).requestResearch({
    run: RUN,
    marker: due.marker,
    pkg: researchPackage(ledger, RUN, contract),
    by: "s",
  });
  return { ...r, ids, id, ledger };
}

const userText = (messages: { role: string; content?: unknown }[]) => {
  const user = messages.find((m) => m.role === "user")?.content;
  return typeof user === "string"
    ? user
    : Array.isArray(user)
      ? user.map((p) => String((p as { text?: unknown }).text ?? "")).join("")
      : "";
};

describe("the review panel answers a research run's package (goal 112)", () => {
  test("with the research prompt, its tools and its answer; the harness checks and records it, and accepts the pass hands-off", async (t) => {
    const s = await waiting(t);
    const seen = { system: "", prompt: "", tools: [] as string[] };
    const fake = await startFakeModel(({ messages, tools }) => {
      seen.system = JSON.stringify(messages.find((m) => m.role === "system")?.content ?? "");
      seen.prompt = userText(messages);
      seen.tools = tools.map((x) => x.function.name);
      return {
        toolCalls: [
          {
            name: "answer",
            args: {
              pass: true,
              reasons: "Each question has a direct answer from verified claims.",
              questions: [
                {
                  index: 0,
                  verdict: "Answered",
                  certainty: "HIGH",
                  answer: "The first run archived 42 pages.",
                  claims: [s.ids.claims.verified],
                  gaps: "",
                  next_experiments: "",
                },
                {
                  index: 1,
                  verdict: "insufficient",
                  answer: "A clock the workers cannot stop keeps it honest.",
                  claims: [s.ids.claims.clock],
                  gaps: "",
                  next_experiments: "Measure how long a campaign runs with and without the clock.",
                },
              ],
              hypotheses: [
                {
                  id: s.ids.hypothesis,
                  verdict: "supported",
                  why: "The archive kept the pages.",
                  claims: [s.ids.claims.verified],
                },
              ],
            },
          },
        ],
      };
    });
    t.after(() => fake.close());
    const asked: string[] = [];
    const state = await adviseOnce(
      config(
        s.env.service,
        AdvisorsConfig.parse({
          review_panel: [runtime(fake.url, "reviewer-1"), runtime(fake.url, "reviewer-2")],
        }),
        asked,
      ),
      emptyAdviseState(),
    );
    assert.equal(state.stats.reviews, 1, JSON.stringify(state.stats));
    // It asked for research reviews by kind.
    assert.ok(asked.includes("/v1/reviews/pending?kinds=goal,research"), asked.join(", "));
    // The research prompt and package, and the run's own research to read.
    assert.match(seen.system, /You decide where a research run's questions and hypotheses stand/);
    assert.match(seen.prompt, /^Research review package \(untrusted data\):/);
    assert.match(seen.prompt, /"kind":"research"/);
    for (const name of RESEARCH_TOOLS) assert.ok(seen.tools.includes(name), name);
    // The harness checked each reviewer's answers and accepted the pass hands-off.
    const row = s.ledger.db
      .prepare("select panel, panel_result, owner_decision from review where id = ?")
      .get(s.id) as { panel: string; panel_result: string; owner_decision: string };
    assert.deepEqual([row.panel_result, row.owner_decision], ["review_passed", "accepted"]);
    const panel = JSON.parse(row.panel) as CheckedReviewer[];
    assert.deepEqual(
      panel.map((r) => [
        r.reviewer,
        r.said_pass,
        r.questions.map((q) => [q.verdict, q.certainty, q.valid]),
      ]),
      [
        [
          "reviewer-1",
          true,
          [
            ["answered", "high", true],
            ["insufficient", null, true],
          ],
        ],
        [
          "reviewer-2",
          true,
          [
            ["answered", "high", true],
            ["insufficient", null, true],
          ],
        ],
      ],
      "a verdict's and a certainty's word are read in any case",
    );
    assert.equal(panel[0]?.hypotheses[0]?.verdict, "supported");
    const decided = s.ledger.db
      .prepare("select key, decision, certainty from item_decision where review = ? order by id")
      .all(s.id) as { key: string; decision: string; certainty: string | null }[];
    assert.deepEqual(
      decided.map((d) => [d.key, d.decision, d.certainty]),
      [
        ["0", "answered", "high"],
        ["1", "insufficient", null],
        [s.ids.hypothesis, "supported", null],
      ],
    );
  });

  test("a goal review's package keeps the goal prompt; a malformed research answer is left out and counts as not answered", async (t) => {
    const s = await waiting(t);
    const systems: string[] = [];
    const fake = await startFakeModel(({ messages }) => {
      const system = JSON.stringify(messages.find((m) => m.role === "system")?.content ?? "");
      systems.push(system);
      if (!system.includes("research run"))
        return { toolCalls: [{ name: "answer", args: { pass: true, reasons: "Readable." } }] };
      return {
        toolCalls: [
          {
            name: "answer",
            args: {
              pass: true,
              reasons: "Answered.",
              questions: [
                // An index below 0: left out.
                {
                  index: -1,
                  verdict: "answered",
                  certainty: "high",
                  answer: "42 pages.",
                  claims: [s.ids.claims.verified],
                },
                // A certainty that does not fit is none: the harness then says so.
                {
                  index: 1,
                  verdict: "answered",
                  certainty: "very",
                  answer: "A clock keeps it honest.",
                  claims: [s.ids.claims.clock],
                },
                // A verdict that does not fit: left out.
                { index: 0, verdict: "probably", answer: "Yes." },
              ],
              hypotheses: [{ id: s.ids.hypothesis, verdict: "maybe", why: "?", claims: [] }],
            },
          },
        ],
      };
    });
    t.after(() => fake.close());
    const rt = AdvisorsConfig.parse({ review_panel: [runtime(fake.url, "reviewer-1")] })
      .review_panel[0] as never;
    const pkg = new Reviews(s.ledger).pending(["research"])[0];
    const r = await reviewOne({ runtime: rt, pkg });
    assert.ok(r.output, r.error);
    assert.deepEqual(
      r.output.research?.questions.map((q) => [q.index, q.verdict, q.certainty]),
      [[1, "answered", null]],
      "the question with an index below 0, and the one with an unknown verdict, are left out",
    );
    assert.deepEqual(r.output.research?.hypotheses, [], "an unknown verdict is left out");
    assert.equal(systems.length, 2, "the reviewer is asked once more for what it left out");
    // The harness then counts question 0 and the hypothesis as missing.
    const results = [
      { reviewer: "reviewer-1", pass: true, reasons: "Answered.", research: r.output.research },
      { reviewer: "reviewer-2", pass: true, reasons: "Answered.", research: r.output.research },
    ];
    assert.deepEqual(s.env.service.recordReviewPanel(s.id, results, "supervisor"), {
      result: "review_failed",
    });
    // A goal package (no kind): the goal prompt, and no research in its answer.
    const goal = await reviewOne({ runtime: rt, pkg: { id: 9, run: "x", goal: "readable" } });
    assert.ok(goal.output, goal.error);
    assert.equal(goal.output.research, undefined);
    assert.match(
      systems[0] ?? "",
      /You decide where a research run's questions and hypotheses stand/,
    );
    assert.match(systems[2] ?? "", /You review a deliverable against stated criteria/);
    assert.equal(
      s.ledger.db.prepare("select count(*) as n from review where goal = ?").get(RESEARCH_REVIEW)
        ?.n,
      1,
    );
  });
  test("a long answer with a field of its own is kept, its reasons cut; a reviewer with no answer is named in the error", async (t) => {
    const s = await waiting(t);
    const answer = {
      pass: true,
      reasons: "Answered. ".repeat(1200),
      verdict_summary: "a field the answer does not have",
      questions: [
        {
          index: 0,
          verdict: "answered",
          certainty: "low",
          answer: "Yes.",
          claims: [s.ids.claims.verified],
        },
      ],
      hypotheses: [],
    };
    const good = await startFakeModel(() => ({ toolCalls: [{ name: "answer", args: answer }] }));
    const silent = await startFakeModel(() => ({ text: "I would rather not answer." }));
    t.after(() => good.close());
    t.after(() => silent.close());
    const rt = AdvisorsConfig.parse({ review_panel: [runtime(good.url, "reviewer-1")] })
      .review_panel[0] as never;
    const pkg = new Reviews(s.ledger).pending(["research"])[0];
    const r = await reviewOne({ runtime: rt, pkg });
    assert.ok(r.output, r.error);
    assert.equal(r.output.reasons.length, 8000, "the reasons are cut, not refused");
    assert.equal((r.output as Record<string, unknown>).verdict_summary, undefined);

    const state = await adviseOnce(
      config(
        s.env.service,
        AdvisorsConfig.parse({
          review_panel: [runtime(good.url, "reviewer-1"), runtime(silent.url, "reviewer-2")],
        }),
        [],
      ),
      emptyAdviseState(),
    );
    assert.equal(state.stats.reviews, 0);
    assert.match(
      String(state.stats.last_error),
      /^review \d+: 1 of 2 reviewers of the review panel answered \(reviewer-2: .+\)/,
    );
  });
  test("a research package is never cut silently: the questions and hypotheses come first, and a cut is said", () => {
    const hypotheses = Array.from({ length: 180 }, (_, i) => ({
      id: `h-${String(i).padStart(4, "0")}`,
      text: "If the poller reads the flag before the payload, a stale row follows. ".repeat(12),
      supporting: [],
    }));
    const pkg = {
      kind: "research",
      title: "T",
      topic: "t",
      questions: [{ index: 0, text: "Q?", verified_claims: 1, claims: [] }],
      hypotheses,
      past_research: "p".repeat(200_000),
      criteria: ["c"],
      decide: { questions: [0], hypotheses: hypotheses.map((h) => h.id) },
      campaign_brief: { notes: "b" },
    };
    const whole = JSON.stringify(pkg).length;
    assert.ok(whole > 350_000);
    // A window that takes it all: nothing is cut, every hypothesis is there.
    const roomy = reviewText(pkg, 2_000_000);
    assert.doesNotMatch(roomy, /Cut to fit/);
    assert.match(roomy, /h-0179/);
    // 200,000 characters: the items to decide come before past research, so that is cut.
    const tight = reviewText(pkg, undefined);
    assert.match(
      tight,
      /\[Cut to fit: 200,000 of [\d,]+ characters\. The items to decide come first/,
    );
    assert.match(tight, /h-0179/, "the last hypothesis is shown");
    assert.ok(tight.indexOf('"criteria"') < tight.indexOf('"decide"'));
    assert.ok(tight.indexOf('"decide"') < tight.indexOf('"questions"'));
    assert.ok(tight.indexOf('"hypotheses"') < tight.indexOf('"past_research"'));
  });
  test("a reviewer that leaves out a hypothesis is asked again for it alone; its verdict's word is read in any case", async (t) => {
    const s = await waiting(t);
    const pkg = new Reviews(s.ledger).pending(["research"])[0] as unknown as {
      questions: { index: number }[];
      hypotheses: { id: string }[];
    };
    const hyp = pkg.hypotheses.map((h) => h.id);
    assert.ok(hyp.length >= 1);
    const asked: string[] = [];
    const fake = await startFakeModel((req) => {
      const said = JSON.stringify(req.messages);
      asked.push(said);
      return {
        toolCalls: [
          {
            name: "answer",
            args: said.includes("left out")
              ? {
                  pass: true,
                  reasons: "Answered.",
                  questions: [],
                  hypotheses: [
                    {
                      id: hyp[0],
                      verdict: "Undecided",
                      why: "The claims do not decide it.",
                      claims: [],
                    },
                  ],
                }
              : {
                  pass: true,
                  reasons: "Answered.",
                  questions: pkg.questions.map((q) => ({
                    index: q.index,
                    verdict: "open",
                    answer: "",
                    claims: [],
                    gaps: "a second site",
                  })),
                  hypotheses: [],
                },
          },
        ],
      };
    });
    t.after(() => fake.close());
    const rt = AdvisorsConfig.parse({ review_panel: [runtime(fake.url, "reviewer-1")] })
      .review_panel[0] as never;
    const r = await reviewOne({ runtime: rt, pkg });
    assert.ok(r.output, r.error);
    assert.equal(asked.length, 2, "asked once more");
    assert.match(asked[1] ?? "", new RegExp(`left out a verdict on hypothesis ${hyp[0]}`));
    assert.deepEqual(
      r.output.research?.hypotheses.map((h) => [h.id, h.verdict]),
      [[hyp[0], "undecided"]],
    );
    assert.equal(r.output.research?.questions.length, pkg.questions.length);
  });
  test("a review's fifth try, or any later one, posts it with each reviewer that gave no answer failing it", async (t) => {
    const s = await waiting(t);
    const answer = {
      pass: true,
      reasons: "Answered.",
      questions: [{ index: 0, verdict: "open", gaps: "a second site" }],
      hypotheses: [],
    };
    const good = await startFakeModel(() => ({ toolCalls: [{ name: "answer", args: answer }] }));
    const silent = await startFakeModel(() => ({ text: "I would rather not answer." }));
    t.after(() => good.close());
    t.after(() => silent.close());
    const cfg = config(
      s.env.service,
      AdvisorsConfig.parse({
        review_panel: [runtime(good.url, "reviewer-1"), runtime(silent.url, "reviewer-2")],
      }),
      [],
    );
    const id = Number(new Reviews(s.ledger).pending(["research"])[0]?.id);
    const key = `review:${id}`;
    const long = new Date(0).toISOString();
    // The fourth try leaves it waiting, as every try before it does.
    const fourth = await adviseOnce(cfg, {
      ...emptyAdviseState(),
      tries: { [key]: 3 },
      tried: { [key]: long },
    });
    assert.equal(fourth.stats.reviews, 0);
    assert.equal(new Reviews(s.ledger).pending(["research"]).length, 1);
    // The fifth: posted, not passed, with why.
    const fifth = await adviseOnce(cfg, { ...fourth, tried: { [key]: long } });
    assert.equal(fifth.tries[key], 5);
    assert.equal(fifth.stats.reviews, 1);
    const row = s.ledger.db
      .prepare("select panel, panel_result from review where id = ?")
      .get(id) as { panel: string; panel_result: string };
    assert.equal(row.panel_result, "review_failed");
    assert.match(
      row.panel,
      /"reasons":"This reviewer gave no answer in 5 tries, so the review is not passed: [^"]+","reviewer":"reviewer-2"/,
    );
    assert.equal(new Reviews(s.ledger).pending(["research"]).length, 0);
  });
  test("the reviewers review in parallel, and each one's answer is recorded (goal 117)", async (t) => {
    const s = await waiting(t);
    const starts: number[] = [];
    const fake = await startFakeModel(({ messages }) => {
      starts.push(Date.now());
      const prompt = userText(messages);
      const pkg = JSON.parse(prompt.slice(prompt.indexOf("{"))) as {
        decide: { questions: number[]; hypotheses: string[] };
      };
      return {
        delayMs: 400,
        toolCalls: [
          {
            name: "answer",
            args: {
              pass: true,
              reasons: "Answered.",
              questions: pkg.decide.questions.map((index) => ({
                index,
                verdict: "answered",
                certainty: "moderate",
                answer: index === 0 ? "The first run archived 42 pages." : "A clock keeps it.",
                claims: [index === 0 ? s.ids.claims.verified : s.ids.claims.clock],
              })),
              // Undecided with the claims it weighed: an end (goal 117; one citing none is not).
              hypotheses: pkg.decide.hypotheses.map((id) => ({
                id,
                verdict: "undecided",
                why: "The claims do not decide it.",
                claims: [s.ids.claims.verified],
              })),
            },
          },
        ],
      };
    });
    t.after(() => fake.close());
    const names = ["reviewer-1", "reviewer-2", "reviewer-3", "reviewer-4"];
    const state = await adviseOnce(
      config(
        s.env.service,
        AdvisorsConfig.parse({ review_panel: names.map((n) => runtime(fake.url, n)) }),
        [],
      ),
      emptyAdviseState(),
    );
    assert.equal(state.stats.reviews, 1, JSON.stringify(state.stats));
    assert.equal(starts.length, 4);
    assert.ok(
      Math.max(...starts) - Math.min(...starts) < 300,
      `the four calls started together: ${starts.map((x) => x - (starts[0] ?? 0)).join(", ")} ms`,
    );
    // Each reviewer's answers per item are an event, in the panel's order.
    const events = s.ledger.db
      .prepare("select body from event where kind = 'review_items' and subject = ? order by id")
      .all(RUN)
      .map((e) => JSON.parse(String((e as { body: string }).body)) as Record<string, unknown>);
    assert.deepEqual(
      events.map((e) => e.reviewer),
      names,
    );
    assert.deepEqual(
      ((events[0]?.items ?? []) as { kind: string; verdict: string }[]).map((x) => [
        x.kind,
        x.verdict,
      ]),
      [
        ["question", "answered"],
        ["question", "answered"],
        ["hypothesis", "undecided"],
      ],
    );
    const row = s.ledger.db
      .prepare("select panel_result, owner_decision from review where id = ?")
      .get(s.id) as { panel_result: string; owner_decision: string };
    assert.deepEqual([row.panel_result, row.owner_decision], ["review_passed", "accepted"]);
  });
});
