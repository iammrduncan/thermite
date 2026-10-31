import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { Type } from "@earendil-works/pi-ai";
import { z } from "zod";
import { type AdvisorRuntime, runAdvisor } from "../../../src/supervisor/advisors/index.ts";
import { advisorKeeper } from "../../../src/supervisor/advisors/pass/index.ts";
import { testPrompt } from "../../helpers/advisor-prompt.ts";

/**
 * An advisor's own program compacting its call (goal 070): Claude Code's PreCompact hook, Codex's
 * compaction prompt and rollout, and Thermite's OpenCode plugin keep the conversation before each
 * compaction, the summary names where the supervisor keeps it, and the supervisor keeps it with
 * the round's records and says so in the run's live view. Each stand-in compacts once, as the
 * pinned program does it, and answers; no real program and no download.
 */

/** The stand-ins, by program: each compacts once, then answers `{"ok": true}`. */
const STAND_IN: Record<"claude" | "codex" | "opencode", string> = {
  // Claude Code with `-p --output-format json`: its transcript, its PreCompact hook as Thermite's
  // settings name it (no shell), the compaction's boundary and summary, then its JSON result.
  claude: `const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
fs.readFileSync(0, "utf8");
const transcript = path.join(process.env.HOME, ".claude", "projects", "-call", "s-adv.jsonl");
fs.mkdirSync(path.dirname(transcript), { recursive: true });
const line = (e) => JSON.stringify(e) + "\\n";
fs.writeFileSync(transcript, line({ type: "user", message: { content: "Audit this change." } }));
const settings = JSON.parse(args[args.indexOf("--settings") + 1] || "{}");
const hook = settings.hooks.PreCompact[0].hooks[0];
const said = spawnSync(hook.command, hook.args, {
  input: JSON.stringify({ session_id: "s-adv", transcript_path: transcript, trigger: "auto" }),
  encoding: "utf8",
});
fs.appendFileSync(transcript, line({ type: "system", subtype: "compact_boundary", compactMetadata: { preTokens: 150000 } }));
fs.appendFileSync(transcript, line({ type: "user", isCompactSummary: true, message: { content: "Read the diff. " + said.stdout.trim() } }));
console.log(JSON.stringify({ type: "result", session_id: "s-adv", result: JSON.stringify({ ok: true }) }));
`,
  // Codex with a rollout (no --ephemeral): the compaction in its rollout, its summary following
  // Thermite's compaction prompt, and the warning it gives after each compaction.
  codex: `const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
fs.readFileSync(0, "utf8");
const config = fs.readFileSync(path.join(process.env.CODEX_HOME, "config.toml"), "utf8");
const set = /^compact_prompt = (".*")$/m.exec(config);
const prompt = set ? JSON.parse(set[1]) : "";
const where = /before this point in (\\S+?)\\/(?: \\([^)]*\\))?, as the newest file named (\\S+)-<number>\\.md/.exec(prompt);
const thread = "0199a213-0000-7000-8000-00000000adv1";
const out = (e) => process.stdout.write(JSON.stringify(e) + "\\n");
out({ type: "thread.started", thread_id: thread });
if (where && !args.includes("--ephemeral")) {
  const day = path.join(process.env.CODEX_HOME, "sessions", "2026", "10", "21");
  fs.mkdirSync(day, { recursive: true });
  const line = (e) => JSON.stringify(e) + "\\n";
  fs.writeFileSync(
    path.join(day, "rollout-2026-10-21T00-00-00-" + thread + ".jsonl"),
    line({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Audit this change." }] } }) +
      line({ type: "compacted", payload: { message: "Read the diff. Kept in " + where[1] + "/" + where[2] + "-1.md." } }),
  );
  out({ type: "item.completed", item: { id: "i1", type: "error", message: "Heads up: Long threads and multiple compactions can cause the model to be less accurate. Start a new thread when possible to keep threads small and targeted." } });
}
out({ type: "item.completed", item: { id: "i2", type: "agent_message", text: JSON.stringify({ ok: true, ephemeral: args.includes("--ephemeral"), prompt: Boolean(set) }) } });
`,
  // OpenCode with Thermite's plugin, loaded from its own settings as OpenCode loads it: the
  // compaction hook, then the end of the compaction.
  opencode: `const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
fs.readFileSync(0, "utf8");
(async () => {
  const dir = path.join(process.env.HOME, ".config", "opencode", "plugins");
  const file = fs.readdirSync(dir).find((f) => f.startsWith("thermite."));
  const plugin = (await import(pathToFileURL(path.join(dir, file)).href)).default;
  let hook;
  let wake;
  const events = [];
  const stop = await plugin.setup({
    session: {
      hook: async (_name, cb) => { hook = cb; },
      context: async () => [{ type: "user", text: "Audit this change." }],
      get: async () => ({ id: "ses_adv" }),
    },
    event: {
      subscribe: () => ({
        [Symbol.asyncIterator]: () => ({
          next: () => new Promise((resolve) => {
            const take = () => resolve({ done: false, value: events.shift() });
            if (events.length) take(); else wake = take;
          }),
        }),
      }),
    },
  });
  const e = { sessionID: "ses_adv", system: [], messages: [] };
  await hook(e);
  events.push({ type: "session.compaction.ended", data: { sessionID: "ses_adv", text: "## Objective\\n- audit\\n\\n## Relevant Files\\n- " + e.system[0].text } });
  if (wake) wake();
  await new Promise((r) => setTimeout(r, 50));
  if (stop) stop();
  const out = (x) => process.stdout.write(JSON.stringify(x) + "\\n");
  out({ type: "text", sessionID: "ses_adv", part: { text: JSON.stringify({ ok: true }) } });
  process.exit(0);
})();
`,
};

/** Writes the stand-in and points Thermite at it while `run` runs. */
async function withStandIn<T>(
  kind: "claude" | "codex" | "opencode",
  run: () => Promise<T>,
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), `thermite-fake-${kind}-`));
  const bin = join(dir, kind);
  writeFileSync(bin, `#!/usr/bin/env node\n${STAND_IN[kind]}`);
  chmodSync(bin, 0o755);
  const variable = {
    claude: "THERMITE_CLAUDE_BIN",
    codex: "THERMITE_CODEX_BIN",
    opencode: "THERMITE_OPENCODE_BIN",
  }[kind];
  const before = process.env[variable];
  process.env[variable] = bin;
  try {
    return await run();
  } finally {
    if (before === undefined) delete process.env[variable];
    else process.env[variable] = before;
  }
}

const Answer = z.object({
  ok: z.boolean(),
  ephemeral: z.boolean().optional(),
  prompt: z.boolean().optional(),
});

async function advise(rt: AdvisorRuntime) {
  const home = mkdtempSync(join(tmpdir(), "thermite-supervisor-home-"));
  const said: string[] = [];
  const r = await runAdvisor({
    runtime: rt,
    prompt: testPrompt("You audit.", "Audit this."),
    schema: Answer,
    answerSchema: Type.Object({ ok: Type.Boolean() }),
    keeper: advisorKeeper(home, "r-1", (text) => said.push(text)),
  });
  return { r, home, said };
}

describe("an advisor's own program compacting its call (goal 070)", () => {
  test("Claude Code: its hook keeps the conversation, the summary names the supervisor's record, and the round lists it", async () => {
    const { r, home, said } = await withStandIn("claude", () =>
      advise({ name: "auditor", runtime: "claude-code", model: "m", token: "tok", timeout_s: 30 }),
    );
    assert.equal(r.error, undefined, r.error);
    assert.deepEqual(r.output, { ok: true });
    const c = r.compactions?.[0];
    assert.equal(r.compactions?.length, 1);
    assert.equal(c?.how, "harness");
    assert.equal(c?.harness, "claude-code");
    assert.equal(c?.tokens_before, 150_000);
    assert.match(
      c?.kept ?? "",
      /^the supervisor's records, advisors\/compactions\/r-1\/.+-auditor-1\.md$/,
    );
    // The summary names the same file, as the hook told it to.
    const name = /advisors\/compactions\/r-1\/(.+-auditor-1\.md)$/.exec(c?.kept ?? "")?.[1] ?? "";
    assert.ok(
      (c?.summary ?? "").endsWith(
        `in advisors/compactions/r-1/${name} (the supervisor's records). Name that file in your summary, as where the conversation is kept.`,
      ),
      c?.summary,
    );
    const kept = readFileSync(join(home, "advisors", "compactions", "r-1", name), "utf8");
    assert.match(
      kept,
      /^# Advisor auditor: the conversation before compaction 1[\s\S]*Audit this change/,
    );
    assert.match(
      said[0] ?? "",
      /^advisor auditor: its conversation was compacted by Claude Code \(compaction 1\) at about 150,000 tokens\. It goes on\. The conversation before it is kept in the supervisor's records/,
    );
    assert.match(
      said[1] ?? "",
      /^advisor auditor: the summary after compaction 1:\n\nRead the diff\./,
    );
  });

  test("Codex: its rollout is kept (no --ephemeral), and its compaction prompt names the supervisor's record", async () => {
    const { r, home } = await withStandIn("codex", () =>
      advise({
        name: "teacher-1",
        runtime: "codex",
        api: "openai",
        base_url: "http://127.0.0.1:9/v1",
        model: "gpt-x",
        api_key: "k",
        context_window: 128_000,
        timeout_s: 30,
      }),
    );
    assert.equal(r.error, undefined, r.error);
    assert.deepEqual(r.output, { ok: true, ephemeral: false, prompt: true });
    const c = r.compactions?.[0];
    assert.equal(c?.harness, "codex");
    assert.equal(c?.tokens_before, null);
    const name = /\/([^/]+-teacher-1-1\.md)$/.exec(c?.kept ?? "")?.[1] ?? "";
    assert.equal(c?.summary, `Read the diff. Kept in advisors/compactions/r-1/${name}.`);
    assert.match(
      readFileSync(join(home, "advisors", "compactions", "r-1", name), "utf8"),
      /Codex CLI's own rollout[\s\S]*Audit this change/,
    );
  });

  test("OpenCode: Thermite's plugin, linked into its settings, keeps the session and names the supervisor's record", async () => {
    const { r, home } = await withStandIn("opencode", () =>
      advise({
        name: "reviewer-1",
        runtime: "opencode",
        api: "opencode",
        model: "big-pickle",
        context_window: 0,
        timeout_s: 30,
      }),
    );
    assert.equal(r.error, undefined, r.error);
    const c = r.compactions?.[0];
    assert.equal(c?.harness, "opencode");
    assert.match(
      c?.summary ?? "",
      /## Relevant Files\n- Thermite keeps the whole conversation before this compaction in advisors\/compactions\/r-1\/.+-reviewer-1-1\.md \(the supervisor's records\)\./,
    );
    const name = /\/([^/]+-reviewer-1-1\.md)$/.exec(c?.kept ?? "")?.[1] ?? "";
    assert.ok(existsSync(join(home, "advisors", "compactions", "r-1", name)));
  });

  test("with no keeper, the call is as before: no hook, no plugin, and Codex keeps no session", async () => {
    const r = await withStandIn("codex", () =>
      runAdvisor({
        runtime: {
          name: "teacher-1",
          runtime: "codex",
          api: "openai",
          base_url: "http://127.0.0.1:9/v1",
          model: "gpt-x",
          api_key: "k",
          context_window: 0,
          timeout_s: 30,
        },
        prompt: testPrompt("You audit.", "Audit this."),
        schema: Answer,
        answerSchema: Type.Object({ ok: Type.Boolean() }),
      }),
    );
    assert.equal(r.error, undefined, r.error);
    assert.deepEqual(r.output, { ok: true, ephemeral: true, prompt: false });
    assert.equal(r.compactions, undefined);
  });
});
