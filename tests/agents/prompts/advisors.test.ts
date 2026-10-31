import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { researchPackage, researchReviewDue } from "../../../src/harness/research/review/index.ts";
import { Reviews } from "../../../src/harness/reviews.ts";
import { FAST_KERNEL, makeJudgeEnv } from "../../helpers/judge-env.ts";
import { cardsUpToDate, seedClaims, seedSources } from "../../helpers/research-cards.ts";
import { answeredResearchRun } from "../../helpers/research-paper.ts";
import { fillResearch, makeResearchRun, writeCards } from "../../helpers/research-run.ts";
import { adviseRound, golden, kept, recorder, sections, teachersScript } from "./capture.ts";

/**
 * The advisors' whole prompts: the teachers, their merged by model, the auditor, the reviewers, the
 * synthesizer and the final writer (goal 166).
 */
describe("every role's whole prompt for a sample run (goal 166)", () => {
  test("a hill-climb run's two teachers and their merged by model, in Pi", async () => {
    const env = makeJudgeEnv({
      contract: {
        notes: "The kernel sums an array of numbers. Keep its exported function's name.",
      },
    });
    await env.service.applyCommand(env.assign);
    const run = (env.assign.envelope.payload as { run: string }).run;
    await env.service.applyCommand(
      env.sign("message_agent", { run, to: "teachers", text: "Look at memory traffic first." }),
    );
    const { sent, script } = recorder(teachersScript);
    const keys = await adviseRound(env, script, (runtime) => ({
      teachers: [runtime("teacher-a"), runtime("teacher-b")],
      merged_by: runtime("merged-by"),
    }));
    const paths = [env.paths.scratchDir, env.paths.stateDir, env.root, keys, tmpdir()];
    golden("teacher.pi", sent.get("teacher"), paths);
    golden("merged-by.pi", sent.get("merged-by"), paths);
    kept(env.service.ledger, "teacher", sent.get("teacher"));
    kept(env.service.ledger, "merged-by", sent.get("merged-by"));
  });

  test("a hill-climb run's auditor, in Pi, on a win that asks for an audit", async () => {
    const env = makeJudgeEnv({
      contract: {
        notes: "The kernel sums an array of numbers. Keep its exported function's name.",
        acceptance: {
          looks: [3, 6],
          confirm_blocks: 4,
          audit: { ratio_to_median: 3, absolute: 0.15 },
        },
      },
    });
    await env.service.applyCommand(env.assign);
    const { attempt } = await env.service.submitAttempt(
      {
        run: "js-1",
        patch_base64: env.patch(FAST_KERNEL),
        hypothesis: "drop the waste",
        known_flaws: [],
      },
      "t",
    );
    await env.drain();
    assert.equal(String(env.ledger.attempts.get(attempt)?.lifecycle), "awaiting_audit");
    const { sent, script } = recorder(() => ({
      toolCalls: [
        { name: "answer", args: { decision: "needs_owner", reasons: "unsure", citations: [] } },
      ],
    }));
    const keys = await adviseRound(env, script, (runtime) => ({ auditor: runtime("auditor") }));
    const paths = [env.paths.scratchDir, env.paths.stateDir, env.root, keys, tmpdir()];
    golden("auditor.pi", sent.get("auditor"), paths);
    kept(env.service.ledger, "auditor", sent.get("auditor"));
  });

  test("a research run's two teachers and their merged by model, in Pi", async () => {
    const r = await makeResearchRun("r-1", {
      contract: { notes: "Weigh the sources that measured more than one campaign." },
    });
    await r.env.service.applyCommand(
      r.env.sign("message_agent", { run: r.run, to: "teachers", text: "Find primary sources." }),
    );
    const { sent, script } = recorder(teachersScript);
    const keys = await adviseRound(r.env, script, (runtime) => ({
      teachers: [runtime("teacher-a"), runtime("teacher-b")],
      merged_by: runtime("merged-by"),
    }));
    await r.close();
    const { stateDir, scratchDir } = r.env.service.paths;
    const paths = [scratchDir, stateDir, r.env.root, r.base, keys, tmpdir()];
    golden("research-teacher.pi", sent.get("research-teacher"), paths);
    golden("research-merged-by.pi", sent.get("research-merged-by"), paths);
    kept(r.env.service.ledger, "research-teacher", sent.get("research-teacher"));
    kept(r.env.service.ledger, "research-merged-by", sent.get("research-merged-by"));
  });

  test("a research run's synthesizer, in Pi, with verified claims to write cards from", async () => {
    const r = await makeResearchRun("r-1");
    const ledger = r.env.service.ledger;
    const sources = [...seedSources(ledger, "r-1").values()];
    const from = Date.now() - 24 * 3_600_000;
    for (const [question, tag] of [
      [0, "qa"],
      [1, "qb"],
    ] as const)
      seedClaims(ledger, "r-1", { question, n: 3, sources, from, tag });
    // Every role answers in words: only the first request of each is kept.
    const { sent, script } = recorder(() => ({ text: "done" }));
    const keys = await adviseRound(r.env, script, (runtime) => ({
      teachers: [runtime("teacher-1")],
    }));
    await r.close();
    const { stateDir, scratchDir } = r.env.service.paths;
    const paths = [scratchDir, stateDir, r.env.root, r.base, keys, tmpdir()];
    golden("synthesizer.pi", sent.get("synthesizer"), paths);
    kept(r.env.service.ledger, "synthesizer", sent.get("synthesizer"));
  });

  test("a goal run's reviewer, in Pi, on a goal the review panel checks", async () => {
    const env = makeJudgeEnv({
      goal: { opsPerSecond: 1e12 },
      contract: {
        notes: "The kernel sums an array of numbers. Keep its exported function's name.",
      },
    });
    await env.start();
    await env.drain();
    assert.ok(env.service.reviewPackages()[0], "a review waits for the panel");
    const { sent, script } = recorder(() => ({ text: "done" }));
    const keys = await adviseRound(env, script, (runtime) => ({
      review_panel: [runtime("reviewer-1"), runtime("reviewer-2")],
    }));
    const paths = [env.paths.scratchDir, env.paths.stateDir, env.root, keys, tmpdir()];
    golden("reviewer.pi", sent.get("reviewer"), paths);
    kept(env.service.ledger, "reviewer", sent.get("reviewer"));
  });

  test("a research run's reviewer, in Pi, once its review is due", async () => {
    const r = await makeResearchRun("r-1");
    const ids = await fillResearch(r);
    writeCards(r, ids);
    const ledger = r.env.service.ledger;
    ledger.db
      .prepare("update run set created_at = ? where id = ?")
      .run(new Date(Date.now() - 3 * 3_600_000).toISOString(), "r-1");
    const contract = r.env.service.contractFor("r-1") as Parameters<typeof researchPackage>[2];
    const due = researchReviewDue(ledger, "r-1", contract, r.research.clock("r-1"));
    assert.ok(due.due);
    new Reviews(ledger).requestResearch({
      run: "r-1",
      marker: due.marker,
      pkg: researchPackage(ledger, "r-1", contract),
      by: "s",
    });
    cardsUpToDate(r.env.service, "r-1");
    const { sent, script } = recorder(() => ({ text: "done" }));
    const keys = await adviseRound(r.env, script, (runtime) => ({
      review_panel: [runtime("reviewer-1"), runtime("reviewer-2")],
    }));
    await r.close();
    const { stateDir, scratchDir } = r.env.service.paths;
    const paths = [scratchDir, stateDir, r.env.root, r.base, keys, tmpdir()];
    golden("research-reviewer.pi", sent.get("research-reviewer"), paths);
    kept(r.env.service.ledger, "research-reviewer", sent.get("research-reviewer"));
  });

  test("a research run's final writer, in Pi, once its review passed, with no STE checker", async () => {
    const s = await answeredResearchRun("r-1");
    await s.env.service.setAdvisors(
      { auditor: false, review_panel: 0, writer: true },
      "supervisor",
    );
    assert.ok(s.env.service.papers.request("r-1", "s"));
    cardsUpToDate(s.env.service, "r-1");
    const { sent, script } = recorder(() => ({ text: "done" }));
    const keys = await adviseRound(s.env, script, (runtime) => ({
      teachers: [runtime("teacher-1")],
    }));
    await s.close();
    const { stateDir, scratchDir } = s.env.service.paths;
    const paths = [scratchDir, stateDir, s.env.root, s.base, keys, tmpdir()];
    golden("final-writer.pi", sent.get("final-writer"), paths);
    kept(s.env.service.ledger, "final-writer", sent.get("final-writer"));
  });

  test("a hill-climb run's teacher as a command: what every advisor run as a program is given", async () => {
    const env = makeJudgeEnv({
      contract: {
        notes: "The kernel sums an array of numbers. Keep its exported function's name.",
      },
    });
    await env.service.applyCommand(env.assign);
    // The command keeps its standard input and answers as a teacher.
    const dir = mkdtempSync(join(tmpdir(), "thermite-prompts-cli-"));
    const kept = join(dir, "stdin.txt");
    const script = join(dir, "teacher.mjs");
    writeFileSync(
      script,
      `import { writeFileSync } from "node:fs";
let input = "";
process.stdin.on("data", (d) => { input += d; });
process.stdin.on("end", () => {
  writeFileSync(${JSON.stringify(kept)}, input);
  console.log(JSON.stringify({ summary: "s", recommendations: [] }));
});
`,
    );
    const { script: none } = recorder(() => ({ text: "done" }));
    await adviseRound(env, none, () => ({
      teachers: [
        { name: "cli-teacher", runtime: "cli", argv: [process.execPath, script], restricted: true },
      ],
    }));
    sections(
      "teacher.program",
      [env.paths.scratchDir, env.paths.stateDir, env.root, dir, tmpdir()],
      [["standard input", readFileSync(kept, "utf8")]],
    );
  });
});
