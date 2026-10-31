import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { AdvisorsConfig, advisorsFileReport } from "../../../src/supervisor/advisors/index.ts";
import { advisorsOf, mergeAdvisors, runtimeOf } from "../../../src/supervisor/advisors/routes.ts";
import { testPrompt } from "../../helpers/advisor-prompt.ts";

const route = (o: Partial<Record<string, unknown>> = {}) => ({
  name: "p",
  type: "anthropic",
  base_url: "https://api.anthropic.com",
  model: "claude-test",
  context_window: 0,
  reasoning: "medium",
  api_key: "key-in-memory",
  ...o,
});

describe("advisors from control", () => {
  test("a Claude subscription's role runs in Claude Code; an API key's or a ChatGPT sign-in's runs here; OpenCode's own is skipped", () => {
    assert.deepEqual(
      runtimeOf(
        route({ type: "claude", model: "claude-opus-5-5", effort: "max", api_key: "tok" }),
        "auditor",
      ),
      {
        name: "auditor",
        // The provider's name, for the advisors' model usage.
        provider: "p",
        runtime: "claude-code",
        model: "claude-opus-5-5",
        token: "tok",
        effort: "max",
      },
    );
    const keyed = runtimeOf(route(), "teacher-1");
    assert.equal(keyed?.runtime, "openai");
    assert.equal(keyed?.runtime === "openai" && keyed.api, "anthropic");
    assert.equal(keyed?.runtime === "openai" && keyed.api_key, "key-in-memory");
    assert.equal(keyed?.runtime === "openai" && keyed.reasoning, "medium");
    assert.equal(runtimeOf(route({ type: "opencode" }), "x"), undefined);
    // A ChatGPT sign-in runs here too, on OpenAI's Responses API with its access token.
    const signedIn = runtimeOf(
      route({ type: "chatgpt", base_url: "https://api.openai.com/v1", api_key: "access" }),
      "reviewer-1",
    );
    assert.equal(signedIn?.runtime === "openai" && signedIn.api, "chatgpt");
    assert.equal(signedIn?.runtime === "openai" && signedIn.api_key, "access");
  });

  test("a role from control has no hidden turn, time or reply limit (goal 079); the advisors file can set them", () => {
    const keyed = runtimeOf(route({ type: "openai", base_url: "https://x/v1" }), "teacher-1");
    assert.ok(keyed?.runtime === "openai");
    if (keyed?.runtime !== "openai") return;
    assert.equal(keyed.max_turns, undefined);
    assert.equal(keyed.timeout_s, undefined);
    assert.equal(keyed.max_tokens, undefined, "none listed: none sent");
    // The model's maximum output from the provider's list goes with the route.
    const listed = runtimeOf(
      route({ type: "openai", base_url: "https://x/v1", max_tokens: 64_000 }),
      "teacher-1",
    );
    assert.equal(listed?.runtime === "openai" && listed.max_tokens, 64_000);
    for (const harness of ["opencode", "codex"]) {
      const cli = runtimeOf(route({ type: "openai", harness }), "auditor") as {
        timeout_s?: number;
      };
      assert.equal(cli.timeout_s, undefined, harness);
    }
    // The advisors file: none unless set, and what it sets stays.
    const parsed = AdvisorsConfig.parse({
      teachers: [
        { name: "t", runtime: "openai", base_url: "https://x/v1", model: "m", api_key: "k" },
      ],
    });
    const t = parsed.teachers[0] as { max_turns?: number; timeout_s?: number; max_tokens?: number };
    assert.deepEqual([t.max_turns, t.timeout_s, t.max_tokens], [undefined, undefined, undefined]);
    const set = AdvisorsConfig.parse({
      teachers: [
        {
          name: "t",
          runtime: "openai",
          base_url: "https://x/v1",
          model: "m",
          api_key: "k",
          max_turns: 24,
          timeout_s: 900,
          max_tokens: 8192,
        },
      ],
    });
    const s2 = set.teachers[0] as { max_turns?: number; timeout_s?: number; max_tokens?: number };
    assert.deepEqual([s2.max_turns, s2.timeout_s, s2.max_tokens], [24, 900, 8192]);
  });

  test("each role runs in the harness its route names: OpenCode (its own models too) or Codex", () => {
    // OpenCode's own models: no key, no base address.
    assert.deepEqual(
      runtimeOf(
        route({ type: "opencode", harness: "opencode", model: "big-pickle", api_key: "" }),
        "auditor",
      ),
      {
        name: "auditor",
        provider: "p",
        runtime: "opencode",
        api: "opencode",
        model: "big-pickle",
        context_window: 0,
      },
    );
    // A provider's model in OpenCode: its key stays in memory, for the call's proxy.
    assert.deepEqual(
      runtimeOf(route({ harness: "opencode", context_window: 200_000 }), "teacher-1"),
      {
        name: "teacher-1",
        provider: "p",
        runtime: "opencode",
        api: "anthropic",
        base_url: "https://api.anthropic.com",
        model: "claude-test",
        api_key: "key-in-memory",
        context_window: 200_000,
      },
    );
    // A ChatGPT sign-in in Codex, with its effort.
    assert.deepEqual(
      runtimeOf(
        route({
          type: "chatgpt",
          harness: "codex",
          base_url: "https://chatgpt.example.com/backend-api/codex",
          model: "gpt-sol",
          api_key: "access",
          reasoning: "high",
        }),
        "reviewer-1",
      ),
      {
        name: "reviewer-1",
        provider: "p",
        runtime: "codex",
        api: "chatgpt",
        base_url: "https://chatgpt.example.com/backend-api/codex",
        model: "gpt-sol",
        api_key: "access",
        reasoning: "high",
        context_window: 0,
      },
    );
    // Codex speaks only the Responses API: an Anthropic route in Codex is not run.
    assert.equal(runtimeOf(route({ harness: "codex" }), "x"), undefined);
    // Pi, named or not, runs here.
    assert.equal(runtimeOf(route({ harness: "pi" }), "x")?.runtime, "openai");
    // Each parses as the advisors file's runtimes do.
    for (const r of [
      runtimeOf(route({ harness: "opencode" }), "a"),
      runtimeOf(route({ type: "openai", harness: "codex" }), "b"),
    ])
      assert.deepEqual(AdvisorsConfig.parse({ auditor: r }).auditor, r);
  });

  test("control's roles replace the file's: one or two teachers, the merged by model, the review panel", async () => {
    const file = AdvisorsConfig.parse({
      teachers: [{ name: "t", runtime: "cli", argv: ["x"], restricted: true }],
      merged_by: { name: "m", runtime: "cli", argv: ["z"], restricted: true },
      teacher_minutes: 15,
    });
    // As the rig's config on the bus gives the advisors' routes.
    const from = async (body: Record<string, unknown>) => advisorsOf(body as never);
    // Two teachers on two models, merged by a third: each teacher once, by its own model.
    const two = await from({
      teacher_models: [route({ model: "model-a" }), route({ type: "openai", model: "model-b" })],
      merged_by: route({ model: "model-c" }),
      auditor: null,
      review_panel: route({ model: "model-d" }),
    });
    assert.deepEqual(
      two.teachers?.map((t) => [t.name, t.runtime === "openai" ? t.model : ""]),
      [
        ["teacher-1", "model-a"],
        ["teacher-2", "model-b"],
      ],
    );
    assert.equal(two.merged_by?.name, "merged-by");
    assert.equal(two.merged_by?.runtime === "openai" && two.merged_by.model, "model-c");
    assert.equal(two.review_panel?.length, 3);
    // One teacher: one runtime. No teacher models from control: the file's teachers stay, and
    // control's merged by model (none here) leaves the file's.
    const one = await from({ teacher_models: [route()], merged_by: null, review_panel: null });
    assert.deepEqual(
      one.teachers?.map((t) => t.name),
      ["teacher-1"],
    );
    const none = await from({ teacher_models: [], merged_by: null, review_panel: null });
    assert.equal(none.teachers, undefined);
    const merged = mergeAdvisors(file, none);
    assert.equal(merged?.teachers[0]?.name, "t");
    assert.equal(merged?.merged_by?.name, "m");
  });

  test("the synthesizer and the final writer take their own models from control, else the first teacher's (goal 166)", async () => {
    const file = AdvisorsConfig.parse({
      teachers: [{ name: "t", runtime: "cli", argv: ["x"], restricted: true }],
    });
    const from = async (body: Record<string, unknown>) => advisorsOf(body as never);
    // Their own routes, under their own names.
    const own = await from({
      teacher_models: [route({ model: "model-a" })],
      synthesizer: route({ model: "model-s" }),
      final_writer: route({ type: "claude", model: "claude-opus-5-5", api_key: "tok" }),
    });
    assert.equal(own.synthesizer?.name, "synthesizer");
    assert.equal(own.synthesizer?.runtime === "openai" && own.synthesizer.model, "model-s");
    assert.equal(own.final_writer?.name, "final-writer");
    assert.equal(own.final_writer?.runtime, "claude-code");
    const merged = mergeAdvisors(file, own);
    assert.deepEqual(
      [merged?.synthesizer?.name, merged?.final_writer?.name, merged?.teachers[0]?.name],
      ["synthesizer", "final-writer", "teacher-1"],
    );
    // None from control: neither has a slot, and each pass uses the first teacher's (the file's).
    const none = mergeAdvisors(file, await from({ synthesizer: null, final_writer: null }));
    assert.deepEqual([none?.synthesizer, none?.final_writer], [undefined, undefined]);
    assert.equal(none?.teachers[0]?.name, "t");
    // A synthesizer alone is an advisor to run: the supervisor's loop does not idle.
    const alone = mergeAdvisors(undefined, { synthesizer: own.synthesizer });
    assert.equal(alone?.synthesizer?.name, "synthesizer");
    assert.deepEqual(alone?.teachers, []);
    // The advisors file has no place for them: its schema refuses both.
    for (const key of ["synthesizer", "final_writer"])
      assert.equal(
        AdvisorsConfig.safeParse({
          [key]: { name: "s", runtime: "cli", argv: ["x"], restricted: true },
        }).success,
        false,
        key,
      );
  });

  test("the advisors file takes merged_by and review_panel; the old names combiner and panel are refused", () => {
    const cli = (name: string) => ({ name, runtime: "cli", argv: ["x"], restricted: true });
    const now = AdvisorsConfig.parse({ merged_by: cli("m"), review_panel: [cli("r1")] });
    assert.deepEqual([now.merged_by?.name, now.review_panel.length], ["m", 1]);
    assert.deepEqual(AdvisorsConfig.parse({}).review_panel, []);
    for (const old of [{ combiner: cli("c") }, { panel: [cli("p")] }]) {
      const r = AdvisorsConfig.safeParse({ teachers: [cli("a"), cli("b")], ...old });
      assert.equal(r.success, false, JSON.stringify(old));
    }
    assert.equal(AdvisorsConfig.safeParse({ teachers: [], mergedby: cli("m") }).success, false);
  });

  test("control's routes by the public names only; no routes from control changes nothing", async () => {
    const answered = async (body: Record<string, unknown>) => advisorsOf(body as never);
    // The names of v0.1.0's control are not read.
    const old = await answered({ teachers: route(), combiner: route(), panel: route() });
    assert.deepEqual(old, {
      teachers: undefined,
      merged_by: undefined,
      auditor: undefined,
      review_panel: undefined,
      synthesizer: undefined,
      final_writer: undefined,
    });
    // No file and nothing from control: no advisors at all.
    assert.equal(mergeAdvisors(undefined, {}), undefined);
  });

  test("a Claude Code advisor gets the token on file descriptor 3 and in no environment, no tools, settings or scrub, and its answer is read", async () => {
    // A stand-in for Claude Code: it answers the audit with what it was given (never the token).
    // It reads the token where Claude Code does, from the descriptor its variable names.
    const dir = mkdtempSync(join(tmpdir(), "thermite-cc-adv-"));
    const bin = join(dir, "claude");
    writeFileSync(
      bin,
      `#!/usr/bin/env node
let s = "";
process.stdin.on("data", (d) => (s += d));
process.stdin.on("end", () => {
  const a = process.argv.slice(2);
  const v = (f) => a[a.indexOf(f) + 1];
  const fd = process.env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR;
  const onFd = fd ? require("node:fs").readFileSync(Number(fd), "utf8") : "";
  const inEnv = Object.values(process.env).some((x) => x.includes("tok-advisor"));
  const said = ["token=" + (onFd === "tok-advisor" ? "fd" + fd : "missing"), "env=" + (inEnv ? "has-token" : "clean"), "tools=" + JSON.stringify(v("--tools")), "settings=" + JSON.stringify(v("--setting-sources")), "strict=" + a.includes("--strict-mcp-config"), "model=" + v("--model"), "effort=" + v("--effort"), "scrub=" + process.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB, "prompt=" + (s.includes("look at this change") && s.length > 200000)].join(" ");
  console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: JSON.stringify({ decision: "clear", reasons: said, citations: [] }) }));
});
`,
    );
    chmodSync(bin, 0o755);
    process.env.THERMITE_CLAUDE_BIN = bin;
    const { runAdvisor, AuditAnswer } = await import("../../../src/supervisor/advisors/index.ts");
    const { Type } = await import("@earendil-works/pi-ai");
    // The binary's path is read when the module loads: this test file loads it here first.
    const r = await runAdvisor({
      runtime: {
        name: "auditor",
        runtime: "claude-code",
        model: "claude-opus-5-5",
        token: "tok-advisor",
        effort: "high",
        timeout_s: 30,
      },
      // As large as an audit's package may be: more than one command-line argument may hold.
      prompt: testPrompt(
        "You audit changes.",
        `Please look at this change.\n${"x".repeat(200_000)}`,
      ),
      schema: AuditAnswer,
      answerSchema: Type.Object({}),
    });
    assert.equal(r.error, undefined, r.error);
    assert.equal(r.output?.decision, "clear");
    assert.equal(
      r.output?.reasons,
      'token=fd3 env=clean tools="" settings="" strict=true model=claude-opus-5-5 effort=high scrub=undefined prompt=true',
    );
  });
});

/**
 * What the supervisor tells control of its advisors file (goal 074), so that Edit rig can say what
 * an advisor with no model from control uses: for each role, where it runs, its model, its
 * provider's name and kind, its window and its point. Never a key, a token, a key file's path, a
 * base address or a command line.
 */
describe("the supervisor's report of its advisors file", () => {
  test("each role's model, harness, provider and window, and no key, token, address or path", () => {
    const secrets = [
      "secret-password",
      "teacher-key-for-tests",
      "token-for-claude-tests",
      "merged-key-for-tests",
      "cli-token-for-tests",
      "/run/secrets/",
      "llm.example.com",
      "kb.example.com",
      "user:pw",
    ];
    const file = AdvisorsConfig.parse({
      teachers: [
        {
          name: "teacher-a",
          runtime: "openai",
          api: "anthropic",
          base_url: "https://user:secret-password@llm.example.com/v1",
          model: "model-a",
          api_key: "teacher-key-for-tests",
          provider: "my-litellm",
          compact_at: 70,
        },
        {
          name: "teacher-b",
          runtime: "claude-code",
          model: "opus-5.5",
          token: "token-for-claude-tests",
          context_window: 200_000,
        },
      ],
      merged_by: {
        name: "merged-by",
        runtime: "codex",
        api: "chatgpt",
        base_url: "https://llm.example.com/v1",
        model: "gpt-sol",
        api_key: "merged-key-for-tests",
      },
      auditor: {
        name: "auditor",
        runtime: "cli",
        argv: ["my-agent", "--token", "cli-token-for-tests"],
        restricted: true,
      },
      review_panel: [
        {
          name: "reviewer-a",
          runtime: "opencode",
          base_url: "https://llm.example.com/v1",
          // A model value with credentials in it is left out, not sent.
          model: "https://user:pw@llm.example.com/model-b",
          api_key_file: "/run/secrets/llm-key",
        },
      ],
      kb: { mcp_url: "https://kb.example.com/mcp", token_file: "/run/secrets/kb-token" },
    });
    const report = advisorsFileReport(file);
    assert.deepEqual(report, {
      teachers: [
        {
          harness: "pi",
          model: "model-a",
          provider: "my-litellm",
          api: "anthropic",
          context_window: 200_000,
          compact_at: 70,
        },
        {
          harness: "claude-code",
          model: "opus-5.5",
          provider: null,
          api: "claude",
          context_window: 200_000,
          compact_at: null,
        },
      ],
      merged_by: {
        harness: "codex",
        model: "gpt-sol",
        provider: null,
        api: "chatgpt",
        context_window: null,
        compact_at: null,
      },
      auditor: {
        harness: "cli",
        model: null,
        provider: null,
        api: null,
        context_window: null,
        compact_at: null,
      },
      review_panel: [
        {
          harness: "opencode",
          model: null,
          provider: null,
          api: "openai",
          context_window: null,
          compact_at: null,
        },
      ],
    });
    const sent = JSON.stringify(report);
    for (const secret of secrets)
      assert.ok(!sent.includes(secret), `the report leaves out ${secret}`);
  });

  test("no file, or a file that names no advisor: every role empty", () => {
    const none = { teachers: [], merged_by: null, auditor: null, review_panel: [] };
    assert.deepEqual(advisorsFileReport(undefined), none);
    assert.deepEqual(advisorsFileReport(AdvisorsConfig.parse({ teacher_minutes: 30 })), none);
  });
});
