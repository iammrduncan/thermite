import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { describe, type TestContext, test } from "node:test";
import { advisorPackage } from "../../src/agents/roles/index.ts";
import {
  BRIEF_FILE,
  BRIEF_WHOLE_CHARS,
  briefChange,
  briefData,
  briefFile,
  briefOf,
  briefSection,
} from "../../src/core/brief.ts";
import { parseContract } from "../../src/core/contract.ts";
import { questionDetails, Scheduler } from "../../src/harness/agents/scheduler/index.ts";
import { LocalRunner } from "../../src/harness/broker/runner.ts";
import { Research } from "../../src/harness/research/research/index.ts";
import { briefText } from "../helpers/brief-text.ts";
import { startFakeModel } from "../helpers/fake-model.ts";
import { researchFixture } from "../helpers/fixtures.ts";
import { makeHarnessEnv } from "../helpers/harness-env.ts";
import { FAST_KERNEL, makeJudgeEnv } from "../helpers/judge-env.ts";

/** A campaign's brief, as New campaign sends it (goal 078). */
const NOTES = `## Background
We build **fastmat**: https://git.example.com/team/fastmat.

## What was tried
- Shared-memory tiling: no gain at batch size 1.`;
const BRIEF = {
  notes: NOTES,
  ideas: ["Fuse the dequantize step into the inner loop.", "Load 128-bit vectors."],
  hypotheses: ["The kernel is memory bound at batch size 1."],
  links: ["https://git.example.com/team/fastmat/issues/12"],
};

/**
 * A hill climb with two lanes and the brief in its contract: the planner's prompts and each
 * lane's trial briefs, as the scheduler sends them.
 */
async function hillClimb(t: TestContext, brief: Record<string, unknown> = BRIEF) {
  const env = makeJudgeEnv({ lanes: { count: 2, trials_per_epoch: 1 }, contract: brief });
  await env.start();
  const prompts: string[] = [];
  const fake = await startFakeModel(({ messages, tools }) => {
    if (!tools.some((x) => x.function.name === "submit_plan")) return { text: "done" };
    prompts.push(JSON.stringify(messages));
    return {
      toolCalls: [
        {
          name: "submit_plan",
          args: {
            add: [{ ref: "new-1", title: "fused dequantize", family: "fusion", why: "the brief" }],
            assignments: [
              { lane: "lane-1", experiment: "new-1", why: "an idea in the brief" },
              { lane: "lane-2", title: "vector loads", family: "loads" },
            ],
          },
        },
      ],
    };
  });
  t.after(() => fake.close());
  const briefs: string[] = [];
  const scheduler = new Scheduler({
    service: env.service,
    runner: new LocalRunner(env.paths.scratchDir),
    model: { baseUrl: fake.url, model: "m", apiKey: "k", contextWindow: 32000, maxTokens: 2000 },
    owner: "brief-test",
    plannerOn: () => true,
    maxConcurrent: 2,
    backoffBaseMs: 0,
    backoffMaxMs: 0,
    runTrial: async (spec) => {
      briefs.push(briefText(spec.brief));
      return { stopped: "no_submission", turns: 1, toolCalls: 0, tokensIn: 0, tokensOut: 0 };
    },
  });
  assert.ok(await scheduler.tick(), "trials started");
  await scheduler.idle();
  return { env, prompts, briefs };
}

describe("a campaign's brief (goal 078)", () => {
  test("the brief in a contract: whole for the planner and the advisors, whole or cut with a pointer for a worker", () => {
    assert.equal(briefOf({ notes: "  \n", ideas: [" "], hypotheses: [] }), undefined);
    assert.deepEqual(briefOf({ notes: "\n\n  indented\nnext\n\n", ideas: [" a "] }), {
      notes: "  indented\nnext",
      links: [],
      ideas: ["a"],
      hypotheses: [],
    });
    // The starting links: a hill climb's links, a research contract's seeds.
    assert.deepEqual(briefOf({ links: ["https://a.example.com"] })?.links, [
      "https://a.example.com",
    ]);
    assert.deepEqual(briefOf({ mode: "research", seeds: ["https://b.example.com"] })?.links, [
      "https://b.example.com",
    ]);
    assert.deepEqual(briefData({ links: ["https://a.example.com"] })?.starting_links, [
      "https://a.example.com",
    ]);
    assert.deepEqual(
      briefChange({ mode: "research", seeds: ["https://x.example.com"] }, { links: [] }),
      { mode: "research" },
    );
    const data = briefData(BRIEF);
    assert.equal(data?.additional_information, NOTES);
    assert.deepEqual(data?.ideas_to_try, BRIEF.ideas);
    assert.deepEqual(data?.hypotheses, BRIEF.hypotheses);
    assert.match(String(data?.note), /starting points to weigh, not rules/);
    // A worker's section: whole when it fits.
    const whole = briefSection(BRIEF, "/scratch/research/r-1/BRIEF.md") ?? "";
    assert.ok(whole.includes(NOTES));
    assert.match(whole, /## Ideas to try\n\n1\. Fuse the dequantize step/);
    assert.match(whole, /## Hypotheses\n\n1\. The kernel is memory bound/);
    assert.doesNotMatch(whole, /Cut to/);
    // Longer than a worker's brief carries: its start, and where the whole text is.
    const long = { notes: `${"x".repeat(BRIEF_WHOLE_CHARS)}THE END` };
    const cut = briefSection(long, "/scratch/research/r-1/BRIEF.md") ?? "";
    // "## Additional information\n\n" (27 characters), the text (32,000) and "THE END" (7).
    assert.ok(
      cut.includes(
        "[Cut to its first 32,000 of 32,034 characters. The whole brief is in /scratch/research/r-1/BRIEF.md: read the rest there.]",
      ),
      cut.slice(0, 400),
    );
    assert.doesNotMatch(cut, /THE END/);
    assert.match(String(briefFile(long)), /THE END/);
    assert.match(String(briefData(long)?.additional_information), /THE END/);
    // A research brief says what its hypotheses are.
    assert.match(
      String(briefFile({ mode: "research", hypotheses: ["h"] })),
      /The run started with these as its hypotheses/,
    );
    // Parts given replace the contract's; an empty part removes it; ideas are not for research.
    assert.deepEqual(briefChange({ mode: "goal", notes: "old", ideas: ["a"] }, { notes: "" }), {
      mode: "goal",
      ideas: ["a"],
    });
    assert.deepEqual(
      briefChange({ mode: "goal", ideas: ["a"] }, { ideas: [" b ", ""], hypotheses: [] }),
      { mode: "goal", ideas: ["b"] },
    );
    assert.match(
      String(briefChange({ mode: "research" }, { ideas: ["a"] })),
      /Ideas to try are for hill-climb and goal campaigns/,
    );
  });

  test("a hill climb: the planner's prompt has the whole brief, each trial's brief has it, and BRIEF.md keeps it", async (t) => {
    const x = await hillClimb(t);
    const prompt = x.prompts[0] ?? "";
    assert.ok(prompt.includes("campaign_brief"), "the planner's context names it");
    // The prompt is JSON in JSON: the brief's text as the planner reads it.
    assert.ok(prompt.includes("We build **fastmat**"), "its additional information");
    assert.ok(prompt.includes("Fuse the dequantize step into the inner loop."), "its ideas");
    assert.ok(prompt.includes("The kernel is memory bound at batch size 1."), "its hypotheses");
    assert.match(prompt, /campaign_brief, when there is one, comes from the campaign's author/);
    assert.equal(x.briefs.length, 2, "both lanes started a trial");
    for (const b of x.briefs) {
      assert.match(b, /# The campaign's brief\nFrom the campaign's author: starting points/);
      assert.ok(b.includes(NOTES), "the additional information, whole");
      assert.match(b, /## Ideas to try\n\n1\. Fuse the dequantize step into the inner loop\./);
      assert.match(b, /## Hypotheses\n\n1\. The kernel is memory bound at batch size 1\./);
      assert.match(
        b,
        /## Starting links\n\nNothing fetched these yet: fetch one when you need it, and the harness archives it\.\n\n- https:\/\/git\.example\.com\/team\/fastmat\/issues\/12/,
      );
      assert.doesNotMatch(b, /Notes from the campaign's author/);
    }
    const file = join(x.env.service.knowledge.folder("js-1"), BRIEF_FILE);
    assert.ok(existsSync(file), "the run's folder has BRIEF.md");
    assert.ok(readFileSync(file, "utf8").includes(NOTES));
  });

  test("a brief longer than a worker's brief carries: cut there, with where the whole text is; the planner gets all of it", async (t) => {
    const notes = `${"Background line.\n".repeat(2500)}The last line of the brief.`;
    const x = await hillClimb(t, { notes });
    const file = join(x.env.service.knowledge.folder("js-1"), BRIEF_FILE);
    for (const b of x.briefs) {
      assert.ok(b.includes(`The whole brief is in ${file}: read the rest there.`), b.slice(0, 600));
      assert.doesNotMatch(b, /The last line of the brief\./);
    }
    assert.match(readFileSync(file, "utf8"), /The last line of the brief\./);
    assert.ok((x.prompts[0] ?? "").includes("The last line of the brief."), "the planner, whole");
  });

  test("a contract without a brief: no section, no BRIEF.md", async (t) => {
    const x = await hillClimb(t, {});
    assert.ok(x.briefs.length > 0);
    for (const b of x.briefs) assert.doesNotMatch(b, /# The campaign's brief/);
    assert.doesNotMatch(x.prompts[0] ?? "", /campaign_brief\\"/);
    assert.ok(!existsSync(join(x.env.service.knowledge.folder("js-1"), BRIEF_FILE)));
  });

  test("a research run: its hypotheses are the run's first, its starting links are archived when it starts, and each research trial's brief has the brief and the questions whole", async (t) => {
    // A tiny web for the starting links: one page, and one that is not there.
    const server = createServer((req, res) =>
      req.url === "/start.html"
        ? void res
            .writeHead(200, { "content-type": "text/html" })
            .end(
              "<html><head><title>Start</title></head><body><p>A page to start from.</p></body></html>",
            )
        : void res.writeHead(404).end("no"),
    );
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    t.after(() => server.close());
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const env = makeHarnessEnv("rig-r");
    const question =
      "Which harness designs keep agents productive for days?\nFor each: who built it and what it reports.";
    const parsed = parseContract({
      ...researchFixture,
      questions: [question, "What fails?"],
      seeds: [`${base}/start.html`, "http://127.0.0.1:1/gone.html"],
      notes: NOTES,
      hypotheses: [
        "Fresh workers lose nothing that matters.",
        "Long contexts hurt more than they help.",
      ],
    });
    assert.ok(parsed.ok, parsed.ok ? "" : parsed.errors.join("; "));
    if (!parsed.ok) return;
    const out = await env.service.applyCommand(
      env.sign("assign_campaign", {
        run: "r-1",
        contract: parsed.contract,
        contract_sha: parsed.sha,
        imports: [],
      }),
    );
    assert.ok(out.status === "applied" && out.accepted, JSON.stringify(out));
    // The starting hypotheses: the run's own, with no lane, no supporting claim, and their events.
    const rows = env.service.ledger.db
      .prepare("select lane, text, supporting from hypothesis where run = 'r-1' order by rowid")
      .all() as { lane: string | null; text: string; supporting: string }[];
    assert.deepEqual(
      rows.map((r) => [r.lane, r.text, r.supporting]),
      [
        [null, "Fresh workers lose nothing that matters.", "[]"],
        [null, "Long contexts hurt more than they help.", "[]"],
      ],
    );
    const events = env.service.ledger.db
      .prepare("select body from event where kind = 'hypothesis_added' order by id")
      .all() as { body: string }[];
    assert.deepEqual(
      events.map((e) => (JSON.parse(e.body) as { from: string; text: string }).from),
      ["brief", "brief"],
    );
    const fake = await startFakeModel(() => ({ text: "done" }));
    t.after(() => fake.close());
    const research = new Research(env.service.ledger, env.service.paths.stateDir, {
      allowPrivate: true,
    });
    const briefs: string[] = [];
    const scheduler = new Scheduler({
      service: env.service,
      runner: new LocalRunner(env.service.paths.scratchDir),
      model: { baseUrl: fake.url, model: "m", apiKey: "k", contextWindow: 32000, maxTokens: 2000 },
      owner: "brief-test",
      research,
      runTrial: async () => ({
        stopped: "error",
        turns: 0,
        toolCalls: 0,
        tokensIn: 0,
        tokensOut: 0,
      }),
      runResearchTrial: async (spec) => {
        briefs.push(briefText(spec.brief));
        return { stopped: "no_submission", turns: 1, toolCalls: 0, tokensIn: 0, tokensOut: 0 };
      },
    });
    await scheduler.tick();
    await scheduler.idle();
    // The harness archived the starting links, beside the first trials, and said so in Live.
    const deadline = Date.now() + 10_000;
    const said = () =>
      env.service.live.since(0, 1000).entries.find((e) => e.text.startsWith("starting links:"))
        ?.text;
    while (!said() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    assert.match(
      String(said()),
      /^starting links: 1 of 2 archived; not archived: http:\/\/127\.0\.0\.1:1\/gone\.html \(/,
    );
    const sources = env.service.ledger.db
      .prepare("select url, fetched_by from source where run = 'r-1'")
      .all() as { url: string; fetched_by: string }[];
    assert.deepEqual(
      sources.map((x) => [x.url, x.fetched_by]),
      [[`${base}/start.html`, "research"]],
    );
    assert.ok(briefs.length >= 1, "a research trial started");
    const b = briefs[0] ?? "";
    // The question whole, its second line under it.
    assert.ok(
      b.includes(
        "Question 1 (index 0): Which harness designs keep agents productive for days?\n   For each: who built it and what it reports.",
      ),
      b.slice(0, 800),
    );
    assert.ok(b.includes(NOTES), "the additional information");
    assert.match(b, /The run started with these as its hypotheses \(hypotheses\/\)\./);
    assert.match(b, /1\. Fresh workers lose nothing that matters\./);
    assert.match(b, /Look for sources for and against its hypotheses\./);
    // Its starting links are in the brief, with what the harness does with them.
    assert.match(
      b,
      /## Starting links\n\nThe harness fetches and archives these when the run starts: read them under sources\/\.\n\n- http:\/\/127\.0\.0\.1:\d+\/start\.html\n- http:\/\/127\.0\.0\.1:1\/gone\.html/,
    );
    assert.doesNotMatch(b, /Starting URLs:/);
    assert.ok(existsSync(join(env.service.knowledge.folder("r-1"), BRIEF_FILE)));
  });

  test("a question longer than an experiment's details: the research task is cut, and says where the whole question is", () => {
    const short = questionDetails(2, "What fails?");
    assert.equal(short, "Question 3 (index 2): What fails?");
    const long = questionDetails(0, "q".repeat(5000));
    assert.equal(long.length, 4000);
    assert.match(long, / … \(cut: the whole question is under Questions in your brief\)$/);
  });

  test("the advisors: the teachers' brief, the auditor's and the review panel's packages carry the brief whole, ahead of the long parts", async () => {
    const env = makeJudgeEnv({
      contract: {
        ...BRIEF,
        acceptance: {
          looks: [3, 6],
          confirm_blocks: 4,
          audit: { ratio_to_median: 3, absolute: 0.15 },
        },
      },
    });
    await env.start();
    const brief = env.service.brief("js-1") as Record<string, unknown>;
    assert.deepEqual(brief.campaign_brief, briefData(BRIEF));
    const keys = Object.keys(brief);
    assert.ok(keys.indexOf("campaign_brief") < keys.indexOf("evidence"), "before the evidence");
    const id = (
      await env.service.submitAttempt(
        { run: "js-1", patch_base64: env.patch(FAST_KERNEL), hypothesis: "h", known_flaws: [] },
        "t",
      )
    ).attempt;
    await env.drain();
    assert.equal(String(env.ledger.attempts.get(id)?.lifecycle), "awaiting_audit");
    const pkg = (await env.service.auditPackages())[0] as unknown as Record<string, unknown>;
    assert.deepEqual(pkg.campaign_brief, briefData(BRIEF));
    // In the auditor's prompt, before the diff: a package cut to the window loses the diff first.
    const prompt = advisorPackage("Audit package (untrusted data):", pkg, 200_000);
    assert.ok(prompt.indexOf('"campaign_brief"') < prompt.indexOf('"diff"'));
    assert.ok(prompt.includes(JSON.stringify(NOTES)), "whole");
  });

  test("the review panel's package carries the brief before the diff", async () => {
    const env = makeJudgeEnv({ goal: { opsPerSecond: 1e12 }, contract: BRIEF });
    await env.start();
    await env.drain();
    const pkg = env.service.reviewPackages()[0] as Record<string, unknown> | undefined;
    assert.ok(pkg, "a review waits for the panel");
    assert.deepEqual(pkg.campaign_brief, briefData(BRIEF));
    const keys = Object.keys(pkg);
    assert.ok(keys.indexOf("campaign_brief") < keys.indexOf("diff"));
  });
});
