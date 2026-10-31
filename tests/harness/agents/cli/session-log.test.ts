import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, type TestContext, test } from "node:test";
import { runCodexTrial } from "../../../../src/harness/agents/cli/codex.ts";
import type { TrialSpec } from "../../../../src/harness/agents/worker/index.ts";
import type { RunRequest } from "../../../../src/harness/broker/runner.ts";
import { fakeProgramRunner } from "../../../helpers/fake-program.ts";

const THREAD = "0199a213-81c0-7800-8aa1-bbab2a035a53";
const AT = "2026-10-29T05:52:16.107Z";

// The Codex CLI's `exec --json` output for one turn: a command, then its answer.
const stream = [
  { type: "thread.started", thread_id: THREAD },
  { type: "turn.started" },
  {
    type: "item.completed",
    item: {
      id: "item_1",
      type: "command_execution",
      command: "make",
      aggregated_output: "ok\n",
      exit_code: 0,
      status: "completed",
    },
  },
  { type: "item.completed", item: { id: "item_2", type: "agent_message", text: "Done." } },
  { type: "turn.completed", usage: { input_tokens: 2400, output_tokens: 90 } },
].map((e) => JSON.stringify(e));

// The same turn in its rollout, shaped as version 0.162.1 writes it (no real data).
const rollout = (more: object[] = []) =>
  [
    { type: "session_meta", payload: { id: THREAD } },
    { type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } },
    {
      type: "event_msg",
      payload: {
        type: "item_completed",
        item: { type: "UserMessage", content: [{ type: "text", text: "Make it faster." }] },
      },
    },
    {
      type: "response_item",
      payload: {
        type: "function_call",
        call_id: "call_1",
        name: "exec_command",
        arguments: '{"cmd":"make"}',
      },
    },
    {
      type: "event_msg",
      payload: {
        type: "item_completed",
        item: { type: "CommandExecution", id: "call_1", status: "completed", exit_code: 0 },
      },
    },
    {
      type: "response_item",
      payload: { type: "function_call_output", call_id: "call_1", output: "ok" },
    },
    {
      type: "response_item",
      payload: {
        type: "message",
        id: "msg_1",
        role: "assistant",
        content: [{ type: "output_text", text: "Done." }],
      },
    },
    {
      type: "token_usage_record",
      payload: { response_id: "resp_1", usage: { input_tokens: 2400, output_tokens: 90 } },
    },
    ...more,
    { type: "event_msg", payload: { type: "task_complete" } },
  ]
    .map((e) => JSON.stringify({ timestamp: AT, ...e }))
    .join("\n");

const model = {
  api: "chatgpt" as const,
  harness: "codex" as const,
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-test",
  apiKey: "chatgpt-access-token-for-tests",
  contextWindow: 0,
  maxTokens: 0,
  reasoning: "off" as const,
};
const spec = (area: string): TrialSpec => ({
  trialId: "t-1",
  token: "tok",
  run: "r-1",
  lane: "lane-1",
  workspace: join(area, "repo"),
  workspaceRoot: area,
  parentCommit: "c".repeat(40),
  editablePaths: ["src/**"],
  brief: "Make it faster.",
  wallMs: 60_000,
});
/** Where Codex writes the thread's rollout under its home. */
const rolloutDir = (req: RunRequest) =>
  join(String(req.env?.CODEX_HOME), "sessions", "2026", "10", "29");
const ROLLOUT_NAME = `rollout-2026-10-29T05-52-15-${THREAD}.jsonl`;

/**
 * A Codex trial whose run writes its output and, with `write`, its rollout; the harness's log
 * lines about the session log, and the trial's result.
 */
async function trial(t: TestContext, write?: (req: RunRequest) => void) {
  const area = mkdtempSync(join(tmpdir(), "thermite-codex-log-"));
  mkdirSync(join(area, "repo"));
  const f = fakeProgramRunner(
    "codex",
    (_n, req) => {
      write?.(req);
      return stream;
    },
    { submit: true },
  );
  // Thermite's log lines are kept; the test runner's own output goes on through.
  const said: string[] = [];
  const through = process.stdout.write.bind(process.stdout);
  t.mock.method(process.stdout, "write", (chunk: unknown, ...rest: never[]) => {
    if (typeof chunk === "string" && chunk.startsWith('{"at":')) return said.push(chunk) > 0;
    return through(chunk as string, ...rest);
  });
  const result = await runCodexTrial(spec(area), {
    runner: f.runner,
    model,
    apiUrl: "http://127.0.0.1:8700",
    live: () => undefined,
    progress: () => undefined,
    submitted: () => (f.submitted() ? { attempt: "a-1", lifecycle: "queued" } : undefined),
    pollMs: 5,
  });
  t.mock.restoreAll();
  const lines = said
    .filter((l) => l.includes("session log"))
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  return { result, lines };
}

describe("a headless Codex trial beside its rollout", () => {
  test("a rollout that agrees with the output says nothing, and changes nothing", async (t) => {
    const { result, lines } = await trial(t, (req) => {
      mkdirSync(rolloutDir(req), { recursive: true });
      writeFileSync(join(rolloutDir(req), ROLLOUT_NAME), `${rollout()}\n`);
    });
    assert.equal(result.stopped, "submitted");
    assert.equal(result.turns, 2);
    assert.equal(result.tokensIn, 2400);
    assert.deepEqual(lines, []);
  });

  test("where the rollout and the output differ, one line says how, once at the trial's end", async (t) => {
    const more = [
      {
        type: "token_usage_record",
        payload: { response_id: "resp_2", usage: { input_tokens: 100, output_tokens: 5 } },
      },
      { type: "brand_new", payload: {} },
    ];
    const { result, lines } = await trial(t, (req) => {
      mkdirSync(rolloutDir(req), { recursive: true });
      writeFileSync(join(rolloutDir(req), ROLLOUT_NAME), `${rollout(more)}\n`);
    });
    assert.equal(result.tokensIn, 2400, "the trial's record is its output's");
    assert.equal(lines.length, 1);
    assert.equal(lines[0]?.msg, "Codex's session log and its output differ");
    assert.equal(lines[0]?.trial, "t-1");
    assert.deepEqual(lines[0]?.differ, {
      tokensIn: { output: 2400, log: 2500 },
      tokensOut: { output: 90, log: 95 },
    });
    assert.deepEqual(lines[0]?.unknown, { brand_new: 1 });
  });

  test("no rollout, or one behind a link, costs a look and changes nothing", async (t) => {
    const none = await trial(t);
    assert.equal(none.result.stopped, "submitted");
    assert.deepEqual(none.lines, []);
    const elsewhere = mkdtempSync(join(tmpdir(), "thermite-codex-elsewhere-"));
    writeFileSync(
      join(elsewhere, "rollout.jsonl"),
      `${rollout([{ type: "brand_new", payload: {} }])}\n`,
    );
    const linked = await trial(t, (req) => {
      mkdirSync(rolloutDir(req), { recursive: true });
      symlinkSync(join(elsewhere, "rollout.jsonl"), join(rolloutDir(req), ROLLOUT_NAME));
    });
    assert.equal(linked.result.stopped, "submitted");
    assert.deepEqual(
      linked.lines,
      [],
      "the agent's user cannot send the harness to read elsewhere",
    );
  });
});
