import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { Type } from "@earendil-works/pi-ai";
import { z } from "zod";
import { signEnvelope } from "../../src/core/commands.ts";
import { createHarnessApi } from "../../src/harness/api/index.ts";
import {
  AdvisorsConfig,
  lastJsonObject,
  runAdvisor,
  teacherRound,
} from "../../src/supervisor/advisors/index.ts";
import { adviseOnce, emptyAdviseState } from "../../src/supervisor/advisors/pass/index.ts";
import { stageCommand } from "../../src/supervisor/staging.ts";
import { testPrompt } from "../helpers/advisor-prompt.ts";
import { startFakeModel } from "../helpers/fake-model.ts";
import { FAST_KERNEL, makeJudgeEnv } from "../helpers/judge-env.ts";

const tokens = { supervisor: "sup-token", proposer: "prop-token" };

function harnessFetch(env: ReturnType<typeof makeJudgeEnv>): typeof fetch {
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

const systemOf = (messages: { role: string; content?: unknown }[]) =>
  JSON.stringify(messages.find((m) => m.role === "system")?.content ?? "");

describe("advisors", () => {
  test("two teacher reviews become one cited directive set in the harness; uncited ones are dropped", async () => {
    const env = makeJudgeEnv();
    await env.service.applyCommand(env.assign);
    const fake = await startFakeModel(({ messages }) => {
      const system = systemOf(messages);
      const tools = messages.filter((m) => m.role === "tool").length;
      if (system.includes("You merge the advice of two teachers")) {
        return {
          toolCalls: [
            {
              name: "answer",
              args: {
                directives: [
                  {
                    kind: "mandate",
                    family: "tiling",
                    rationale: "both reviews",
                    citations: ["arxiv:1"],
                  },
                  { kind: "try", family: "guesswork", rationale: "no source", citations: [] },
                  // A direction written :name: with spaces (goal 066); words are no rule.
                  {
                    kind: "try",
                    family: ":shared memory tiling:",
                    rationale: "the paper's kernel",
                    citations: ["arxiv:2"],
                  },
                  { kind: "avoid", match: "anything slow", rationale: "r", citations: ["a"] },
                ],
                experiments: [
                  {
                    title: "stage the tiles in shared memory",
                    family: "shared memory tiling",
                    why: "arxiv:2 does it",
                  },
                ],
              },
            },
          ],
        };
      }
      // A teacher: read the brief first, then answer.
      if (tools === 0) return { toolCalls: [{ name: "brief", args: {} }] };
      return {
        toolCalls: [
          {
            name: "answer",
            args: {
              summary: "tiling looks promising",
              recommendations: [
                { kind: "try", family: "tiling", rationale: "paper", citations: ["arxiv:1"] },
              ],
            },
          },
        ],
      };
    });
    const runtime = (name: string) => ({
      name,
      runtime: "openai",
      base_url: fake.url,
      model: name,
      api_key_file: keyFile(),
    });
    const advisors = AdvisorsConfig.parse({
      teachers: [runtime("teacher-a"), runtime("teacher-b")],
      merged_by: runtime("merged-by"),
    });
    const home = mkdtempSync(join(tmpdir(), "thermite-sup-"));
    const state = await adviseOnce(
      {
        harnessUrl: "http://harness",
        harnessToken: tokens.supervisor,
        home,
        advisors,
        fetchImpl: harnessFetch(env),
      },
      emptyAdviseState(),
    );
    await fake.close();
    assert.equal(state.stats.teacher_runs, 1, JSON.stringify(state.stats));
    assert.equal(state.stats.directive_sets, 1);
    // Each advisor's model calls are in the run's records, by role, with the round (goal 075).
    const usage = env.ledger
      .eventsAfter(0, 100_000)
      .events.filter((e) => e.kind === "model_call")
      .map(
        (e): Record<string, unknown> => ({
          run: e.subject,
          actor: e.actor,
          ...(e.body as Record<string, unknown>),
        }),
      );
    assert.equal(usage.length, fake.requests);
    assert.deepEqual(usage.map((u) => [u.run, u.actor, u.agent, u.harness, u.model]).sort(), [
      ["js-1", "supervisor", "merged_by", "pi", "merged-by"],
      ["js-1", "supervisor", "teachers", "pi", "teacher-a"],
      ["js-1", "supervisor", "teachers", "pi", "teacher-a"],
      ["js-1", "supervisor", "teachers", "pi", "teacher-b"],
      ["js-1", "supervisor", "teachers", "pi", "teacher-b"],
    ]);
    assert.equal(new Set(usage.map((u) => u.round)).size, 1);
    assert.match(String(usage[0]?.round), /^teachers \d{4}-/);
    assert.ok(usage.every((u) => u.provider === null && u.tokens_in === 100));
    const active = env.ledger.directives
      .active("js-1")
      .map((d) => d.body as { kind: string; family: string });
    assert.deepEqual(active, [
      { kind: "mandate", family: "tiling", rationale: "both reviews", citations: ["arxiv:1"] },
      {
        kind: "try",
        family: "shared-memory-tiling",
        rationale: "the paper's kernel",
        citations: ["arxiv:2"],
      },
    ]);
    const record = readdirSync(join(home, "advisors")).find((f) => f.includes("teachers"));
    const said = readFileSync(join(home, "advisors", String(record)), "utf8");
    assert.match(said, /no citation/);
    assert.match(said, /a rule no longer takes match/);
    // The experiments went in first, so the rule names a direction the run already has.
    const all = env.ledger.eventsAfter(0, 100_000).events;
    const added = all.find((e) => e.kind === "experiment_added");
    const rule = all.find((e) => e.kind === "directive");
    assert.ok(added && rule && added.id < rule.id);
    assert.ok(env.service.queue.directions("js-1").includes("shared-memory-tiling"));
    // Not due again within the cadence.
    const again = await adviseOnce(
      {
        harnessUrl: "http://harness",
        harnessToken: tokens.supervisor,
        home,
        advisors,
        fetchImpl: harnessFetch(env),
      },
      state,
    );
    assert.equal(again.stats.teacher_runs, 1);
  });

  test("one teacher works with no merge; two are merged only by a merged by model, else the first review is the set", async () => {
    // Each model on its own fake: each teacher recommends its own family, the merged by model a
    // third, and each counts its calls.
    const called: Record<string, number> = { first: 0, second: 0, merger: 0 };
    const teacher = (name: string) =>
      startFakeModel(() => {
        called[name] = (called[name] ?? 0) + 1;
        return {
          toolCalls: [
            {
              name: "answer",
              args: {
                summary: `${name} reviewed`,
                recommendations: [
                  { kind: "try", family: name, rationale: "r", citations: ["arxiv:1"] },
                ],
              },
            },
          ],
        };
      });
    const fakes = {
      first: await teacher("first"),
      second: await teacher("second"),
      merger: await startFakeModel(({ messages }) => {
        called.merger = (called.merger ?? 0) + 1;
        assert.match(systemOf(messages), /You merge the advice of two teachers/);
        return {
          toolCalls: [
            {
              name: "answer",
              args: {
                directives: [
                  { kind: "try", family: "merged", rationale: "both", citations: ["arxiv:3"] },
                ],
              },
            },
          ],
        };
      }),
    };
    const runtime = (name: keyof typeof fakes) => ({
      name,
      runtime: "openai",
      base_url: fakes[name].url,
      model: name,
      api_key_file: keyFile(),
    });
    const round = async (config: Record<string, unknown>) => {
      for (const k of Object.keys(called)) called[k] = 0;
      const r = await teacherRound({
        config: AdvisorsConfig.parse(config),
        run: "js-1",
        brief: { campaign: "c" },
        tools: {},
      });
      return { families: r.directives?.map((d) => d.family), called: { ...called } };
    };
    // One teacher and a merged by model: the teacher's set; the merged by model is not called.
    assert.deepEqual(await round({ teachers: [runtime("first")], merged_by: runtime("merger") }), {
      families: ["first"],
      called: { first: 1, second: 0, merger: 0 },
    });
    // Two teachers without one: the first review's set, as before goal 074.
    assert.deepEqual(await round({ teachers: [runtime("first"), runtime("second")] }), {
      families: ["first"],
      called: { first: 1, second: 1, merger: 0 },
    });
    // Two teachers and a merged by model: the merged set.
    assert.deepEqual(
      await round({
        teachers: [runtime("first"), runtime("second")],
        merged_by: runtime("merger"),
      }),
      { families: ["merged"], called: { first: 1, second: 1, merger: 1 } },
    );
    for (const f of Object.values(fakes)) await f.close();
  });

  test("a command-line auditor can block a large win; the harness holds it", async () => {
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
        {
          run: "js-1",
          patch_base64: env.patch(FAST_KERNEL),
          hypothesis: "h",
          known_flaws: [],
        },
        "t",
      )
    ).attempt;
    await env.drain();
    assert.equal(String(env.ledger.attempts.get(id)?.lifecycle), "awaiting_audit");
    // A stand-in for a CLI agent: reads the prompt, prints logs, then its JSON answer.
    const dir = mkdtempSync(join(tmpdir(), "thermite-cli-"));
    const script = join(dir, "auditor.mjs");
    writeFileSync(
      script,
      `let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{console.log("thinking...");console.log(JSON.stringify({decision:s.includes("work.mjs")?"block":"clear",reasons:"the inner loop was removed; check the work is still done",citations:["diff"]}));});`,
    );
    const advisors = AdvisorsConfig.parse({
      auditor: {
        name: "cli-auditor",
        runtime: "cli",
        argv: [process.execPath, script],
        restricted: true,
      },
    });
    const state = await adviseOnce(
      {
        harnessUrl: "http://harness",
        harnessToken: tokens.supervisor,
        home: mkdtempSync(join(tmpdir(), "thermite-sup-")),
        advisors,
        fetchImpl: harnessFetch(env),
      },
      emptyAdviseState(),
    );
    assert.equal(state.stats.audits, 1, JSON.stringify(state.stats));
    assert.equal(String(env.ledger.attempts.get(id)?.lifecycle), "audit_blocked");
    // A command-line agent says nothing of its model calls: none is recorded, none made up.
    assert.equal(
      env.ledger.eventsAfter(0, 100_000).events.filter((e) => e.kind === "model_call").length,
      0,
    );
  });

  test("an auditor that fails its last try hands the audit to the owner, with the error (goal 079)", async () => {
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
    const dir = mkdtempSync(join(tmpdir(), "thermite-cli-"));
    const script = join(dir, "auditor.mjs");
    writeFileSync(script, `console.log("no answer today"); process.exit(3);`);
    const advisors = AdvisorsConfig.parse({
      auditor: {
        name: "cli-auditor",
        runtime: "cli",
        argv: [process.execPath, script],
        restricted: true,
      },
    });
    const home = mkdtempSync(join(tmpdir(), "thermite-sup-"));
    let state = emptyAdviseState();
    const cfg = { harnessUrl: "http://harness", harnessToken: tokens.supervisor, home, advisors };
    for (let n = 1; n <= 5; n++) {
      state = await adviseOnce({ ...cfg, retryMs: 0, fetchImpl: harnessFetch(env) }, state);
      assert.equal(
        String(env.ledger.attempts.get(id)?.lifecycle),
        n < 5 ? "awaiting_audit" : "awaiting_approval",
        `after try ${n}`,
      );
    }
    assert.match(
      String(env.ledger.latestEventBody("promotion_pending", id)?.reason),
      /the auditor asked for the owner: the auditor could not answer after 5 tries/,
    );
  });

  /** A rig whose large win waits for an audit, and a command-line auditor that prints `script`. */
  async function heldForAudit(script: string) {
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
    const dir = mkdtempSync(join(tmpdir(), "thermite-cli-"));
    writeFileSync(join(dir, "auditor.mjs"), script);
    const advisors = AdvisorsConfig.parse({
      auditor: {
        name: "cli-auditor",
        runtime: "cli",
        argv: [process.execPath, join(dir, "auditor.mjs")],
        restricted: true,
      },
    });
    const cfg = {
      harnessUrl: "http://harness",
      harnessToken: tokens.supervisor,
      home: mkdtempSync(join(tmpdir(), "thermite-sup-")),
      advisors,
      retryMs: 0,
    };
    const audit = Number(
      env.ledger.db.prepare("select id from audit where attempt = ?").get(id)?.id,
    );
    return { env, id, audit, cfg };
  }

  test("an audit's tries are its own: an earlier audit of the same attempt does not use them up (goal 079)", async () => {
    const { env, id, cfg } = await heldForAudit(
      `console.log(JSON.stringify({decision:"block",reasons:"the inner loop was removed",citations:["diff"]}));`,
    );
    // An earlier audit of this attempt (another confirmation) was tried five times, just now.
    const state = emptyAdviseState();
    state.tried[`audit:${id}`] = new Date().toISOString();
    state.tries[`audit:${id}`] = 5;
    const next = await adviseOnce({ ...cfg, fetchImpl: harnessFetch(env) }, state);
    assert.equal(next.stats.audits, 1, "the open audit is tried");
    assert.equal(String(env.ledger.attempts.get(id)?.lifecycle), "audit_blocked");
    assert.equal(next.tries[`audit:${id}`], undefined, "the old marker is gone");
  });

  test("an audit whose last try failed reaches the owner even when the first hand-off fails (goal 079)", async () => {
    const { env, id, audit, cfg } = await heldForAudit(
      `console.log("no answer"); process.exit(3);`,
    );
    // The harness refuses the first hand-off to the owner, as if it were away.
    const inner = harnessFetch(env);
    let refused = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      const body = String((init as RequestInit | undefined)?.body ?? "");
      if (String(input).endsWith("/v1/audits") && body.includes("needs_owner") && !refused++)
        return new Response(JSON.stringify({ error: "the harness is away" }), { status: 503 });
      return inner(input, init);
    };
    let state = emptyAdviseState();
    for (let n = 1; n <= 5; n++) state = await adviseOnce({ ...cfg, fetchImpl }, state);
    assert.equal(refused, 1, "the fifth failure was handed to the owner, and refused");
    assert.equal(String(env.ledger.attempts.get(id)?.lifecycle), "awaiting_audit");
    assert.equal(state.tries[`audit:${audit}`], 5);
    // The next round hands it again: it reaches the owner, with the auditor's error.
    state = await adviseOnce({ ...cfg, fetchImpl }, state);
    assert.equal(String(env.ledger.attempts.get(id)?.lifecycle), "awaiting_approval");
    assert.match(
      String(env.ledger.latestEventBody("promotion_pending", id)?.reason),
      /the auditor could not answer after 5 tries: no valid answer: no answer/,
    );
    // Closed: its markers go.
    state = await adviseOnce({ ...cfg, fetchImpl }, state);
    assert.equal(state.tries[`audit:${audit}`], undefined);
  });

  test("the review panel passes a subjective goal, accepted with no owner step (goal 079)", async () => {
    const env = makeJudgeEnv({ goal: { opsPerSecond: 1e12 } });
    await env.service.applyCommand(env.assign);
    await env.drain();
    const fake = await startFakeModel(() => ({
      toolCalls: [{ name: "answer", args: { pass: true, reasons: "clear and small" } }],
    }));
    const runtime = (name: string) => ({
      name,
      runtime: "openai",
      base_url: fake.url,
      model: name,
      api_key_file: keyFile(),
    });
    const advisors = AdvisorsConfig.parse({
      review_panel: [runtime("reviewer-1"), runtime("reviewer-2")],
    });
    const state = await adviseOnce(
      {
        harnessUrl: "http://harness",
        harnessToken: tokens.supervisor,
        home: mkdtempSync(join(tmpdir(), "thermite-sup-")),
        advisors,
        fetchImpl: harnessFetch(env),
      },
      emptyAdviseState(),
    );
    await fake.close();
    assert.equal(state.stats.reviews, 1, JSON.stringify(state.stats));
    const r = env.ledger.db.prepare("select panel_result, owner_decision from review").get();
    assert.deepEqual({ ...r }, { panel_result: "review_passed", owner_decision: "accepted" });
    // Each panelist's call, as the review panel's, with the review it was for.
    const usage = env.ledger
      .eventsAfter(0, 100_000)
      .events.filter((e) => e.kind === "model_call")
      .map((e) => e.body as Record<string, unknown>);
    assert.deepEqual(
      usage.map((u) => [u.agent, u.model, u.round]),
      [
        ["review_panel", "reviewer-1", "review 1"],
        ["review_panel", "reviewer-2", "review 1"],
      ],
    );
  });

  test("an advisor on an API key thinks at the effort chosen for it, and only then", async () => {
    const sent: (string | undefined)[] = [];
    const fake = await startFakeModel((req) => {
      sent.push(req.reasoning_effort);
      return { toolCalls: [{ name: "answer", args: { pass: true, reasons: "ok" } }] };
    });
    try {
      for (const reasoning of [undefined, "low", "high"] as const) {
        const r = await runAdvisor({
          runtime: {
            name: "panel-1",
            runtime: "openai",
            base_url: fake.url,
            model: "m",
            api_key: "k",
            ...(reasoning ? { reasoning } : {}),
            context_window: 200_000,
            max_tokens: 8192,
            max_turns: 24,
            timeout_s: 60,
            usd_per_mtok_in: 0,
            usd_per_mtok_out: 0,
          },
          prompt: testPrompt("Grade it.", "The change."),
          schema: z.strictObject({ pass: z.boolean(), reasons: z.string() }),
          answerSchema: Type.Object({ pass: Type.Boolean(), reasons: Type.String() }),
        });
        assert.ok(r.output, r.error);
      }
    } finally {
      await fake.close();
    }
    assert.deepEqual(sent, [undefined, "low", "high"]);
  });

  test("a Pi advisor refused for the same problems three times running ends its call; changing problems go on", async () => {
    const runtime = {
      name: "panel-1",
      runtime: "openai" as const,
      base_url: "",
      model: "m",
      api_key: "k",
      context_window: 200_000,
      max_tokens: 8192,
      usd_per_mtok_in: 0,
      usd_per_mtok_out: 0,
    };
    const call = (
      url: string,
      accept?: (o: { pass: boolean }) => Promise<string | undefined>,
      schema: z.ZodType<{ pass: boolean }> = z.strictObject({ pass: z.boolean() }),
    ) =>
      runAdvisor({
        runtime: { ...runtime, base_url: url },
        prompt: testPrompt("Grade it.", "The change."),
        schema,
        answerSchema: Type.Object({ pass: Type.Boolean() }),
        accept,
      });
    // The same wrong answer every time, refused by Pi's check of the tool's schema, then by the
    // role's own schema: no turn or time limit is set, and the call still ends.
    let asked = 0;
    let args: unknown = { pass: "yes" };
    const stuck = await startFakeModel(() => {
      asked++;
      return { toolCalls: [{ name: "answer", args }] };
    });
    try {
      const r = await call(stuck.url);
      assert.equal(r.output, undefined);
      assert.match(
        r.error ?? "",
        /refused 3 times running for the same problems: .*pass: must be boolean/s,
      );
      assert.equal(asked, 3);
      asked = 0;
      args = { pass: false };
      const own = await call(stuck.url, undefined, z.strictObject({ pass: z.literal(true) }));
      assert.equal(own.output, undefined);
      assert.match(own.error ?? "", /refused 3 times running for the same problems: pass: /);
      assert.equal(asked, 3);
    } finally {
      await stuck.close();
    }
    // Problems that change each time are asked again, past three, until the answer is taken.
    asked = 0;
    const fixing = await startFakeModel(() => {
      asked++;
      return { toolCalls: [{ name: "answer", args: { pass: true } }] };
    });
    const refusals = ["a", "b", "a", "b"];
    try {
      const r = await call(fixing.url, async () => refusals.shift());
      assert.deepEqual(r.output, { pass: true }, r.error);
      assert.equal(asked, 5);
    } finally {
      await fixing.close();
    }
  });

  test("advisors have no spending limit unless the owner sets one", () => {
    assert.equal(AdvisorsConfig.parse({}).max_usd_per_day, undefined);
    assert.equal(AdvisorsConfig.parse({ max_usd_per_day: 5 }).max_usd_per_day, 5);
  });

  test("an advisor in Claude Code has its own folder as its home and its temporary folder, never /tmp", async () => {
    // A stand-in for Claude Code: it answers with its temporary folder, home and working folder.
    const dir = mkdtempSync(join(tmpdir(), "thermite-fake-claude-"));
    const bin = join(dir, "claude");
    writeFileSync(
      bin,
      `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("end", () => console.log(JSON.stringify({ type: "result", result: JSON.stringify({ tmp: process.env.TMPDIR ?? "", home: process.env.HOME ?? "", cwd: process.cwd() }), duration_api_ms: 4200, usage: { input_tokens: 10, cache_creation_input_tokens: 90, cache_read_input_tokens: 900, output_tokens: 60 } })));
`,
    );
    chmodSync(bin, 0o755);
    const before = process.env.THERMITE_CLAUDE_BIN;
    process.env.THERMITE_CLAUDE_BIN = bin;
    try {
      const r = await runAdvisor({
        runtime: {
          name: "a",
          runtime: "claude-code",
          model: "m",
          token: "tok",
          timeout_s: 30,
          provider: "my-claude",
        },
        prompt: testPrompt("You audit.", "Audit this."),
        schema: z.object({ tmp: z.string(), home: z.string(), cwd: z.string() }),
        answerSchema: Type.Object({}),
      });
      assert.equal(r.error, undefined, r.error);
      const o = r.output as { tmp: string; home: string; cwd: string };
      assert.match(o.tmp, /thermite-advisor-/);
      assert.equal(o.tmp, o.home);
      assert.ok(o.cwd.endsWith(o.home.split("/").at(-1) ?? "-"), o.cwd);
      // Its model usage, from its JSON result: no count of calls there (goal 075).
      assert.equal(r.usage?.harness, "claude-code");
      assert.equal(r.usage?.provider, "my-claude");
      assert.deepEqual(
        r.usage?.calls.map((u) => [u.calls, u.tokens_in, u.cached_in, u.tokens_out, u.call_ms]),
        [[null, 1000, 900, 60, 4200]],
      );
    } finally {
      if (before === undefined) delete process.env.THERMITE_CLAUDE_BIN;
      else process.env.THERMITE_CLAUDE_BIN = before;
    }
  });

  test("a CLI agent's answer is found after its logs", () => {
    assert.deepEqual(lastJsonObject('log {"x": 1}\nmore\n{"a": {"b": 2}}\n'), { a: { b: 2 } });
    assert.equal(lastJsonObject("no json here"), undefined);
  });
});

describe("staging a propagation", () => {
  test("the published patch is fetched from the results repository into the inbox, checked by sha256", async () => {
    const root = mkdtempSync(join(tmpdir(), "thermite-stage-"));
    const git = (cwd: string, ...args: string[]) =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@localhost", ...args], {
        cwd,
        encoding: "utf8",
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
      }).trim();
    // The results repository as rig-a's supervisor pushed it.
    const remote = join(root, "results-remote.git");
    mkdirSync(remote);
    git(remote, "init", "--bare", "--quiet");
    const work = join(root, "work");
    mkdirSync(join(work, "champions", "js-1"), { recursive: true });
    const patch = "diff --git a/x b/x\n";
    writeFileSync(join(work, "champions", "js-1", "2.patch"), patch);
    git(work, "init", "--quiet", "-b", "thermite/rig-a/attempts");
    git(work, "add", "-A");
    git(work, "commit", "--quiet", "-m", "export");
    git(work, "push", "--quiet", remote, "thermite/rig-a/attempts");
    // rig-b's supervisor.
    const resultsRepo = join(root, "rig-b-results.git");
    mkdirSync(resultsRepo);
    git(resultsRepo, "init", "--bare", "--quiet");
    const inboxDir = join(root, "inbox");
    mkdirSync(inboxDir);
    const keys = (await import("../../src/core/commands.ts")).generateSigningKeys();
    const cmd = (sha: string) =>
      signEnvelope(
        {
          v: 1,
          id: randomUUID(),
          rig: "rig-b",
          kind: "propagate",
          issued_by: "owner",
          issued_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          payload: {
            run: "js-1",
            source_rig: "rig-a",
            source_run: "js-1",
            source_seq: 2,
            import: {
              kind: "champion_patch",
              path: "propagate/rig-a/js-1/2.patch",
              repo: "proj",
              base_commit: "a".repeat(40),
              tree: "b".repeat(40),
              sha256: sha,
            },
          },
        },
        keys.privateKeyPem,
      );
    const cfg = { rig: "rig-b", inboxDir, resultsRepo, remote: `file://${remote}` };
    assert.equal(await stageCommand(cfg, cmd("0".repeat(64))), "wait");
    const sha = createHash("sha256").update(patch).digest("hex");
    assert.equal(await stageCommand(cfg, cmd(sha)), "ready");
    assert.equal(
      readFileSync(join(inboxDir, "propagate", "rig-a", "js-1", "2.patch"), "utf8"),
      patch,
    );
  });
});
