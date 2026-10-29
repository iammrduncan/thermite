import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, type TestContext, test } from "node:test";
import { Type } from "@earendil-works/pi-ai";
import { z } from "zod";
import { CODEX_ADVISOR_OFF } from "../../../src/supervisor/advisors/cli.ts";
import { type AdvisorRuntime, runAdvisor } from "../../../src/supervisor/advisors/index.ts";
import { serveAdvisorModel } from "../../../src/supervisor/advisors/proxy.ts";
import { testPrompt } from "../../helpers/advisor-prompt.ts";

/**
 * Advisors in OpenCode v2 and the Codex CLI in the supervisor (goal 073), each with a stand-in
 * for the CLI: it reads the configuration the supervisor wrote in its folder, calls the model
 * through the provider its configuration names (the supervisor's proxy for the call), calls the
 * past-research search over MCP with the token in its environment, and answers with what it saw
 * as its last message, in the CLI's own JSON events. No real CLI and no download.
 */

/** A made-up provider key: it must reach the provider, and nothing the CLI can read. */
const KEY = "advisorproviderkeyfortests";

/** The provider: what each call's credential was, by path. */
async function provider(t: TestContext) {
  const seen: { path: string; headers: IncomingHttpHeaders }[] = [];
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      seen.push({ path: `${req.method} ${req.url}`, headers: req.headers });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, seen };
}

/**
 * The stand-in: `kind` is "codex" or "opencode". It prints the CLI's JSON events, its last
 * message a JSON object of facts. It never prints a credential, only whether it saw one.
 */
function standIn(kind: "codex" | "opencode"): string {
  const dir = mkdtempSync(join(tmpdir(), `thermite-fake-${kind}-`));
  const bin = join(dir, kind);
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const kind = ${JSON.stringify(kind)};
const args = process.argv.slice(2);
const prompt = fs.readFileSync(0, "utf8");
const home = process.env.HOME;
const file = kind === "codex"
  ? path.join(process.env.CODEX_HOME || "", "config.toml")
  : path.join(home, ".config", "opencode", "opencode.jsonc");
const config = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
let base;
let mcpUrl;
let mcpServers = [];
if (kind === "codex") {
  base = /\\[model_providers\\.thermite\\][^[]*base_url = "([^"]*)"/.exec(config)?.[1];
  mcpServers = [...config.matchAll(/\\[mcp_servers\\."([^"]+)"\\]\\nurl = "([^"]+)"/g)].map((m) => [m[1], m[2]]);
} else {
  const c = JSON.parse(config);
  base = c.providers?.thermite?.settings?.baseURL;
  mcpServers = Object.entries(c.mcp?.servers ?? {}).map(([n, s]) => [n, s.url]);
}
mcpUrl = mcpServers.find(([n]) => n === "thermite")?.[1];
const env = process.env;
const out = (e) => process.stdout.write(JSON.stringify(e) + "\\n");
(async () => {
  let proxied = "none";
  if (base && env.THERMITE_PROXY_AUTH) {
    const r = await fetch(base + (kind === "codex" ? "/responses" : "/chat/completions"), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + env.THERMITE_PROXY_AUTH },
      body: JSON.stringify({ model: "m", input: "ping" }),
    });
    proxied = String(r.status);
  }
  const mcp = async (auth) => {
    if (!mcpUrl) return "none";
    const r = await fetch(mcpUrl, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(auth ? { authorization: "Bearer " + auth } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "kb_search", arguments: { query: "tiling" } } }),
    });
    return r.status === 200 ? JSON.stringify(await r.json()) : String(r.status);
  };
  const facts = {
    args,
    cwd: process.cwd(),
    home,
    tmp: env.TMPDIR,
    config,
    proxied,
    proxy_auth: env.THERMITE_PROXY_AUTH ? "set" : "unset",
    key_in_env: Object.values(env).some((v) => String(v).includes(${JSON.stringify(KEY)})),
    key_in_config: config.includes(${JSON.stringify(KEY)}),
    mcp_servers: mcpServers.map(([n]) => n),
    mcp_token_in_config: Boolean(env.THERMITE_MCP_AUTH) && config.includes(env.THERMITE_MCP_AUTH),
    mcp_without_token: await mcp(""),
    mcp_with_token: await mcp(env.THERMITE_MCP_AUTH),
    prompt_has_shape: /Answer with exactly one JSON object, of this shape/.test(prompt),
    prompt_has_package: prompt.includes("the package to read"),
    project_config: env.OPENCODE_DISABLE_PROJECT_CONFIG || "read",
  };
  const text = JSON.stringify(facts);
  if (kind === "codex") {
    out({ type: "thread.started", thread_id: "t-1" });
    out({ type: "item.completed", item: { id: "i0", type: "agent_message", text } });
    out({ type: "turn.completed", usage: { input_tokens: 1200, output_tokens: 40 } });
  } else {
    out({ type: "text", sessionID: "s-1", part: { text } });
    out({ type: "step_finish", sessionID: "s-1", part: { tokens: { input: 900, output: 30, reasoning: 5 } } });
  }
})();
`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

const Facts = z.object({
  args: z.array(z.string()),
  cwd: z.string(),
  home: z.string(),
  tmp: z.string(),
  config: z.string(),
  proxied: z.string(),
  proxy_auth: z.string(),
  key_in_env: z.boolean(),
  key_in_config: z.boolean(),
  mcp_servers: z.array(z.string()),
  mcp_token_in_config: z.boolean(),
  mcp_without_token: z.string(),
  mcp_with_token: z.string(),
  prompt_has_shape: z.boolean(),
  prompt_has_package: z.boolean(),
  project_config: z.string(),
});

/** Runs one advisor call with the stand-in on the PATH Thermite reads, and the past research. */
async function call(kind: "codex" | "opencode", runtime: AdvisorRuntime) {
  const variable = kind === "codex" ? "THERMITE_CODEX_BIN" : "THERMITE_OPENCODE_BIN";
  const before = process.env[variable];
  process.env[variable] = standIn(kind);
  try {
    return await runAdvisor({
      runtime,
      prompt: testPrompt("You audit.", "Audit package: the package to read."),
      schema: Facts,
      answerSchema: Type.Object({ decision: Type.String() }),
      tools: {
        kb: {
          writes: [],
          call: async (_tool, a) => ({ text: `found for ${String(a.query)}` }),
        },
      },
    });
  } finally {
    if (before === undefined) delete process.env[variable];
    else process.env[variable] = before;
  }
}

describe("advisors in OpenCode and the Codex CLI", () => {
  test("Codex: its own folder, the read-only sandbox, no tools of its own, the model through the call's proxy, the knowledge base over MCP", async (t) => {
    const p = await provider(t);
    const r = await call("codex", {
      name: "auditor",
      runtime: "codex",
      api: "openai",
      base_url: p.url,
      model: "gpt-test",
      api_key: KEY,
      reasoning: "high",
      context_window: 128_000,
      timeout_s: 60,
    });
    assert.equal(r.error, undefined, r.error);
    const f = r.output as z.infer<typeof Facts>;
    assert.deepEqual(f.args, [
      "exec",
      "--json",
      "--skip-git-repo-check",
      "--ignore-rules",
      "--ephemeral",
      "--model",
      "gpt-test",
      "-",
    ]);
    // Its own folder: home, working folder and temporary folder, removed after the call.
    assert.match(f.home, /thermite-advisor-/);
    assert.equal(f.tmp, f.home);
    assert.ok(f.cwd.endsWith(f.home.split("/").at(-1) ?? "-"), f.cwd);
    assert.equal(existsSync(f.home), false, "the call's folder is removed");
    // Its settings: the read-only sandbox, no approvals asked, every tool feature off.
    assert.match(f.config, /^sandbox_mode = "read-only"\napproval_policy = "never"\n/);
    for (const feature of ["shell_tool", "unified_exec", "view_image", "multi_agent"])
      assert.match(f.config, new RegExp(`\\n${feature} = false\\n`), feature);
    assert.equal(CODEX_ADVISOR_OFF.length, new Set(CODEX_ADVISOR_OFF).size);
    assert.match(f.config, /\[tools\.experimental_request_user_input\]\nenabled = false/);
    assert.match(f.config, /\[skills\]\ninclude_instructions = false/);
    assert.match(f.config, /model_reasoning_effort = "high"/);
    assert.match(f.config, /web_search = "disabled"/);
    assert.match(f.config, /^project_doc_max_bytes = 0$/m);
    // The model through the call's proxy: the CLI holds a credential made for the call; the
    // provider sees its own key, and only that.
    assert.equal(f.proxy_auth, "set");
    assert.equal(f.proxied, "200");
    assert.equal(f.key_in_env, false);
    assert.equal(f.key_in_config, false);
    assert.deepEqual(
      p.seen.map((s) => [s.path, s.headers.authorization]),
      [["POST /v1/responses", `Bearer ${KEY}`]],
    );
    // The knowledge base over MCP, its token in the environment only.
    assert.deepEqual(f.mcp_servers, ["thermite"]);
    assert.match(f.config, /bearer_token_env_var = "THERMITE_MCP_AUTH"/);
    assert.match(f.config, /default_tools_approval_mode = "approve"/);
    assert.match(f.config, /omit_tools_from = \["deferred", "code_mode"\]/);
    assert.equal(f.mcp_token_in_config, false);
    assert.equal(f.mcp_without_token, "401");
    assert.match(f.mcp_with_token, /found for tiling/);
    // The prompt on stdin, with the answer's shape; the tokens from its events.
    assert.equal(f.prompt_has_shape, true);
    assert.equal(f.prompt_has_package, true);
    assert.deepEqual([r.tokensIn, r.tokensOut], [1200, 40]);
    // Its model usage, from its turn: no count of calls, no cache or reasoning figure named.
    assert.equal(r.usage?.harness, "codex");
    assert.deepEqual(
      r.usage?.calls.map((u) => [u.calls, u.tokens_in, u.cached_in, u.tokens_out, u.reasoning]),
      [[null, 1200, null, 40, null]],
    );
  });

  test("OpenCode: every action denied but the advisor's MCP tools, the model through the call's proxy", async (t) => {
    const p = await provider(t);
    const r = await call("opencode", {
      name: "teacher-1",
      runtime: "opencode",
      api: "openai",
      base_url: p.url,
      model: "open-test",
      api_key: KEY,
      context_window: 0,
      timeout_s: 60,
    });
    assert.equal(r.error, undefined, r.error);
    const f = r.output as z.infer<typeof Facts>;
    assert.deepEqual(f.args, [
      "run",
      "--standalone",
      "--format",
      "json",
      "--model",
      "thermite/open-test",
      "--agent",
      "thermite-advisor",
    ]);
    assert.match(f.home, /thermite-advisor-/);
    assert.equal(f.tmp, f.home);
    const config = JSON.parse(f.config) as {
      permissions: unknown[];
      default_agent: string;
      agents: Record<string, { permissions: unknown[]; mode: string }>;
      mcp: { servers: Record<string, Record<string, unknown>> };
      providers: { thermite: { env: string[] } };
    };
    // Everything denied, then the MCP servers' tools allowed; again as the agent's own rules,
    // which come after every other rule.
    const rules = [
      { action: "*", resource: "*", effect: "deny" },
      { action: "thermite_*", resource: "*", effect: "allow" },
    ];
    assert.deepEqual(config.permissions, rules);
    assert.equal(config.default_agent, "thermite-advisor");
    assert.deepEqual(config.agents["thermite-advisor"]?.permissions, rules);
    assert.equal(config.agents["thermite-advisor"]?.mode, "primary");
    // Each MCP server's tools on the model's own list (Code Mode is denied), its token from the
    // environment.
    assert.deepEqual(config.mcp.servers.thermite?.codemode, false);
    assert.deepEqual(config.mcp.servers.thermite?.headers, {
      Authorization: "Bearer {env:THERMITE_MCP_AUTH}",
    });
    assert.deepEqual(config.providers.thermite.env, ["THERMITE_PROXY_AUTH"]);
    assert.equal(f.proxied, "200");
    assert.equal(f.key_in_env, false);
    assert.equal(f.key_in_config, false);
    assert.equal(f.mcp_token_in_config, false);
    assert.deepEqual(
      p.seen.map((s) => [s.path, s.headers.authorization]),
      [["POST /v1/chat/completions", `Bearer ${KEY}`]],
    );
    assert.equal(f.mcp_without_token, "401");
    assert.match(f.mcp_with_token, /found for tiling/);
    assert.equal(f.prompt_has_shape, true);
    // No project configuration or AGENTS.md of the project's (goal 166, decision 7).
    assert.equal(f.project_config, "1");
    assert.deepEqual([r.tokensIn, r.tokensOut], [900, 35]);
    // Its model usage, from its step: the output with its reasoning; no cache figure named.
    assert.equal(r.usage?.harness, "opencode");
    assert.deepEqual(
      r.usage?.calls.map((u) => [u.calls, u.tokens_in, u.cached_in, u.tokens_out, u.reasoning]),
      [[1, 900, null, 35, 5]],
    );
  });

  test("OpenCode's own models: no proxy and no key, OpenCode's own provider", async () => {
    const r = await call("opencode", {
      name: "auditor",
      runtime: "opencode",
      api: "opencode",
      model: "big-pickle",
      context_window: 0,
      timeout_s: 60,
    });
    assert.equal(r.error, undefined, r.error);
    const f = r.output as z.infer<typeof Facts>;
    assert.equal(f.args[f.args.indexOf("--model") + 1], "opencode/big-pickle");
    assert.equal(f.proxy_auth, "unset");
    assert.equal(f.proxied, "none");
    assert.equal((JSON.parse(f.config) as { providers?: unknown }).providers, undefined);
  });

  test("each CLI compacts within the advisor's window, at its point, in its own settings (goal 070)", async (t) => {
    const p = await provider(t);
    const codex = await call("codex", {
      name: "auditor",
      runtime: "codex",
      api: "openai",
      base_url: p.url,
      model: "gpt-test",
      api_key: KEY,
      context_window: 128_000,
      compact_at: 70,
      timeout_s: 60,
    });
    assert.equal(codex.error, undefined, codex.error);
    const cf = (codex.output as z.infer<typeof Facts>).config;
    assert.match(cf, /\nmodel_context_window = 128000\nmodel_auto_compact_token_limit = 89600\n/);
    const opencode = await call("opencode", {
      name: "teacher-1",
      runtime: "opencode",
      api: "openai",
      base_url: p.url,
      model: "open-test",
      api_key: KEY,
      context_window: 131_072,
      compact_at: 75,
      timeout_s: 60,
    });
    assert.equal(opencode.error, undefined, opencode.error);
    const oc = JSON.parse((opencode.output as z.infer<typeof Facts>).config) as {
      compaction: { auto: boolean; buffer?: number };
      providers: { thermite: { models: Record<string, { limit?: { context: number } }> } };
    };
    // The point at 75% of 131,072: OpenCode keeps 32,768 tokens free below the window.
    assert.deepEqual(oc.compaction, { auto: true, buffer: 32_768 });
    assert.deepEqual(oc.providers.thermite.models["open-test"]?.limit, { context: 131_072 });
  });

  test("an answer that is no valid object, a missing key and a missing program are errors in words", async (t) => {
    const p = await provider(t);
    const noKey = await runAdvisor({
      runtime: {
        name: "auditor",
        runtime: "codex",
        base_url: p.url,
        model: "m",
        context_window: 0,
        timeout_s: 60,
      },
      prompt: testPrompt("s", "p"),
      schema: z.object({ decision: z.string() }),
      answerSchema: Type.Object({}),
    });
    assert.equal(noKey.error, "advisor auditor has no key");
    // The stand-in's facts are not a decision: the answer is refused, with what it said.
    const before = process.env.THERMITE_CODEX_BIN;
    process.env.THERMITE_CODEX_BIN = standIn("codex");
    try {
      const wrong = await runAdvisor({
        runtime: {
          name: "auditor",
          runtime: "codex",
          base_url: p.url,
          model: "m",
          api_key: KEY,
          context_window: 0,
          timeout_s: 60,
        },
        prompt: testPrompt("s", "p"),
        schema: z.strictObject({ decision: z.enum(["clear", "block"]) }),
        answerSchema: Type.Object({}),
      });
      assert.match(String(wrong.error), /^no valid answer: /);
      assert.equal(wrong.output, undefined);
      process.env.THERMITE_CODEX_BIN = join(tmpdir(), "no-such-codex-binary");
      const missing = await runAdvisor({
        runtime: {
          name: "auditor",
          runtime: "codex",
          base_url: p.url,
          model: "m",
          api_key: KEY,
          context_window: 0,
          timeout_s: 60,
        },
        prompt: testPrompt("s", "p"),
        schema: z.object({ decision: z.string() }),
        answerSchema: Type.Object({}),
      });
      assert.match(String(missing.error), /ENOENT/);
    } finally {
      if (before === undefined) delete process.env.THERMITE_CODEX_BIN;
      else process.env.THERMITE_CODEX_BIN = before;
    }
  });
});

describe("the advisor's model proxy", () => {
  test("it takes only the call's credential, adds the route's key, and keeps a ChatGPT sign-in to what OpenAI accepts", async (t) => {
    const p = await provider(t);
    const proxy = await serveAdvisorModel({ api: "anthropic", baseUrl: p.url, key: KEY });
    t.after(() => proxy.close());
    const post = (path: string, headers: Record<string, string>) =>
      fetch(`${proxy.root}/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: "{}",
      });
    assert.equal((await post("messages", { authorization: "Bearer wrong" })).status, 401);
    assert.equal((await post("messages", {})).status, 401);
    // Anthropic's clients send their key as x-api-key: the route's key goes on as x-api-key.
    assert.equal((await post("messages", { "x-api-key": proxy.token })).status, 200);
    assert.equal(p.seen.at(-1)?.headers["x-api-key"], KEY);
    assert.equal(p.seen.at(-1)?.headers.authorization, undefined);
    assert.equal(p.seen.length, 1, "refused calls never reach the provider");

    const chatgpt = await serveAdvisorModel({ api: "chatgpt", baseUrl: p.url, key: "access" });
    t.after(() => chatgpt.close());
    const refused = await fetch(`${chatgpt.root}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${chatgpt.token}` },
      body: "{}",
    });
    assert.equal(refused.status, 403);
    const ok = await fetch(`${chatgpt.root}/responses`, {
      method: "POST",
      headers: { authorization: `Bearer ${chatgpt.token}`, "content-type": "application/json" },
      body: JSON.stringify({ model: "m", input: "hi", temperature: 1 }),
    });
    assert.equal(ok.status, 200);
    assert.equal(p.seen.at(-1)?.headers.authorization, "Bearer access");
  });
});
