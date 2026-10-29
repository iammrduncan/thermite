import { existsSync } from "node:fs";
import { join } from "node:path";
import { codexCompactPrompt, compactionTokens, type KeptAt } from "../../compaction/index.ts";
import { gatewayUrl, type McpAccess, servedNames } from "../../mcp/index.ts";
import type { ModelConfig } from "../../model/index.ts";
import { hookArgv, hookShellLine } from "../hooks/index.ts";
import { agentPath } from "../path.ts";
import { tomlString } from "./toml.ts";

export type { CodexTally } from "./events.ts";
export { newCodexTally, readCodexEvents } from "./events.ts";
export { codexRollout, type RolloutState } from "./rollout.ts";
export {
  CODEX_TERMINAL,
  codexTerminalArgs,
  codexTerminalConfig,
  codexTerminalLog,
} from "./terminal.ts";
export { tomlString } from "./toml.ts";

/**
 * The Codex CLI as Thermite starts it, for the harness's agents and the supervisor's advisors: its
 * binary, its configuration, its command line and its environment. Its entry for the harness's CLI
 * trial loop is in src/harness/agents/cli/codex.ts.
 */

/** The Codex CLI's binary: THERMITE_CODEX_BIN, else `codex` on the PATH (read when used). */
export const codexBin = () => process.env.THERMITE_CODEX_BIN ?? "codex";

/** What to say when the image has no Codex CLI: an image built with an empty CODEX_VERSION. */
export const NO_CODEX =
  "this rig's harness image has no Codex CLI: build the image with the Codex option (CODEX_VERSION, which the published images set), or give the rig another harness on Edit rig";

/** Why the Codex CLI exited, in words. A missing program says so, rather than the shell's note. */
export function codexExitWords(code: number | string | null, note: string): string {
  if ((code === 126 || code === 127) && /codex: (No such file or directory|not found)/.test(note))
    return NO_CODEX;
  return `Codex exited ${code}: ${note}`;
}

/** The Codex CLI's executable as an absolute path (found on PATH), or undefined if it is not there. */
export function codexExe(): string | undefined {
  const bin = codexBin();
  if (bin.startsWith("/")) return bin;
  for (const dir of (process.env.PATH ?? "").split(":")) {
    const p = join(dir, bin);
    if (dir && existsSync(p)) return p;
  }
  return undefined;
}

/**
 * The Codex CLI's configuration for a run ($CODEX_HOME/config.toml): one provider, the harness's
 * key-adding proxy (`proxyRoot`) over the Responses API, with the run's credential from
 * THERMITE_PROXY_AUTH; the route's reasoning effort ("off" sends "none"); no hosted web search,
 * analytics, feedback, update checks or history file. The MCP servers the run's kit gives this
 * agent (goal 068) are each a streamable HTTP server at the harness's gateway, with the gateway's
 * credential from THERMITE_MCP_AUTH (never in the file), and none is required to start.
 *
 * `keptAt` (goal 070): where Thermite keeps the conversation before each compaction. Codex 0.162
 * takes a compaction prompt of its own (`compact_prompt`, which replaces its built-in one): Thermite
 * gives it its own summary prompt, which names that folder, and reads the conversation from
 * Codex's rollout of the thread once Codex reports the compaction.
 *
 * `notify` (a trial's, goal 169): the command Codex runs at the end of each turn, with the turn's
 * JSON as its last argument (Thermite's hook program, which writes it to the trial's signals).
 */
export function codexConfig(
  m: ModelConfig,
  proxyRoot: string,
  mcp?: Pick<McpAccess, "apiUrl" | "servers" | "kb"> | undefined,
  keptAt?: KeptAt | undefined,
  notify?: readonly string[] | undefined,
): string {
  const effort = m.reasoning === "off" ? "none" : m.reasoning;
  const servers = servedNames(mcp).flatMap((s) => [
    `[mcp_servers.${s}]`,
    `url = ${tomlString(gatewayUrl(mcp?.apiUrl ?? "", s))}`,
    'bearer_token_env_var = "THERMITE_MCP_AUTH"',
    "required = false",
    "",
  ]);
  // The window (the route's, so the owner's cap) and the compaction point (goal 070). Codex
  // compacts on its own, by default at 90% of the window; it keeps a window to the most the
  // model takes (272,000 tokens for a model it does not know).
  const point = compactionTokens(m);
  return [
    "# Written by Thermite's harness for one run.",
    'model_provider = "thermite"',
    ...(effort ? [`model_reasoning_effort = ${tomlString(effort)}`] : []),
    ...(point !== undefined
      ? [`model_context_window = ${m.contextWindow}`, `model_auto_compact_token_limit = ${point}`]
      : []),
    ...(keptAt ? [`compact_prompt = ${tomlString(codexCompactPrompt(keptAt))}`] : []),
    ...(notify ? [`notify = [${notify.map(tomlString).join(", ")}]`] : []),
    'web_search = "disabled"',
    "check_for_update_on_startup = false",
    // No AGENTS.md of the project's (goal 166): the prompt is what the role's definition rendered.
    "project_doc_max_bytes = 0",
    "",
    "[model_providers.thermite]",
    'name = "Thermite route"',
    `base_url = ${tomlString(proxyRoot)}`,
    'env_key = "THERMITE_PROXY_AUTH"',
    'wire_api = "responses"',
    "",
    "[history]",
    'persistence = "none"',
    "",
    "[analytics]",
    "enabled = false",
    "",
    "[feedback]",
    "enabled = false",
    "",
    ...servers,
  ].join("\n");
}

/**
 * The flags every headless Codex run here has: JSON events, no git check (a check or a plan runs
 * in an empty directory), no execution-policy rules from the project, approvals and its sandbox
 * off; the prompt on stdin ("-"). A session is resumed by its thread's id.
 *
 * `hooks` (a trial's, goal 169): Thermite's hooks run. `codex exec` runs a hook only once its
 * hash is trusted in the configuration (`[hooks.state]`, which Codex writes when someone trusts
 * the hook in its terminal) or with `--dangerously-bypass-hook-trust`, for this run only.
 * Thermite writes the hooks itself, in a home of the trial's own, so it passes the flag.
 */
export function codexArgs(
  m: ModelConfig,
  o: { session?: string | undefined; hooks?: boolean | undefined } = {},
): string[] {
  return [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--ignore-rules",
    "--dangerously-bypass-approvals-and-sandbox",
    ...(o.hooks ? ["--dangerously-bypass-hook-trust"] : []),
    "--model",
    m.model,
    ...(o.session ? ["resume", o.session] : []),
    "-",
  ];
}

/**
 * The hooks whose signals Thermite follows in a trial (goal 169), as Codex 0.162 names them, each
 * running Thermite's hook program (../hooks/main.ts). Its PostToolUse and Stop hooks also give the
 * agent the owner's messages inside its turn.
 */
export const CODEX_SIGNAL_HOOKS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Stop",
  "Interrupt",
  "SessionEnd",
] as const;

/**
 * A trial's `$CODEX_HOME/hooks.json` (goal 169): Codex takes the same form as Claude Code's
 * hooks, and runs each command through a shell.
 */
export function codexHooks(): string {
  const hook = [{ hooks: [{ type: "command", command: hookShellLine("codex"), timeout: 30 }] }];
  return JSON.stringify({ hooks: Object.fromEntries(CODEX_SIGNAL_HOOKS.map((e) => [e, hook])) });
}

/** Codex's notify in a trial: the hook program, given the turn's JSON as its last argument. */
export const codexNotify = (): string[] => hookArgv("codex-notify");

/** The environment Codex runs in: its home, Thermite's command and the run's proxy credential. */
export function codexEnv(o: {
  home: string;
  apiUrl: string;
  /** The trial's credential for `thermite-trial` (empty outside a trial). */
  auth: string;
  /** What the model proxy takes: the trial's credential, or one minted for a check or a plan. */
  proxyAuth: string;
  /** What the MCP gateway takes, when the agent has MCP servers: the trial's, or the plan's. */
  mcpAuth?: string | undefined;
  tmp: string;
  extra?: Record<string, string> | undefined;
}): Record<string, string> {
  return {
    ...o.extra,
    ...(o.mcpAuth ? { THERMITE_MCP_AUTH: o.mcpAuth } : {}),
    HOME: o.home,
    CODEX_HOME: join(o.home, ".codex"),
    PATH: agentPath(),
    TMPDIR: o.tmp,
    THERMITE_HARNESS_URL: o.apiUrl,
    THERMITE_TRIAL_AUTH: o.auth,
    THERMITE_PROXY_AUTH: o.proxyAuth,
  };
}
