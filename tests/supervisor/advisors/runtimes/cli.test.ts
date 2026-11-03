import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { Type } from "@earendil-works/pi-ai";
import { z } from "zod";
import { RunAsServer } from "../../../../src/common/run-as/index.ts";
import { ADVISOR_RUNS_ENV } from "../../../../src/core/advisor-runs.ts";
import { runAdvisor } from "../../../../src/supervisor/advisors/index.ts";
import { noAnswer, parseAnswer, runCli } from "../../../../src/supervisor/advisors/runtimes/cli.ts";
import { testPrompt } from "../../../helpers/advisor-prompt.ts";

/**
 * An advisor's command through the advisors' runner (src/common/run-as/), as the supervisor's
 * entry serves it; here the runner is the test's own user (not root), so it keeps every run in
 * its own process group without a user of its own. The command is a stand-in that says what it
 * was given, then answers.
 */

/** A runner on a socket of its own, and its runs' root, named in the supervisor's settings. */
async function runner() {
  const base = mkdtempSync(join(tmpdir(), "thermite-advisor-runner-"));
  const root = join(base, "runs");
  mkdirSync(root);
  chmodSync(root, 0o711);
  const socket = join(base, "runs.sock");
  const server = new RunAsServer({ socketPath: socket, root, callerGid: process.getgid?.() ?? 0 });
  server.listen();
  await new Promise((r) => server.server.once("listening", r));
  process.env[ADVISOR_RUNS_ENV.socket] = socket;
  process.env[ADVISOR_RUNS_ENV.root] = root;
  after(() => {
    delete process.env[ADVISOR_RUNS_ENV.socket];
    delete process.env[ADVISOR_RUNS_ENV.root];
    server.server.close();
    rmSync(base, { recursive: true, force: true });
  });
  return { root };
}

/** Says its folder, prompt, token (fd 3), route and the file the supervisor wrote, then answers. */
const STAND_IN = [
  process.execPath,
  "-e",
  `const fs = require("node:fs");
let token = null;
try { token = fs.readFileSync(3, "utf8"); } catch {}
const prompt = fs.readFileSync(0, "utf8");
fs.writeFileSync("left.txt", "what the run left");
console.log(JSON.stringify({ answer: { cwd: process.cwd(), home: process.env.HOME, prompt, token,
  route: process.env.ROUTE ?? null, config: fs.readFileSync("config.json", "utf8") } }));`,
];

const Answer = z.object({
  answer: z.object({
    cwd: z.string(),
    home: z.string(),
    prompt: z.string(),
    token: z.string().nullable(),
    route: z.string().nullable(),
    config: z.string(),
  }),
});

describe("an advisor's command run by the supervisor itself", () => {
  test("a command that exits before it reads its prompt is no answer, and never stops the supervisor", async () => {
    const kept = {
      socket: process.env[ADVISOR_RUNS_ENV.socket],
      root: process.env[ADVISOR_RUNS_ENV.root],
    };
    delete process.env[ADVISOR_RUNS_ENV.socket];
    delete process.env[ADVISOR_RUNS_ENV.root];
    try {
      // A prompt past a pipe's buffer: the command is gone before the supervisor ends writing it.
      const r = await runCli({ argv: ["sh", "-c", "exit 0"] }, "x".repeat(2_000_000), Answer);
      assert.match(r.error ?? "", /no valid answer/);
    } finally {
      if (kept.socket !== undefined) process.env[ADVISOR_RUNS_ENV.socket] = kept.socket;
      if (kept.root !== undefined) process.env[ADVISOR_RUNS_ENV.root] = kept.root;
    }
  });
});

describe("an advisor's command through the advisors' runner", () => {
  test("it runs in a fresh folder of the runner's root, with only its prompt, settings, token and files; the folder goes after", async () => {
    const { root } = await runner();
    let left: string | undefined;
    const r = await runCli(
      {
        argv: STAND_IN,
        env: { ROUTE: "http://127.0.0.1:9/v1" },
        token: "a sign-in token",
        prepare: (home) => {
          writeFileSync(join(home, "config.json"), "the call's settings");
          return {};
        },
        collect: (home) => {
          left = readFileSync(join(home, "left.txt"), "utf8");
          return [];
        },
      },
      "the prompt",
      Answer,
    );
    assert.equal(r.error, undefined);
    const a = r.output?.answer;
    assert.ok(a);
    assert.equal(join(a.cwd, ".."), realpathSync(root), "a child of the runner's root");
    assert.equal(a.home, a.cwd);
    assert.equal(a.prompt, "the prompt");
    assert.equal(a.token, "a sign-in token");
    assert.equal(a.route, "http://127.0.0.1:9/v1");
    assert.equal(a.config, "the call's settings");
    assert.equal(left, "what the run left", "read before the folder goes");
    assert.equal(existsSync(a.cwd), false);
    assert.deepEqual(readdirSync(root), []);
  });

  test("a command that can't start, or runs past its time, is an error or no answer, and its folder goes", async () => {
    const { root } = await runner();
    const missing = await runCli({ argv: ["/nonexistent/advisor"] }, "", Answer);
    assert.match(missing.error ?? "", /ENOENT|nonexistent/);
    const slow = await runCli(
      { argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"], timeout_s: 1 },
      "",
      Answer,
    );
    assert.match(slow.error ?? "", /no valid answer/);
    assert.deepEqual(readdirSync(root), []);
  });

  test("an advisor in Claude Code runs through it with its empty arguments and its token on fd 3", async () => {
    // Claude Code's command has empty arguments (`--tools ""`, `--setting-sources ""`): the runner
    // once refused the whole request for them, and the auditor's call never ran.
    await runner();
    const dir = mkdtempSync(join(tmpdir(), "thermite-fake-claude-"));
    after(() => rmSync(dir, { recursive: true, force: true }));
    const bin = join(dir, "claude");
    writeFileSync(
      bin,
      `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const val = (f) => args[args.indexOf(f) + 1];
const token = fs.readFileSync(Number(process.env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR), "utf8");
fs.readFileSync(0, "utf8");
console.log(JSON.stringify({ type: "result", result: JSON.stringify({ tools: val("--tools"),
  sources: val("--setting-sources"), token: token === "sk-ant-oat01-test" }) }));
`,
    );
    chmodSync(bin, 0o755);
    const before = process.env.THERMITE_CLAUDE_BIN;
    process.env.THERMITE_CLAUDE_BIN = bin;
    try {
      const r = await runAdvisor({
        runtime: { name: "a", runtime: "claude-code", model: "m", token: "sk-ant-oat01-test" },
        prompt: testPrompt("You audit.", "Audit this."),
        schema: z.object({ tools: z.string(), sources: z.string(), token: z.boolean() }),
        answerSchema: Type.Object({}),
      });
      assert.equal(r.error, undefined, r.error);
      assert.deepEqual(r.output, { tools: "", sources: "", token: true });
    } finally {
      if (before === undefined) delete process.env.THERMITE_CLAUDE_BIN;
      else process.env.THERMITE_CLAUDE_BIN = before;
    }
  });

  test("an advisor in Claude Code at a full usage window: its transcript gives the reset, which its words do not, and the call says it waits", async () => {
    await runner();
    const dir = mkdtempSync(join(tmpdir(), "thermite-fake-claude-"));
    after(() => rmSync(dir, { recursive: true, force: true }));
    const resetsAt = Math.floor(Date.now() / 1000) + 2 * 3600;
    const words = "You've hit your session limit · resets 5:49am (UTC)";
    // As Claude Code 2.1.308 records a full five-hour window in its transcript.
    const record = {
      type: "assistant",
      timestamp: new Date().toISOString(),
      message: {
        id: "limit-1",
        model: "<synthetic>",
        role: "assistant",
        type: "message",
        usage: { input_tokens: 0, output_tokens: 0 },
        content: [{ type: "text", text: words }],
      },
      apiError: "usage_limit_reached",
      apiErrorParams: {
        rate_limit_info: { status: "rejected", resetsAt, rateLimitType: "five_hour" },
      },
      error: "rate_limit",
      isApiErrorMessage: true,
      sessionId: "s-1",
    };
    const bin = join(dir, "claude");
    writeFileSync(
      bin,
      `#!/usr/bin/env node
const fs = require("node:fs");
fs.readFileSync(0, "utf8");
const at = require("node:path").join(process.env.HOME, ".claude", "projects", "p");
fs.mkdirSync(at, { recursive: true });
fs.writeFileSync(require("node:path").join(at, "s-1.jsonl"), ${JSON.stringify(`${JSON.stringify(record)}\n`)});
console.log(JSON.stringify({ type: "result", is_error: true, result: ${JSON.stringify(words)} }));
process.exit(1);
`,
    );
    chmodSync(bin, 0o755);
    const before = process.env.THERMITE_CLAUDE_BIN;
    process.env.THERMITE_CLAUDE_BIN = bin;
    try {
      const r = await runAdvisor({
        runtime: { name: "a", runtime: "claude-code", model: "m", token: "sk-ant-oat01-test" },
        prompt: testPrompt("You audit.", "Audit this."),
        schema: z.object({ decision: z.string() }),
        answerSchema: Type.Object({}),
      });
      assert.equal(r.output, undefined);
      assert.deepEqual(r.limit, { until: new Date(resetsAt * 1000).toISOString(), words });
    } finally {
      if (before === undefined) delete process.env.THERMITE_CLAUDE_BIN;
      else process.env.THERMITE_CLAUDE_BIN = before;
    }
  });
});

describe("an advisor's answer in its text", () => {
  const Review = z.strictObject({
    summary: z.string(),
    portfolio: z.array(z.strictObject({ id: z.string(), why: z.string() })),
  });
  test("an answer written over many lines is found whole, not an object of one line inside it", () => {
    const text = [
      "Here is my review.",
      "```json",
      "{",
      '  "summary": "two ideas",',
      '  "portfolio": [',
      '    {"id": "x-1", "why": "the loads are uncoalesced"},',
      '    {"id": "x-2", "why": "the tail is serial"}',
      "  ]",
      "}",
      "```",
    ].join("\n");
    const r = parseAnswer(text, Review);
    assert.ok(r.ok);
    assert.equal(r.ok && r.value.portfolio.length, 2);
  });
  test("an answer that does not fit says why, with each problem's place", () => {
    const r = parseAnswer('{"summary": "one", "portfolio": [{"id": "x-1"}]}', Review);
    assert.equal(r.ok, false);
    const problems = r.ok ? "" : r.problems;
    assert.match(problems, /^portfolio\.0\.why: /);
    assert.match(
      noAnswer(problems, "…the end"),
      /^no valid answer: portfolio\.0\.why: .+\. It ended: …the end$/,
    );
    // No JSON at all: the text's end alone, as before.
    const none = parseAnswer("I could not finish.", Review);
    assert.equal(
      noAnswer(none.ok ? "" : none.problems, "I could not finish."),
      "no valid answer: I could not finish.",
    );
  });
});
