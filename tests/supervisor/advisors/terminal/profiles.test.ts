// Each program's advisor profile in its own terminal (src/supervisor/advisors/terminal/profiles.ts):
// what its setup writes, its environment, and what the terminal host starts. Its tools must be
// today's headless advisor's: none of the program's own, only the advisor's MCP tools, the model
// through the call's proxy, and the call's turn routes for the owner's messages.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import type { CliRun, TerminalAt } from "../../../../src/agents/cli/index.ts";
import type { ModelConfig } from "../../../../src/agents/model/index.ts";
import {
  type AdvisorServed,
  advisorProgram,
} from "../../../../src/supervisor/advisors/terminal/index.ts";

const area = "/var/lib/thermite-advisors/thermite-advisor-abc";
const served: AdvisorServed = {
  tools: {
    url: "http://127.0.0.1:4100/mcp",
    servers: [
      { name: "thermite", url: "http://127.0.0.1:4100/mcp" },
      { name: "docs", url: "http://127.0.0.1:4100/mcp/docs" },
    ],
    token: "made-up-mcp-token",
    args: [],
    mcpConfig: JSON.stringify({ mcpServers: { thermite: { type: "http" } } }),
    close: async () => undefined,
  },
  proxy: {
    root: "http://127.0.0.1:4200/v1/model-proxy",
    token: "proxy.made-up",
    close: async () => undefined,
  },
};

const runOf = (prefix: string, model: ModelConfig): CliRun => ({
  id: "advisor-auditor-r-1-1",
  role: "advisor-auditor-r-1-1",
  title: "Advisor auditor",
  model,
  apiUrl: "http://127.0.0.1:4300",
  area,
  home: join(area, `${prefix}-home`),
  tmp: join(area, `${prefix}-tmp`),
  auth: "call.made-up",
  mcp: undefined,
  keptAt: undefined,
  wallMs: undefined,
  env: undefined,
  tools: "",
});
const at: TerminalAt = { cwd: area, session: "s-1", resume: false, port: 4400 };

/** The settings Claude Code's command line gives, as JSON. */
const settingsOf = (args: string[]) =>
  JSON.parse(args[args.indexOf("--settings") + 1] as string) as { hooks: Record<string, unknown> };

test("Claude Code: no tools of its own, the advisor's MCP servers from a file, the in-turn hooks", () => {
  const p = advisorProgram("claude-code", served);
  const model: ModelConfig = {
    api: "claude",
    harness: "claude-code",
    baseUrl: "",
    model: "claude-test",
    apiKey: "made-up-sign-in",
    contextWindow: 0,
    maxTokens: 0,
    effort: "high",
  };
  const run = runOf("claude", model);
  const setup = p.setup(run);
  // The MCP configuration goes into a file only the call's user reads, never the command line.
  assert.match(setup.script, /umask 077 && cat > claude-home\/mcp\.json$/);
  assert.equal(setup.stdin, served.tools?.mcpConfig);
  const env = p.env(run);
  assert.equal(env.THERMITE_HARNESS_URL, "http://127.0.0.1:4300");
  assert.equal(env.THERMITE_TRIAL_AUTH, "call.made-up");
  assert.equal(env.HOME, run.home);
  const plan = p.terminal.start(run, at);
  const args = plan.args;
  assert.equal(args[args.indexOf("--tools") + 1], "");
  assert.ok(args.includes("--strict-mcp-config"));
  assert.deepEqual(args.slice(-2), ["--mcp-config", join(area, "claude-home", "mcp.json")]);
  assert.ok(!args.join(" ").includes("made-up-mcp-token"), "no token on its command line");
  assert.equal(args[args.indexOf("--effort") + 1], "high");
  // Its hooks give it the owner's messages inside its turn; it keeps no conversation here.
  const hooks = settingsOf(args).hooks;
  assert.ok(hooks.PostToolUse && hooks.Stop);
  assert.equal(hooks.PreCompact, undefined);
  assert.equal(plan.token, "made-up-sign-in");
});

test("Claude Code without MCP tools: no MCP configuration at all", () => {
  const p = advisorProgram("claude-code", {});
  const model = { baseUrl: "", model: "m", apiKey: "t", contextWindow: 0, maxTokens: 0 };
  const run = runOf("claude", model);
  assert.equal(p.setup(run).stdin, undefined);
  assert.ok(!p.terminal.start(run, at).args.includes("--mcp-config"));
});

test("Codex: its read-only sandbox, no tool but MCP's, its hooks on, the model through the call's proxy", () => {
  const p = advisorProgram("codex", served);
  const model: ModelConfig = {
    api: "openai",
    harness: "codex",
    baseUrl: "https://api.example.com/v1",
    model: "gpt-test",
    apiKey: "",
    contextWindow: 0,
    maxTokens: 0,
  };
  const run = runOf("codex", model);
  const setup = p.setup(run);
  assert.match(setup.script, /hooks\.json/);
  assert.equal(setup.stdin, undefined);
  const env = p.env(run);
  assert.equal(env.THERMITE_PROXY_AUTH, "proxy.made-up");
  assert.equal(env.THERMITE_MCP_AUTH, "made-up-mcp-token");
  assert.equal(env.THERMITE_TRIAL_AUTH, "call.made-up");
  assert.equal(env.CODEX_HOME, join(area, "codex-home", ".codex"));
  const plan = p.terminal.start(run, at);
  assert.ok(!plan.args.includes("--dangerously-bypass-approvals-and-sandbox"));
  assert.ok(plan.args.includes("--dangerously-bypass-hook-trust"));
  const config = plan.seeds[0]?.content ?? "";
  assert.equal(plan.seeds[0]?.path, join(area, "codex-home", ".codex", "config.toml"));
  assert.match(config, /^sandbox_mode = "read-only"$/m);
  assert.match(config, /^approval_policy = "never"$/m);
  assert.match(config, /^shell_tool = false$/m);
  assert.doesNotMatch(config, /^hooks = false$/m);
  assert.match(config, /^notify = \[/m);
  assert.match(config, /base_url = "http:\/\/127\.0\.0\.1:4200\/v1\/model-proxy"/);
  assert.match(config, /\[mcp_servers\."?docs"?\]/);
  assert.match(config, /trust_level = "trusted"/);
  assert.ok(!config.includes("made-up-mcp-token") && !config.includes("proxy.made-up"));
  const resumed = p.terminal.start(run, { ...at, resume: true, session: "thread-1" });
  assert.deepEqual([resumed.args[0], resumed.args.at(-1)], ["resume", "thread-1"]);
});

test("OpenCode: every action denied but the advisor's MCP tools, as its own agent, with Thermite's plugin", () => {
  const p = advisorProgram("opencode", served);
  const model: ModelConfig = {
    api: "openai",
    harness: "opencode",
    baseUrl: "https://api.example.com/v1",
    model: "m-test",
    apiKey: "",
    contextWindow: 100_000,
    maxTokens: 0,
  };
  const run = runOf("opencode", model);
  const setup = p.setup(run);
  assert.match(setup.script, /ln -sf "\$1" opencode-home\//);
  assert.equal(setup.stdin, undefined);
  const env = p.env(run);
  assert.equal(env.THERMITE_PROXY_AUTH, "proxy.made-up");
  assert.equal(env.THERMITE_MCP_AUTH, "made-up-mcp-token");
  assert.equal(env.THERMITE_HARNESS_URL, "http://127.0.0.1:4300");
  const plan = p.terminal.start(run, at);
  assert.equal(plan.server?.port, 4400);
  const config = JSON.parse(plan.seeds[0]?.content ?? "{}") as {
    default_agent: string;
    permissions: { action: string; effect: string }[];
    model: string;
  };
  assert.equal(config.default_agent, "thermite-advisor");
  assert.deepEqual(config.permissions[0], { action: "*", resource: "*", effect: "deny" });
  assert.ok(config.permissions.some((r) => r.action === "docs_*" && r.effect === "allow"));
  assert.ok(config.model.endsWith("m-test"));
});
