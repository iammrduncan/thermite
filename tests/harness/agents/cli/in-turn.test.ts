/**
 * The owner's messages inside an agent's turn in Claude Code, Codex and OpenCode (goal 169): the
 * trial loop's TurnMessages, and the whole way in, through the harness's trial routes with the
 * trial's token, Thermite's hook program run as Claude Code and Codex run it, and Thermite's
 * OpenCode plugin.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { serve } from "@hono/node-server";
import { claudeProgram } from "../../../../src/agents/cli/claude-code.ts";
import { codexProgram } from "../../../../src/agents/cli/codex.ts";
import { OFFER_MS, TurnMessages } from "../../../../src/agents/cli/in-turn.ts";
import { opencodeProgram } from "../../../../src/agents/cli/opencode.ts";
import type { CliProgram, CliTally } from "../../../../src/agents/cli/program.ts";
import type { ModelConfig } from "../../../../src/agents/model/index.ts";
import { codexHooks } from "../../../../src/agents/programs/codex/index.ts";
import {
  type OpencodePluginContext,
  thermitePlugin,
} from "../../../../src/agents/programs/opencode/plugin.ts";
import { messageText, type Prompt } from "../../../../src/agents/prompt.ts";
import { renderWorkerTurn } from "../../../../src/agents/roles/index.ts";
import { OWNER_LINE_HEAD, OWNER_TURN_HEAD } from "../../../../src/agents/roles/shared.ts";
import type { MessageHow } from "../../../../src/core/agents.ts";
import { TURN_OFFER, TURN_TAKEN } from "../../../../src/core/api/harness/turn.ts";
import { signEnvelope } from "../../../../src/core/commands.ts";
import { partText } from "../../../../src/core/prompts.ts";
import { runCliTrial } from "../../../../src/harness/agents/cli/loop.ts";
import { Registry } from "../../../../src/harness/agents/registry.ts";
import { createHarnessApi } from "../../../../src/harness/api/index.ts";
import type { Runner, RunOutcome, RunRequest } from "../../../../src/harness/broker/runner.ts";
import { keepPrompt } from "../../../../src/harness/prompts.ts";
import { makeJudgeEnv } from "../../../helpers/judge-env.ts";

describe("TurnMessages: one message at a time, offered, then read with how it went in", () => {
  /** An inbox as the harness's: messages wait until given; each given one with its how. */
  function inbox(texts: string[]) {
    let waiting = texts.map((text, i) => ({ id: i + 1, text }));
    const given: [number, MessageHow | undefined][] = [];
    return {
      given,
      inbox: {
        waiting: () => waiting,
        given: (ids: number[], how?: MessageHow) => {
          for (const id of ids) given.push([id, how]);
          waiting = waiting.filter((m) => !ids.includes(m.id));
        },
      },
    };
  }
  function turns(texts: string[], held: number[] = [], taking = () => true) {
    const box = inbox(texts);
    let said = 0;
    let now = 1_000_000;
    const sent: Prompt[] = [];
    const lines: string[] = [];
    const t = new TurnMessages({
      inbox: box.inbox,
      render: ({ text }, turn) =>
        renderWorkerTurn({ program: "claude-code", turn, kind: "owner", text }),
      next: () => ++said,
      held: () => held,
      taking,
      sent: (p) => sent.push(p),
      live: (entries) => lines.push(...entries.map((e) => e.text)),
      how: { "after-tool": "the PostToolUse hook", "turn-end": "the Stop hook" },
      now: () => now,
    });
    return {
      t,
      box,
      sent,
      lines,
      later: (ms: number) => {
        now += ms;
      },
    };
  }

  test("nothing is offered while no run is under way; an offer reads nothing until its receipt", () => {
    const { t, box, sent, lines } = turns(["Look at the cache."]);
    assert.equal(t.offer("after-tool"), undefined);
    t.open();
    const o = t.offer("after-tool");
    assert.equal(o?.text, `${OWNER_TURN_HEAD}\n\nLook at the cache.`);
    assert.deepEqual(box.given, []);
    assert.equal(t.offer("turn-end"), undefined, "held for the hook that asked");
    assert.deepEqual(t.taken(o?.offer ?? ""), [1]);
    assert.deepEqual(box.given, [[1, "after-tool"]]);
    assert.deepEqual(
      sent.map((p) => [p.role, p.program, p.turn, messageText(p)]),
      [["worker", "claude-code", 1, o?.text]],
    );
    assert.deepEqual(lines, [
      "the owner's message #1 went in inside its turn, after a tool (the PostToolUse hook)",
    ]);
    assert.deepEqual(t.taken(o?.offer ?? ""), [], "each message once");
    assert.deepEqual(t.taken("no-such-offer"), []);
  });

  test("a message a continuation carries is never offered; one offered and never taken waits for the run's end, or for OFFER_MS", () => {
    const { t, box, later } = turns(["first", "second", "third"], [1]);
    t.open();
    const a = t.offer("after-tool");
    assert.equal(a?.text.endsWith("second"), true, "message 1 is the continuation's");
    const b = t.offer("turn-end");
    assert.equal(b?.text.endsWith("third"), true);
    assert.equal(t.offer("after-tool"), undefined);
    later(OFFER_MS + 1);
    const again = t.offer("after-tool");
    assert.equal(again?.text.endsWith("second"), true, "a hook that died leaves it for another");
    assert.deepEqual(t.taken(a?.offer ?? ""), [2], "a late receipt still counts");
    assert.deepEqual(t.taken(again?.offer ?? ""), [], "and the message is read once");
    t.close();
    assert.deepEqual(t.taken(b?.offer ?? ""), [], "the run ended: it waits for the continuation");
    assert.deepEqual(box.given, [[2, "after-tool"]]);
  });

  test("once the trial submitted, nothing more is offered: the lane's next trial reads it", () => {
    let submitted = false;
    const { t } = turns(["late"], [], () => !submitted);
    t.open();
    submitted = true;
    assert.equal(t.offer("after-tool"), undefined);
  });
});

// ------------------------------------------------------------------ the whole way in

type Env = ReturnType<typeof makeJudgeEnv>;

/** An owner's message to a trial, as control signs it. */
async function tell(env: Env, to: string, text: string) {
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
  assert.equal(out.status, "applied", JSON.stringify(out));
}

const reads = (env: Env) =>
  env.ledger
    .eventsAfter(0, 5000)
    .events.filter((e) => e.kind === "agent_message_read")
    .map((e) => e.body as { message: number; trial?: string; how?: string });

/** The later turns a trial kept, oldest first: their place and their text. */
const kept = (env: Env, trial: string) =>
  env.ledger.prompts
    .list("js-1")
    .filter((p) => p.trial === trial && p.turn > 0)
    .map((p) => env.ledger.prompts.get(p.id))
    .map((p) => [p?.turn, p?.program, partText(p?.sections ?? [], "message")]);

/** A hook run as its program runs it: a command and its arguments, or a shell line. */
function runHook(
  argv: string[],
  env: Record<string, string>,
  input: Record<string, unknown>,
): Promise<string> {
  return new Promise((resolve) => {
    const p = spawn(argv[0] as string, argv.slice(1), { env });
    let out = "";
    p.stdout.on("data", (d) => {
      out += d;
    });
    p.on("close", () => resolve(out));
    p.stdin.end(JSON.stringify(input));
  });
}

const ok = (): RunOutcome =>
  ({ exitCode: 0, signal: null, killedFor: null, stdout: "", stderr: "" }) as RunOutcome;
const jsonl = (xs: unknown[]) => `${xs.map((x) => JSON.stringify(x)).join("\n")}\n`;

describe("an owner's message inside the agent's turn, the whole way in (goal 169)", () => {
  const env = makeJudgeEnv({ lanes: { count: 2, trials_per_epoch: 1 } });
  const api = createHarnessApi(env.service, { supervisor: "sup" });
  const server = serve({ fetch: api.fetch, port: 0, hostname: "127.0.0.1" });
  const url = () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let n = 0;
  before(async () => {
    await env.service.applyCommand(env.assign);
    await new Promise<void>((r) => (server.listening ? r() : server.once("listening", r)));
  });
  after(() => new Promise<void>((r) => server.close(() => r())));

  /** A trial of lane-1 with its token, in the ledger, and its area. */
  function startTrial(lane = "lane-1") {
    const id = `t-${String(++n).padStart(16, "0")}`;
    const token = `tok-${n}`;
    new Registry(env.ledger).startTrial({
      id,
      run: "js-1",
      lane,
      epoch: n,
      family: "f",
      parent: "p",
      token,
    });
    const area = mkdtempSync(join(tmpdir(), "thermite-in-turn-"));
    mkdirSync(join(area, "repo"));
    return { id, token, lane, area };
  }

  /** One code trial in `p`, with the harness's own inbox, routes and records for it. */
  function trial<T extends CliTally>(
    p: CliProgram<T>,
    t: ReturnType<typeof startTrial>,
    model: ModelConfig,
    runner: Runner,
  ) {
    const at = { id: t.id, run: "js-1", lane: t.lane };
    return runCliTrial(
      p,
      {
        mode: "code",
        spec: {
          trialId: t.id,
          token: t.token,
          run: "js-1",
          lane: t.lane,
          workspace: join(t.area, "repo"),
          workspaceRoot: t.area,
          parentCommit: "c".repeat(40),
          editablePaths: ["src/**"],
          brief: "Make it faster.",
        },
      },
      {
        runner,
        model,
        apiUrl: url(),
        live: (entries) => env.service.trialReport(at, { entries }),
        progress: () => undefined,
        submitted: () => undefined,
        messages: env.service.trialInbox(at),
        inTurn: (d) => env.service.inTurn(t.id, d),
        sent: (q) => keepPrompt(env.ledger, "js-1", q, { lane: t.lane, trial: t.id }),
        pollMs: 5,
      },
    );
  }

  test("the routes give a hook only its own trial's messages, and nothing without its trial's token", async () => {
    const mine = startTrial("lane-1");
    const other = startTrial("lane-2");
    await tell(env, `trial:${mine.id}`, "only for the first trial");
    // The other trial's own way in, as its loop sets it: its inbox is its own.
    const theirs = new TurnMessages({
      inbox: env.service.trialInbox({ id: other.id, run: "js-1", lane: "lane-2" }),
      render: ({ text }, turn) =>
        renderWorkerTurn({ program: "claude-code", turn, kind: "owner", text }),
      next: () => 1,
      held: () => [],
      live: () => undefined,
      how: { "after-tool": "x", "turn-end": "y" },
    });
    theirs.open();
    env.service.inTurn(other.id, theirs);
    const call = (path: string, body: unknown, auth?: string) =>
      fetch(`${url()}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) },
        body: JSON.stringify(body),
      });
    const offered = await call(
      TURN_OFFER.path,
      { at: "after-tool" },
      `Bearer trial.${other.token}`,
    );
    assert.deepEqual(await offered.json(), { offer: null, text: "" });
    assert.equal((await call(TURN_OFFER.path, { at: "after-tool" })).status, 401);
    assert.equal(
      (await call(TURN_OFFER.path, { at: "after-tool" }, "Bearer trial.forged")).status,
      401,
    );
    assert.equal(
      (await call(TURN_OFFER.path, { at: "anywhere" }, `Bearer trial.${mine.token}`)).status,
      400,
    );
    assert.deepEqual(
      await (await call(TURN_TAKEN.path, { offer: "forged" }, `Bearer trial.${mine.token}`)).json(),
      { messages: [] },
      "a trial with no run under way takes nothing",
    );
    env.service.inTurn(other.id, undefined);
    assert.equal(reads(env).length, 0);
  });

  test("Claude Code: the PostToolUse hook gives the first message, the Stop hook the second; a third sent after the turn goes in the continuation", async () => {
    const t = startTrial();
    await tell(env, `trial:${t.id}`, "Look at the cache misses first.");
    await tell(env, `trial:${t.id}`, "Keep the change small.");
    const printed: string[] = [];
    const prompts: string[] = [];
    const runner = {
      run: async (req: RunRequest): Promise<RunOutcome> => {
        if (req.argv.join(" ").includes("cat > claude-prompt.txt")) prompts.push(String(req.stdin));
        if (!req.argv.includes("-p")) return ok();
        const e = req.env as Record<string, string>;
        const settings = JSON.parse(req.argv[req.argv.indexOf("--settings") + 1] ?? "{}");
        const hook = (event: string) => {
          const h = settings.hooks[event][0].hooks[0];
          return runHook([h.command, ...h.args], e, {
            session_id: "s-1",
            hook_event_name: event,
            tool_name: "Bash",
            tool_use_id: "tu_1",
          });
        };
        const first = prompts.length === 1;
        if (first) {
          printed.push(await hook("PreToolUse"), await hook("PostToolUse"));
          printed.push(await hook("Stop"));
          // Sent once the turn has ended: no hook takes it inside this run.
          await tell(env, `trial:${t.id}`, "Then profile it.");
        }
        appendFileSync(
          e.THERMITE_CLAUDE_EVENTS as string,
          jsonl([
            {
              type: "assistant",
              session_id: "s-1",
              message: {
                id: `msg_${prompts.length}`,
                content: first
                  ? [{ type: "tool_use", id: "tu_1", name: "Bash", input: { command: "make" } }]
                  : [{ type: "text", text: "No change worth judging." }],
                usage: { input_tokens: 1, output_tokens: 1 },
              },
            },
            {
              type: "result",
              subtype: "success",
              is_error: false,
              result: "ok",
              session_id: "s-1",
            },
          ]),
        );
        await new Promise((r) => setTimeout(r, 30));
        return ok();
      },
      killRole: async () => 0,
    } as unknown as Runner;
    await trial(
      claudeProgram,
      t,
      {
        api: "claude",
        harness: "claude-code",
        baseUrl: "https://api.anthropic.com",
        model: "claude-test",
        apiKey: "token",
        contextWindow: 1_000_000,
        maxTokens: 0,
      },
      runner,
    );
    assert.equal(printed[0], "", "nothing before a tool");
    const context = JSON.parse(printed[1] ?? "{}").hookSpecificOutput?.additionalContext;
    assert.equal(context, `${OWNER_TURN_HEAD}\n\nLook at the cache misses first.`);
    const blocked = JSON.parse(printed[2] ?? "{}");
    assert.deepEqual(blocked, {
      decision: "block",
      reason: `${OWNER_TURN_HEAD}\n\nKeep the change small.`,
    });
    assert.match(prompts[1] ?? "", new RegExp(`${OWNER_LINE_HEAD} Then profile it\\.$`));
    assert.doesNotMatch(prompts[1] ?? "", /cache misses|change small/, "each message once");
    assert.deepEqual(
      reads(env)
        .filter((r) => r.trial === t.id)
        .map((r) => r.how),
      ["after-tool", "turn-end", "continuation"],
    );
    // Each kept as a later turn of the trial, with its place in the call, as it was given.
    assert.deepEqual(kept(env, t.id), [
      [1, "claude-code", context],
      [2, "claude-code", blocked.reason],
      [3, "claude-code", prompts[1]],
    ]);
    const lines = env.service.live.since(0, 5000).entries.map((l) => l.text);
    assert.ok(
      lines.some((l) =>
        /^the owner's message #\d+ went in inside its turn, after a tool \(Claude Code's PostToolUse hook\)$/.test(
          l,
        ),
      ),
    );
    assert.ok(
      lines.some((l) => /went in at the end of its turn.*\(Claude Code's Stop hook\)$/.test(l)),
    );
  });

  test("Codex: its hooks.json's command, run through a shell, gives the message after a tool", async () => {
    const t = startTrial();
    await tell(env, `trial:${t.id}`, "Try tiling.");
    const printed: string[] = [];
    const command = JSON.parse(codexHooks()).hooks.PostToolUse[0].hooks[0].command as string;
    const runner = {
      run: async (req: RunRequest): Promise<RunOutcome> => {
        if (!req.argv.includes("exec")) return ok();
        assert.ok(req.argv.includes("--dangerously-bypass-hook-trust"));
        const e = req.env as Record<string, string>;
        printed.push(
          await runHook(["/bin/sh", "-c", command], e, {
            session_id: "th-1",
            hook_event_name: "PostToolUse",
            tool_name: "Bash",
            tool_use_id: "call_1",
          }),
        );
        appendFileSync(
          e.THERMITE_CODEX_EVENTS as string,
          jsonl([
            { type: "thread.started", thread_id: "th-1" },
            { type: "item.completed", item: { id: "i1", type: "agent_message", text: "Done." } },
            { type: "turn.completed", usage: { input_tokens: 5, output_tokens: 2 } },
          ]),
        );
        await new Promise((r) => setTimeout(r, 30));
        return ok();
      },
      killRole: async () => 0,
    } as unknown as Runner;
    await trial(
      codexProgram,
      t,
      { baseUrl: "https://p.example/v1", model: "m", apiKey: "k", contextWindow: 0, maxTokens: 0 },
      runner,
    );
    assert.equal(
      JSON.parse(printed[0] ?? "{}").hookSpecificOutput?.additionalContext,
      `${OWNER_TURN_HEAD}\n\nTry tiling.`,
    );
    assert.deepEqual(
      reads(env)
        .filter((r) => r.trial === t.id)
        .map((r) => r.how),
      ["after-tool"],
    );
    assert.deepEqual(kept(env, t.id)[0], [1, "codex", `${OWNER_TURN_HEAD}\n\nTry tiling.`]);
  });

  test("OpenCode: Thermite's plugin steers the message in when a tool starts, and sends the receipt once OpenCode took it in", async () => {
    const t = startTrial();
    await tell(env, `trial:${t.id}`, "Try unrolling.");
    const steered: { sessionID: string; text: string; delivery: string }[] = [];
    let readBeforeDelivery = -1;
    const runner = {
      run: async (req: RunRequest): Promise<RunOutcome> => {
        if (!req.argv.includes("run")) return ok();
        const e = req.env as Record<string, string>;
        // OpenCode's process, with the plugin loaded and its events.
        const events: unknown[] = [];
        let wake: (() => void) | undefined;
        const ctx: OpencodePluginContext = {
          session: {
            hook: async () => undefined,
            context: async () => [],
            get: async () => ({ id: "ses_1" }),
            prompt: async (input) => {
              steered.push(input);
              return { id: "msg_steer" };
            },
          },
          event: {
            subscribe: () => ({
              [Symbol.asyncIterator]: () => ({
                next: () =>
                  new Promise<IteratorResult<unknown>>((resolve) => {
                    const take = () => resolve({ done: false, value: events.shift() });
                    if (events.length) take();
                    else wake = take;
                  }),
              }),
            }),
          },
        };
        const emit = async (type: string, data: Record<string, unknown>) => {
          events.push({ type, data: { sessionID: "ses_1", ...data } });
          wake?.();
          await new Promise((r) => setTimeout(r, 60));
        };
        const stop = await thermitePlugin(e).setup(ctx);
        await emit("session.tool.called", { id: "call_1", input: { command: "make" } });
        await new Promise((r) => setTimeout(r, 200));
        const text = steered[0]?.text ?? "";
        await emit("session.inbox.enqueued", {
          inboxID: "msg_steer",
          item: { type: "user", payload: { text }, delivery: "steer" },
        });
        if (readBeforeDelivery < 0)
          readBeforeDelivery = reads(env).filter((r) => r.trial === t.id).length;
        await emit("session.inbox.delivered", { inboxID: "msg_steer" });
        await new Promise((r) => setTimeout(r, 200));
        stop?.();
        appendFileSync(
          e.THERMITE_OPENCODE_EVENTS as string,
          jsonl([
            { type: "text", sessionID: "ses_1", part: { text: "Done." } },
            { type: "step_finish", sessionID: "ses_1", part: { tokens: { input: 1, output: 1 } } },
          ]),
        );
        await new Promise((r) => setTimeout(r, 30));
        return ok();
      },
      killRole: async () => 0,
    } as unknown as Runner;
    await trial(
      opencodeProgram,
      t,
      { baseUrl: "https://p.example/v1", model: "m", apiKey: "k", contextWindow: 0, maxTokens: 0 },
      runner,
    );
    assert.deepEqual(steered, [
      { sessionID: "ses_1", text: `${OWNER_TURN_HEAD}\n\nTry unrolling.`, delivery: "steer" },
    ]);
    assert.equal(readBeforeDelivery, 0, "read only once OpenCode took it in");
    assert.deepEqual(
      reads(env)
        .filter((r) => r.trial === t.id)
        .map((r) => r.how),
      ["after-tool"],
    );
    assert.deepEqual(kept(env, t.id)[0], [1, "opencode", steered[0]?.text]);
  });
});
