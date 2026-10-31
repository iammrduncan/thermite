import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, type TestContext, test } from "node:test";
import { advisorPackage } from "../../../../src/agents/roles/index.ts";
import { signEnvelope } from "../../../../src/core/commands.ts";
import { createHarnessApi } from "../../../../src/harness/api/index.ts";
import {
  AdvisorsConfig,
  AuditAnswer,
  PanelAnswer,
  TeacherReview,
} from "../../../../src/supervisor/advisors/index.ts";
import {
  type AdviseConfig,
  adviseOnce,
  emptyAdviseState,
  teachersCalled,
} from "../../../../src/supervisor/advisors/pass/index.ts";
import { startFakeModel } from "../../../helpers/fake-model.ts";
import { FAST_KERNEL, makeJudgeEnv } from "../../../helpers/judge-env.ts";

const tokens = { supervisor: "sup-token", proposer: "prop-token" };
type Env = ReturnType<typeof makeJudgeEnv>;

function harnessFetch(env: Env): typeof fetch {
  const api = createHarnessApi(env.service, tokens);
  return async (input, init) => {
    const url = new URL(String(input));
    return api.request(`${url.pathname}${url.search}`, init as RequestInit);
  };
}

function keyFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "thermite-adv-"));
  writeFileSync(join(dir, "key"), "test-key\n");
  return join(dir, "key");
}

/** The owner's message, as control signs it. */
async function ownerSays(env: Env, to: string, text: string) {
  const out = await env.service.applyCommand(
    signEnvelope(
      {
        v: 1,
        id: randomUUID(),
        rig: "rig-a",
        kind: "message_agent",
        issued_by: "owner",
        issued_at: new Date(Date.now() - 1000).toISOString(),
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        payload: { run: "js-1", to, text },
      },
      env.keys.privateKeyPem,
    ),
  );
  assert.ok(out.status === "applied" && out.accepted, JSON.stringify(out));
}

const bodies = (env: Env, kind: string) =>
  env.ledger
    .eventsAfter(0, 5000)
    .events.filter((e) => e.kind === kind)
    .map((e) => e.body as Record<string, unknown>);

function config(env: Env, advisors: AdvisorsConfig, lines: string[]): AdviseConfig {
  return {
    harnessUrl: "http://harness",
    harnessToken: tokens.supervisor,
    home: mkdtempSync(join(tmpdir(), "thermite-sup-")),
    advisors,
    fetchImpl: harnessFetch(env),
    live: (l) => lines.push(`${l.run ?? "-"} ${l.kind}: ${l.text}`),
  };
}

const runtime = (url: string, name: string) => ({
  name,
  runtime: "openai",
  base_url: url,
  model: name,
  api_key_file: keyFile(),
});

describe("the owner's messages to the advisors", () => {
  test("an advisor's answers are optional and lenient: a long one is shortened, never a reason to lose its audit", () => {
    const long = "x".repeat(5000);
    const audit = AuditAnswer.parse({
      decision: "clear",
      reasons: "fine",
      answers: [{ message: "3", text: `  ${long}  ` }],
    });
    assert.deepEqual(
      audit.answers.map((a) => [a.message, a.text.length]),
      [[3, 1000]],
    );
    assert.deepEqual(PanelAnswer.parse({ pass: true, reasons: "ok" }).answers, []);
    assert.deepEqual(TeacherReview.parse({ summary: "s", recommendations: [] }).answers, []);
    // Answers that cannot be read are left out; the audit stands.
    const garbled = AuditAnswer.safeParse({
      decision: "block",
      reasons: "r",
      answers: [{ text: "no id" }],
    });
    assert.ok(garbled.success);
    assert.deepEqual(garbled.data?.answers, []);
    assert.equal(garbled.data?.decision, "block");
    // One answer that cannot be read never loses the others.
    const mixed = AuditAnswer.parse({
      decision: "clear",
      reasons: "r",
      answers: [
        { text: "no id" },
        { message: 2, text: "Noted.", extra: 1 },
        { message: 4, text: " " },
      ],
    });
    assert.deepEqual(
      mixed.answers.map((a) => [a.message, a.text]),
      [[2, "Noted."]],
    );
  });

  test("an advisor's prompt puts the owner's messages first and never cuts them", () => {
    const owner_messages = [{ id: 1, text: "keep the API stable" }];
    const p = advisorPackage(
      "Audit package:",
      { diff: "x".repeat(300_000), owner_messages },
      200_000,
    );
    // The cut is said (goal 117).
    const said = `[Cut to fit the prompt's limit: 200,000 of ${JSON.stringify({ owner_messages, diff: "x".repeat(300_000) }).length.toLocaleString("en-US")} characters.]\n`;
    assert.ok(
      p.startsWith(
        `Audit package:\n${said}{"owner_messages":[{"id":1,"text":"keep the API stable"}],"diff":"xxx`,
      ),
    );
    assert.equal(p.length, "Audit package:\n".length + said.length + 200_000);
    // Messages longer than the cut are kept whole, with a little of the rest.
    const big = [{ id: 2, text: "y".repeat(5000) }];
    assert.match(
      advisorPackage("B:", { diff: "z".repeat(9000), owner_messages: big }, 1000),
      /y{5000}"\}\],"diff":"z/,
    );
    assert.equal(
      advisorPackage("B:", { a: 1 }, 3),
      "B:\n[Cut to fit the prompt's limit: 3 of 7 characters.]\n{\"a",
    );
  });

  test("at the day's spending limit, a message to the teachers starts no round, and says so once", async () => {
    const env = makeJudgeEnv();
    await env.service.applyCommand(env.assign);
    await ownerSays(env, "teachers", "look at the paper");
    const advisors = AdvisorsConfig.parse({
      teachers: [runtime("http://127.0.0.1:9", "teacher-a")],
      max_usd_per_day: 1,
    });
    const state = {
      ...emptyAdviseState(),
      spend: { day: new Date().toISOString().slice(0, 10), usd: 1 },
    };
    const cfg = config(env, advisors, []);
    assert.equal(await teachersCalled({ ...cfg, advisors }, state), false);
    assert.equal(
      await teachersCalled({ ...cfg, advisors }, emptyAdviseState()),
      true,
      "under the limit",
    );
    const lines: string[] = [];
    let next = await adviseOnce(config(env, advisors, lines), state);
    next = await adviseOnce(config(env, advisors, lines), next);
    assert.equal(next.stats.teacher_runs, 0);
    assert.deepEqual(lines, [
      "js-1 status: the advisors reached the day's spending limit (1 USD): the teachers read your message after midnight UTC",
    ]);
    assert.deepEqual(bodies(env, "agent_message_read"), [], "not read: it waits");
  });

  test("a new message to the teachers starts their round at once; each teacher answers it, the harness records the reads and answers, and every step is a live line", async (t: TestContext) => {
    const env = makeJudgeEnv();
    await env.service.applyCommand(env.assign);
    const fake = await startFakeModel(({ messages }) => {
      const all = JSON.stringify(messages);
      if (all.includes("You merge the advice of two teachers"))
        return {
          toolCalls: [
            {
              name: "answer",
              args: {
                directives: [
                  {
                    kind: "mandate",
                    family: "tiling",
                    rationale: "both reviews cite the paper",
                    citations: ["arxiv:1"],
                  },
                ],
              },
            },
          ],
        };
      // A teacher: it answers the owner's message when its brief has one to answer.
      const asked = all.includes('\\"read\\":false');
      return {
        toolCalls: [
          {
            name: "answer",
            args: {
              summary: "tiling looks promising",
              recommendations: [
                { kind: "try", family: "tiling", rationale: "paper", citations: ["arxiv:1"] },
              ],
              ...(asked ? { answers: [{ message: 1, text: "We will weigh the paper." }] } : {}),
            },
          },
        ],
      };
    });
    t.after(() => fake.close());
    const advisors = AdvisorsConfig.parse({
      teachers: [runtime(fake.url, "teacher-a"), runtime(fake.url, "teacher-b")],
      merged_by: runtime(fake.url, "merged-by"),
    });
    const lines: string[] = [];
    const cfg = config(env, advisors, lines);
    let state = await adviseOnce(cfg, emptyAdviseState());
    assert.equal(state.stats.teacher_runs, 1);
    assert.equal(await teachersCalled(cfg, state), false);
    // Within the hour, nothing; a message from the owner calls the teachers at once.
    state = await adviseOnce(cfg, state);
    assert.equal(state.stats.teacher_runs, 1);
    await ownerSays(env, "teachers", "read the tiling paper first");
    assert.equal(await teachersCalled(cfg, state), true);
    state = await adviseOnce(cfg, state);
    assert.equal(state.stats.teacher_runs, 2);
    assert.equal(await teachersCalled(cfg, state), false, "one round per message");
    state = await adviseOnce(cfg, state);
    assert.equal(state.stats.teacher_runs, 2);
    assert.deepEqual(
      bodies(env, "agent_message_read").map((b) => [b.message, b.by]),
      [[1, "teachers"]],
    );
    assert.deepEqual(bodies(env, "advisor_answer"), [
      { message: 1, role: "teachers", text: "We will weigh the paper.", advisor: "teacher-a" },
      { message: 1, role: "teachers", text: "We will weigh the paper.", advisor: "teacher-b" },
    ]);
    const text = lines.join("\n");
    assert.match(text, /js-1 status: the teachers review js-1 now: the owner wrote to them/);
    assert.match(
      text,
      /js-1 text: teacher teacher-a: tiling looks promising Suggests: try tiling\./,
    );
    assert.match(
      text,
      /js-1 text: directives for the planner: mandate tiling \(why: both reviews cite the paper\)/,
    );
    assert.ok(
      env.service.live
        .since(0, 5000)
        .entries.some(
          (e) =>
            e.text ===
            "the teachers (teacher-b) answered the owner's message #1: We will weigh the paper.",
        ),
    );
  });

  test("the auditor finds the owner's message in its package and answers it; its audit is posted as before", async () => {
    const env = makeJudgeEnv({
      contract: {
        acceptance: {
          looks: [3, 6],
          confirm_blocks: 4,
          audit: { ratio_to_median: 3, absolute: 0.15 },
        },
      },
    });
    await env.service.applyCommand(env.assign);
    const id = (
      await env.service.submitAttempt(
        { run: "js-1", patch_base64: env.patch(FAST_KERNEL), hypothesis: "h", known_flaws: [] },
        "t",
      )
    ).attempt;
    await env.drain();
    assert.equal(String(env.ledger.attempts.get(id)?.lifecycle), "awaiting_audit");
    await ownerSays(env, "auditor", "be strict about timing changes");
    // A command-line auditor: it is told the answer's shape and finds the message in its input.
    const dir = mkdtempSync(join(tmpdir(), "thermite-cli-"));
    const script = join(dir, "auditor.mjs");
    writeFileSync(
      script,
      `let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const told=s.includes("be strict about timing changes")&&s.includes('"answers"');console.log(JSON.stringify({decision:"block",reasons:"the inner loop was removed",citations:["diff"],answers:told?[{message:1,text:"Noted: I checked the timing code."}]:[]}));});`,
    );
    const advisors = AdvisorsConfig.parse({
      auditor: {
        name: "cli-auditor",
        runtime: "cli",
        argv: [process.execPath, script],
        restricted: true,
      },
    });
    const lines: string[] = [];
    const state = await adviseOnce(config(env, advisors, lines), emptyAdviseState());
    assert.equal(state.stats.audits, 1, JSON.stringify(state.stats));
    assert.equal(String(env.ledger.attempts.get(id)?.lifecycle), "audit_blocked");
    assert.deepEqual(bodies(env, "advisor_answer"), [
      {
        message: 1,
        role: "auditor",
        text: "Noted: I checked the timing code.",
        advisor: "cli-auditor",
      },
    ]);
    assert.match(
      lines.join("\n"),
      new RegExp(
        `js-1 text: audit of ${id} \\(try 1\\): block, blocked\\. the inner loop was removed`,
      ),
    );
    // Read once: the next package carries it no more.
    const pending = (await env.service.auditPackages())[0];
    assert.deepEqual(pending?.owner_messages ?? [], []);
  });

  test("each reviewer of the review panel answers the owner's message; its results are posted without the answers", async (t: TestContext) => {
    const env = makeJudgeEnv({ goal: { opsPerSecond: 1e12 } });
    await env.service.applyCommand(env.assign);
    await env.drain();
    await ownerSays(env, "review_panel", "judge readability strictly");
    const fake = await startFakeModel(({ messages }) => ({
      toolCalls: [
        {
          name: "answer",
          args: {
            pass: true,
            reasons: "clear and small",
            ...(JSON.stringify(messages).includes("judge readability strictly")
              ? { answers: [{ message: 1, text: "Strictly judged." }] }
              : {}),
          },
        },
      ],
    }));
    t.after(() => fake.close());
    const advisors = AdvisorsConfig.parse({
      review_panel: [runtime(fake.url, "reviewer-1"), runtime(fake.url, "reviewer-2")],
    });
    const lines: string[] = [];
    const state = await adviseOnce(config(env, advisors, lines), emptyAdviseState());
    assert.equal(state.stats.reviews, 1, JSON.stringify(state.stats));
    const r = env.ledger.db.prepare("select panel_result from review").get();
    assert.equal(r?.panel_result, "review_passed");
    assert.deepEqual(
      bodies(env, "advisor_answer").map((b) => [b.role, b.advisor, b.text]),
      [
        ["review_panel", "reviewer-1", "Strictly judged."],
        ["review_panel", "reviewer-2", "Strictly judged."],
      ],
    );
    assert.match(lines.join("\n"), /review 1 of goal readable, reviewer-1: pass\. clear and small/);
    assert.match(
      lines.join("\n"),
      /review 1: the review panel passed it, and it was accepted \(the run does not ask the owner\)/,
    );
  });

  test("a panel that cannot post its review leaves the owner's message for the retry", async (t: TestContext) => {
    const env = makeJudgeEnv({ goal: { opsPerSecond: 1e12 } });
    await env.service.applyCommand(env.assign);
    await env.drain();
    await ownerSays(env, "review_panel", "judge readability strictly");
    const pass = (messages: unknown) => ({
      toolCalls: [
        {
          name: "answer",
          args: {
            pass: true,
            reasons: "fine",
            ...(JSON.stringify(messages).includes("judge readability strictly")
              ? { answers: [{ message: 1, text: "Strictly judged." }] }
              : {}),
          },
        },
      ],
    });
    let down = true;
    const one = await startFakeModel(({ messages }) => pass(messages));
    const two = await startFakeModel(({ messages }) => (down ? { fail: 400 } : pass(messages)));
    t.after(() => one.close());
    t.after(() => two.close());
    const advisors = AdvisorsConfig.parse({
      review_panel: [runtime(one.url, "reviewer-1"), runtime(two.url, "reviewer-2")],
    });
    const cfg = { ...config(env, advisors, []), retryMs: 0 };
    let state = await adviseOnce(cfg, emptyAdviseState());
    assert.equal(state.stats.reviews, 0, "one reviewer did not answer");
    assert.deepEqual(bodies(env, "agent_message_read"), [], "not read without a posted review");
    down = false;
    state = await adviseOnce(cfg, state);
    assert.equal(state.stats.reviews, 1);
    assert.deepEqual(
      bodies(env, "advisor_answer").map((b) => b.advisor),
      ["reviewer-1", "reviewer-2"],
      "both reviewers of the retry had the message",
    );
    assert.deepEqual(
      bodies(env, "agent_message_read").map((b) => b.by),
      ["review_panel"],
    );
  });
});
