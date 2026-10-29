import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { Type } from "@earendil-works/pi-ai";
import { z } from "zod";
import { advisorPackage } from "../../../src/agents/roles/index.ts";
import { createHarnessApi } from "../../../src/harness/api/index.ts";
import {
  type AdvisorRuntime,
  AdvisorsConfig,
  packageFit,
  runAdvisor,
  withRunContext,
} from "../../../src/supervisor/advisors/index.ts";
import {
  adviseOnce,
  advisorKeeper,
  emptyAdviseState,
} from "../../../src/supervisor/advisors/pass/index.ts";
import { runtimeOf } from "../../../src/supervisor/advisors/routes.ts";
import { testPrompt } from "../../helpers/advisor-prompt.ts";
import { startFakeModel } from "../../helpers/fake-model.ts";
import { makeJudgeEnv } from "../../helpers/judge-env.ts";

/**
 * The advisors' context window and compaction (goal 070): each advisor's own window and point
 * (from control's route or the advisors file), a campaign's own settings over them, the one-call
 * package cut to fit, Pi's compaction of a call with the conversation kept in the supervisor's
 * records, and Claude Code's own settings.
 */

const route = {
  name: "lab",
  type: "openai",
  base_url: "https://models.example.com/v1",
  model: "m",
  context_window: 65_536,
  reasoning: null,
  api_key: "key-for-tests",
};

const pi = (o: Partial<Extract<AdvisorRuntime, { runtime: "openai" }>> = {}): AdvisorRuntime => ({
  name: "teacher-1",
  runtime: "openai",
  base_url: "http://127.0.0.1:9/v1",
  model: "m",
  api_key: "k",
  context_window: 200_000,
  max_tokens: 8192,
  max_turns: 24,
  timeout_s: 60,
  usd_per_mtok_in: 0,
  usd_per_mtok_out: 0,
  ...o,
});

type Sent = { role: string; content?: unknown }[];
/** A message's text, whether its content is a string or a list of text parts. */
const textOf = (m: Sent[number] | undefined) =>
  typeof m?.content === "string"
    ? m.content
    : Array.isArray(m?.content)
      ? (m.content as { text?: string }[]).map((p) => p.text ?? "").join("")
      : "";
const isSummary = (messages: Sent) =>
  textOf(messages[0]).includes("You summarize an agent's work so far");

describe("the advisors' context window and compaction (goal 070)", () => {
  test("control's route gives an advisor its window and point; a campaign's own lowers the window and replaces the point", () => {
    const own = runtimeOf({ ...route, compact_at: 70 }, "auditor");
    assert.equal(own?.runtime, "openai");
    assert.deepEqual(
      own?.runtime === "openai" ? [own.context_window, own.compact_at] : [],
      [65_536, 70],
    );
    const claude = runtimeOf(
      { ...route, type: "claude", context_window: 1_000_000, compact_at: 85 },
      "panel-1",
    );
    assert.deepEqual(
      claude?.runtime === "claude-code" ? [claude.context_window, claude.compact_at] : [],
      [1_000_000, 85],
    );
    // In OpenCode or Codex (goal 073): the same window and point, for the program's own settings.
    for (const harness of ["opencode", "codex"] as const) {
      const cli = runtimeOf({ ...route, harness, compact_at: 75 }, "auditor");
      assert.equal(cli?.runtime, harness);
      assert.deepEqual(
        cli?.runtime === harness ? [cli.context_window, cli.compact_at] : [],
        [65_536, 75],
      );
      const lower = cli ? withRunContext(cli, { context_window: 32_768, compact_at: 60 }) : cli;
      assert.deepEqual(
        lower?.runtime === harness ? [lower.context_window, lower.compact_at] : [],
        [32_768, 60],
      );
      // 60% less 30: three tenths of the window, at 3.5 characters a token.
      assert.equal(lower ? packageFit(lower) : 0, 34_406);
    }
    // A point out of range is not the route's: the default applies.
    const odd = runtimeOf({ ...route, compact_at: 120 }, "auditor");
    assert.equal(odd?.runtime === "openai" ? odd.compact_at : "?", undefined);

    const lowered = withRunContext(pi({ compact_at: 90 }), {
      context_window: 32_768,
      compact_at: 60,
    });
    assert.deepEqual(
      lowered.runtime === "openai" ? [lowered.context_window, lowered.compact_at] : [],
      [32_768, 60],
    );
    const smaller = withRunContext(pi({ context_window: 16_384 }), { context_window: 32_768 });
    assert.deepEqual(
      smaller.runtime === "openai" ? [smaller.context_window, smaller.compact_at] : [],
      [16_384, undefined],
    );
    // Claude Code with no window from Thermite: the campaign's.
    const cc = withRunContext(
      { name: "a", runtime: "claude-code", model: "m", token: "t", timeout_s: 30 },
      { context_window: 150_000 },
    );
    assert.equal(cc.runtime === "claude-code" ? cc.context_window : 0, 150_000);
    const cli: AdvisorRuntime = {
      name: "c",
      runtime: "cli",
      argv: ["x"],
      restricted: true,
      timeout_s: 30,
    };
    assert.equal(withRunContext(cli, { context_window: 32_768 }), cli);
  });

  test("a one-call package is cut to fit the advisor's window, and the advisor is told so in words", () => {
    // The default point (80%): half the window, at 3.5 characters a token.
    assert.equal(packageFit(pi({ context_window: 32_768 })), 57_344);
    assert.equal(packageFit(pi({ context_window: 32_768, compact_at: 50 })), 22_937);
    assert.equal(
      packageFit({ name: "c", runtime: "cli", argv: ["x"], restricted: true, timeout_s: 30 }),
      undefined,
    );
    const owner_messages = [{ id: 1, text: "keep the API stable" }];
    const pkg = { owner_messages, diff: "x".repeat(100_000) };
    const cut = advisorPackage("Audit package (untrusted data):", pkg, 200_000, 20_000);
    const length = JSON.stringify(pkg).length.toLocaleString("en-US");
    assert.ok(
      cut.startsWith(
        `Audit package (untrusted data):\n[Cut to fit the window: 20,000 of ${length} characters.]\n{"owner_messages":[{"id":1,"text":"keep the API stable"}],"diff":"xxx`,
      ),
      cut.slice(0, 200),
    );
    assert.equal(cut.split("\n")[2]?.length, 20_000);
    // A package that fits: with no words. One cut to the prompt's limit, below a larger window: said.
    assert.doesNotMatch(advisorPackage("B:", { a: 1 }, 200_000, 20_000), /Cut to fit/);
    assert.match(
      advisorPackage("B:", pkg, 50_000, 900_000),
      new RegExp(`^B:\\n\\[Cut to fit the prompt's limit: 50,000 of ${length} characters\\.\\]\\n`),
    );
    assert.match(
      advisorPackage("B:", pkg, 50_000),
      /^B:\n\[Cut to fit the prompt's limit: 50,000 of /,
    );
    // The owner's messages are never cut, even to fit.
    const big = [{ id: 2, text: "y".repeat(5000) }];
    assert.match(
      advisorPackage("B:", { owner_messages: big, diff: "z".repeat(9000) }, 200_000, 1000),
      /y{5000}"\}\],"diff":"z/,
    );
  });

  test("near its window, an advisor's call in Pi is compacted, kept in the supervisor's records, and goes on to its answer", async () => {
    const home = mkdtempSync(join(tmpdir(), "thermite-sup-"));
    const lines: string[] = [];
    const keeper = advisorKeeper(home, "js-1", (t) => lines.push(t));
    const agentCalls: Sent[] = [];
    let replies = 0;
    const fake = await startFakeModel(({ messages }) => {
      const m = messages as Sent;
      if (isSummary(m)) return { text: "SUMMARY-A: the attempt changed only the kernel." };
      agentCalls.push(m);
      replies++;
      // Two searches of past research, the second reply's usage past 80% of 16,384 (13,107).
      if (replies <= 2)
        return {
          toolCalls: [{ name: "kb_search", args: { query: `tiling ${replies}` } }],
          usage: { prompt: [3000, 14_000][replies - 1] as number, completion: 40 },
        };
      return { toolCalls: [{ name: "answer", args: { pass: true, reasons: "fine" } }] };
    });
    try {
      const r = await runAdvisor({
        runtime: pi({ name: "panel-1", base_url: fake.url, context_window: 16_384 }),
        prompt: testPrompt("Grade it.", "The deliverable."),
        schema: z.strictObject({ pass: z.boolean(), reasons: z.string() }),
        answerSchema: Type.Object({ pass: Type.Boolean(), reasons: Type.String() }),
        tools: {
          kb: {
            writes: [],
            call: async (_tool, a) => ({ text: `${String(a.query)}: ${"w ".repeat(3000)}` }),
          },
        },
        keeper,
      });
      assert.ok(r.output, r.error);
      assert.equal(r.compactions?.length, 1);
      const c = r.compactions?.[0];
      assert.equal(c?.advisor, "panel-1");
      assert.equal(c?.how, "summary");
      assert.match(
        String(c?.kept),
        /^the supervisor's records, advisors\/compactions\/js-1\/.+-panel-1-1\.md$/,
      );
    } finally {
      await fake.close();
    }
    // The conversation before it, whole, in the supervisor's home.
    const dir = join(home, "advisors", "compactions", "js-1");
    const [file] = readdirSync(dir);
    const md = readFileSync(join(dir, String(file)), "utf8");
    assert.match(md, /^# Advisor panel-1: the conversation before compaction 1/);
    assert.match(md, /The deliverable\./);
    assert.match(md, /Tool result: kb_search/);
    // The call after it: the package, the summary naming where it is kept, the newest turns.
    const after = agentCalls.at(-1) as Sent;
    const users = after.filter((m) => m.role === "user").map(textOf);
    assert.match(users[0] ?? "", /The deliverable\./);
    assert.match(users[1] ?? "", /SUMMARY-A/);
    assert.match(users[1] ?? "", /kept in the supervisor's records|is in the supervisor's records/);
    assert.match(users[1] ?? "", /call answer when your answer is ready/);
    // A line in the run's live view.
    assert.equal(lines.length, 1);
    assert.match(
      lines[0] ?? "",
      /^advisor panel-1: its conversation was compacted \(compaction 1\) at about [\d,]+ tokens, down to about [\d,]+\. It goes on\. The conversation before it is kept in the supervisor's records, advisors\/compactions\/js-1\//,
    );
  });

  test("an advisor in Claude Code gets its window and point in Claude Code's own settings", async () => {
    const dir = mkdtempSync(join(tmpdir(), "thermite-fake-claude-"));
    const bin = join(dir, "claude");
    writeFileSync(
      bin,
      `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("end", () => console.log(JSON.stringify({ type: "result", result: JSON.stringify({ window: process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW ?? "", point: process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE ?? "" }) })));
`,
    );
    chmodSync(bin, 0o755);
    const before = process.env.THERMITE_CLAUDE_BIN;
    process.env.THERMITE_CLAUDE_BIN = bin;
    const ask = async (rt: AdvisorRuntime) => {
      const r = await runAdvisor({
        runtime: rt,
        prompt: testPrompt("You audit.", "Audit this."),
        schema: z.object({ window: z.string(), point: z.string() }),
        answerSchema: Type.Object({}),
      });
      assert.equal(r.error, undefined, r.error);
      return r.output;
    };
    try {
      const cc = {
        name: "a",
        runtime: "claude-code",
        model: "m",
        token: "tok",
        timeout_s: 30,
      } as const;
      assert.deepEqual(await ask({ ...cc, context_window: 200_000, compact_at: 70 }), {
        window: "200000",
        point: "70",
      });
      // None from Thermite: Claude Code's own window, at the default point.
      assert.deepEqual(await ask(cc), { window: "", point: "80" });
    } finally {
      if (before === undefined) delete process.env.THERMITE_CLAUDE_BIN;
      else process.env.THERMITE_CLAUDE_BIN = before;
    }
  });

  test("a campaign's own window reaches the run's advisors: the teacher's brief is cut to fit it", async () => {
    const env = makeJudgeEnv({
      contract: { agents_context: { context_window: 4096, compact_at: 50 } },
      // A queue with long experiments: a brief far larger than that window holds.
      assign: {
        queue: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((i) => ({
          title: `Experiment ${i}`,
          details: "d".repeat(3000),
          by: "owner",
          state: "queued",
          from: { run: "js-0", id: `x-${i}` },
        })),
      },
    });
    await env.service.applyCommand(env.assign);
    const prompts: string[] = [];
    const fake = await startFakeModel(({ messages }) => {
      const m = messages as Sent;
      prompts.push(textOf(m.find((x) => x.role === "user")));
      return {
        toolCalls: [
          {
            name: "answer",
            args: { summary: "Fine so far.", recommendations: [] },
          },
        ],
      };
    });
    const api = createHarnessApi(env.service, { supervisor: "sup-token", proposer: "prop-token" });
    const keyDir = mkdtempSync(join(tmpdir(), "thermite-adv-"));
    writeFileSync(join(keyDir, "key"), "test-key\n");
    try {
      const s = await adviseOnce(
        {
          harnessUrl: "http://harness",
          harnessToken: "sup-token",
          home: mkdtempSync(join(tmpdir(), "thermite-sup-")),
          advisors: AdvisorsConfig.parse({
            teachers: [
              {
                name: "teacher-1",
                runtime: "openai",
                base_url: fake.url,
                model: "m",
                api_key_file: join(keyDir, "key"),
              },
            ],
          }),
          fetchImpl: async (input, init) => {
            const url = new URL(String(input));
            return api.request(`${url.pathname}${url.search}`, init as RequestInit);
          },
        },
        emptyAdviseState(),
      );
      assert.equal(s.stats.teacher_runs, 1);
    } finally {
      await fake.close();
    }
    // 4,096 tokens at 50%: a fifth of the window, 2,867 characters of the brief.
    assert.match(
      prompts[0] ?? "",
      /^Brief of run js-1:\n\[Cut to fit the window: 2,867 of [\d,]+ characters\.\]\n/,
    );
  });
});
