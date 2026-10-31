/**
 * A planner's call in its program's own terminal (goal 169), on the fake TUI (tests/helpers/
 * fake-tui.ts) in Claude Code's place, through the terminal host and the local runner: the program
 * and the host run as the test's own user. Linux only, as the host's own tests: it needs
 * util-linux's setsid and node-pty. The harness image's acceptance checks (claude.mjs, codex.mjs
 * and agents.mjs) run the same path under the broker, as the planner's user.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { describe, test } from "node:test";
import { serve } from "@hono/node-server";
import type { ModelConfig } from "../../../../src/agents/model/index.ts";
import { messageText, type Prompt } from "../../../../src/agents/prompt.ts";
import { renderPlannerTurn } from "../../../../src/agents/roles/index.ts";
import { signEnvelope } from "../../../../src/core/commands.ts";
import { plannerCallId } from "../../../../src/core/terminal-input.ts";
import { claudeProgram } from "../../../../src/harness/agents/cli/claude-code.ts";
import { cliAsk } from "../../../../src/harness/agents/cli/once.ts";
import { createHarnessApi } from "../../../../src/harness/api/index.ts";
import { LocalRunner } from "../../../../src/harness/broker/runner.ts";
import { SETSID } from "../../../../src/harness/terminal/pty.ts";
import { makeJudgeEnv } from "../../../helpers/judge-env.ts";

const FAKE = join(import.meta.dirname, "..", "..", "..", "helpers", "fake-tui.ts");
// util-linux's setsid starts the program on its terminal: Linux only, as the harness image is.
const skip = SETSID ? false : "needs util-linux's setsid (Linux), as the harness image has";
// Short: a socket's path is at most 104 bytes on some systems.
const scratch = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "tc-"));
const runner = new LocalRunner(scratch);
const AT = "2026-10-30T05:52:16.107Z";
const script = join(scratch, "script.json");

// The fake in Claude Code's place, with its script: a call's environment is its program's own.
const bin = join(scratch, "claude");
writeFileSync(
  bin,
  `#!/bin/sh\nFAKE_TUI_SCRIPT="${script}" exec "${process.execPath}" "${FAKE}" "$@"\n`,
);
chmodSync(bin, 0o755);
process.env.THERMITE_CLAUDE_BIN = bin;

const MODEL: ModelConfig = {
  api: "claude",
  harness: "claude-code",
  baseUrl: "https://api.anthropic.com",
  model: "claude-test",
  apiKey: "made-up-sign-in",
  contextWindow: 1_000_000,
  maxTokens: 0,
};

// Claude Code's transcript records, as the fake writes them for its session.
const S = "{session}";
const said = (text: string) => ({
  type: "user",
  sessionId: S,
  origin: { kind: "human" },
  message: { content: text },
});
const read = {
  type: "assistant",
  sessionId: S,
  timestamp: AT,
  message: {
    id: "msg_1",
    model: "claude-test",
    content: [{ type: "tool_use", id: "tu_1", name: "Read", input: { file_path: "past.md" } }],
    usage: { input_tokens: 10, output_tokens: 2 },
  },
};
const readResult = {
  type: "user",
  sessionId: S,
  message: { content: [{ type: "tool_result", tool_use_id: "tu_1", content: "ok" }] },
};
const PLAN = '{"assignments": [{"lane": "lane-1", "experiment": "x-000000000001"}]}';
const answer = {
  type: "assistant",
  sessionId: S,
  timestamp: AT,
  message: {
    id: "msg_2",
    model: "claude-test",
    content: [{ type: "text", text: PLAN }],
    usage: { input_tokens: 20, output_tokens: 5 },
  },
};
const ended = { type: "system", sessionId: S, subtype: "turn_duration" };

describe("a planner's call in its own terminal on the fake TUI", { skip }, () => {
  test("its prompt typed, an owner's message taken inside its turn with the call's credential, its answer its last text, its console open until it ends", async () => {
    const env = makeJudgeEnv();
    await env.service.applyCommand(env.assign);
    const api = createHarnessApi(env.service, { supervisor: "sup" });
    const server = serve({ fetch: api.fetch, port: 0, hostname: "127.0.0.1" });
    await new Promise<void>((r) => (server.listening ? r() : server.once("listening", r)));
    try {
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
            payload: { run: "js-1", to: "planner", text: "Give lane-1 the tiling first." },
          },
          env.keys.privateKeyPem,
        ),
      );
      assert.equal(out.status, "applied");
      writeFileSync(
        script,
        JSON.stringify({
          log: ".claude/projects/fake/{session}.jsonl",
          turns: [
            [
              { lines: [said("plan"), read] },
              { hook: "PostToolUse", fields: { tool_name: "Read", tool_use_id: "tu_1" } },
              { lines: [readResult, answer, ended] },
            ],
          ],
          rest: [],
        }),
      );
      const id = plannerCallId("js-1", 1);
      const caller = { run: "js-1", kind: "planner" as const, source: "planner" };
      const auth = env.service.mintCallToken({ id, caller });
      const sent: Prompt[] = [];
      const consoles: string[] = [];
      const plan = await cliAsk(
        claudeProgram,
        MODEL,
        "Plan round 1.",
        {
          runner,
          apiUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
          scratchDir: scratch,
        },
        {
          terminal: {
            id,
            auth,
            title: "The planner",
            messages: {
              waiting: () =>
                env.service.messages
                  .waitingForPlanner("js-1")
                  .map((m) => ({ id: m.id, text: m.text })),
              given: (ids, how) => env.service.messages.read(ids, "planner", { how }),
            },
            turn: (t, turn) => renderPlannerTurn({ ...t, program: "claude-code", turn }),
            sent: (p) => sent.push(p),
            live: () => undefined,
            console: (c) => {
              consoles.push(c ? "open" : "closed");
              if (c) env.service.consoles.setCall(id, { ...caller, lane: "planner" }, c);
              else env.service.consoles.ended(id);
            },
            inTurn: (d) => env.service.inTurn(id, d),
            pollMs: 20,
          },
        },
      );
      env.service.endCall(auth);
      assert.equal(plan, PLAN);
      const reads = env.ledger
        .eventsAfter(0, 5000)
        .events.filter((e) => e.kind === "agent_message_read")
        .map((e) => e.body as { by?: string; how?: string });
      assert.deepEqual(
        reads.map((x) => [x.by, x.how]),
        [["planner", "after-tool"]],
      );
      // Kept as the call's later turn, with the message's id for a rule it asks for.
      assert.equal(sent[0]?.turn, 1);
      assert.match(messageText(sent[0] as Prompt), /"text":"Give lane-1 the tiling first\."/);
      assert.deepEqual(consoles, ["open", "closed"]);
      assert.equal(env.service.work().terminals, undefined);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
