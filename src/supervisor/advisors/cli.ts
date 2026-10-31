import type { KeptAt } from "../../agents/compaction/index.ts";
import type { ModelConfig } from "../../agents/model/index.ts";
import {
  codexConfig,
  newCodexTally,
  newTally,
  opencodeConfig,
  opencodeModelId,
  readCodexEvents,
  readOpencodeEvents,
  tomlString,
} from "../../agents/programs/index.ts";
import type { CallUsage } from "../../core/usage.ts";

/**
 * An advisor in OpenCode v2 or the Codex CLI, in the supervisor (goal 073): the CLI's settings
 * for one call, its command line and how its answer is read. The call runs in a folder of its own
 * (its home, its working folder and its temporary folder, removed after the call), as Claude
 * Code's does. Each CLI is set up so its agent has no project to change and no commands of its
 * own: no shell, no file edits or reads, no web, no subagents, only Thermite's tools for advisors
 * (the run's past research and the kit's MCP tools), which the supervisor serves on localhost for
 * the call. The model is reached through a key-adding proxy the supervisor serves for the call
 * (proxy.ts), with a credential made for it in THERMITE_PROXY_AUTH, as the harness does
 * for its workers: the route's key is in no file and no environment of the CLI. The MCP servers'
 * token is in THERMITE_MCP_AUTH, never in a file.
 *
 * Where each setting comes from (the CLIs' own documentation and source, at the versions the
 * images pin):
 * - OpenCode 2.0.32: `permissions` rules, the last match winning, with an agent's own rules
 *   applied after the global ones; `execute` denied removes Code Mode, so each MCP server sets
 *   `codemode: false` and its tools (`<server>_<tool>`) stay on the model's own tool list;
 *   `{env:NAME}` in a server's headers; `opencode run` reads its prompt from stdin.
 * - Codex 0.162: `features.shell_tool` and `features.unified_exec` off remove its shell; the
 *   other tools are each turned off by their feature or setting; `apply_patch`, which a model
 *   may still be offered, is refused every write under the read-only sandbox with approvals
 *   never asked (`patch rejected: writing is blocked by read-only sandbox`).
 */

/** The OpenCode agent an advisor runs as: its own rules, applied after every other rule. */
export const ADVISOR_AGENT = "thermite-advisor";

/** An MCP server the supervisor serves for the call: its name and its address. */
export interface AdvisorServer {
  name: string;
  url: string;
}

/** A tool's name prefix in OpenCode: the server's name, its other characters as `_`. */
const opencodePrefix = (server: string) => server.replace(/[^A-Za-z0-9_-]/g, "_");

/**
 * OpenCode's configuration for one advisor call: every action denied (shell, file reads and
 * edits, globs, searches, web, subagents, skills, questions, Code Mode), then each of the call's
 * MCP servers' tools allowed. The rules are set globally and again as the advisor agent's own, so
 * no shipped agent's rules come after them. A route other than OpenCode's own models goes through
 * the proxy (`proxyRoot`), as a worker's goes through the harness's.
 */
export function opencodeAdvisorConfig(
  m: ModelConfig,
  proxyRoot: string,
  servers: readonly AdvisorServer[],
): Record<string, unknown> {
  const rules = [
    { action: "*", resource: "*", effect: "deny" },
    ...servers.map((s) => ({
      action: `${opencodePrefix(s.name)}_*`,
      resource: "*",
      effect: "allow",
    })),
  ];
  return {
    ...opencodeConfig(m, proxyRoot),
    permissions: rules,
    default_agent: ADVISOR_AGENT,
    agents: {
      [ADVISOR_AGENT]: {
        description:
          "A Thermite advisor: it reads what it is given and answers. It changes nothing.",
        mode: "primary",
        permissions: rules,
      },
    },
    ...(servers.length
      ? {
          mcp: {
            servers: Object.fromEntries(
              servers.map((s) => [
                s.name,
                {
                  type: "remote",
                  url: s.url,
                  headers: { Authorization: "Bearer {env:THERMITE_MCP_AUTH}" },
                  oauth: false,
                  codemode: false,
                },
              ]),
            ),
          },
        }
      : {}),
  };
}

/** `opencode run` for an advisor: JSON events, its own model and agent; the prompt on stdin. */
export function opencodeAdvisorArgs(m: ModelConfig): string[] {
  return [
    "run",
    "--standalone",
    "--format",
    "json",
    "--model",
    opencodeModelId(m),
    "--agent",
    ADVISOR_AGENT,
  ];
}

/** Codex's feature flags an advisor runs with off: every tool but MCP's, and what reaches out. */
export const CODEX_ADVISOR_OFF = [
  "shell_tool",
  "unified_exec",
  "view_image",
  "multi_agent",
  "multi_agent_v2",
  "goals",
  "apps",
  "plugins",
  "remote_plugin",
  "browser_use",
  "computer_use",
  "in_app_browser",
  "image_generation",
  "memories",
  "hooks",
  "tool_suggest",
  "skill_search",
  "skill_mcp_dependency_install",
  "workspace_dependencies",
  "code_mode_host",
  "sleep_tool",
  "standalone_web_search",
] as const;

/**
 * The Codex CLI's configuration for one advisor call ($CODEX_HOME/config.toml): the workers' own
 * (one provider, the proxy, over the Responses API; no web search, history, analytics or update
 * checks), with the read-only sandbox and approvals never asked, every tool feature off, no
 * questions, no skills, and each of the call's MCP servers, its token from THERMITE_MCP_AUTH and
 * its tools approved without asking (no one answers a question in a headless call).
 */
export function codexAdvisorConfig(
  m: ModelConfig,
  proxyRoot: string,
  servers: readonly AdvisorServer[],
  /** Where the supervisor keeps the conversation before each compaction (goal 070). */
  keptAt?: KeptAt | undefined,
): string {
  return [
    // Top-level keys come before the tables the workers' configuration ends with.
    'sandbox_mode = "read-only"',
    'approval_policy = "never"',
    codexConfig(m, proxyRoot, undefined, keptAt),
    "[features]",
    ...CODEX_ADVISOR_OFF.map((f) => `${f} = false`),
    "",
    "[tools.experimental_request_user_input]",
    "enabled = false",
    "",
    "[skills]",
    "include_instructions = false",
    "",
    "[skills.bundled]",
    "enabled = false",
    "",
    ...servers.flatMap((s) => [
      `[mcp_servers.${tomlString(s.name)}]`,
      `url = ${tomlString(s.url)}`,
      'bearer_token_env_var = "THERMITE_MCP_AUTH"',
      "required = false",
      'default_tools_approval_mode = "approve"',
      // Its tools on the model's own list, not behind Codex's tool search or in Code Mode.
      'omit_tools_from = ["deferred", "code_mode"]',
      "",
    ]),
  ].join("\n");
}

/**
 * `codex exec` for an advisor: JSON events, no git check, no rules; stdin. No saved session,
 * unless its conversation is kept (`keep`, goal 070): then Codex keeps its rollout of the thread in
 * the call's own folder, where the supervisor reads each compaction's conversation from it before
 * the folder is removed.
 */
export function codexAdvisorArgs(m: ModelConfig, o: { keep?: boolean } = {}): string[] {
  return [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--ignore-rules",
    ...(o.keep ? [] : ["--ephemeral"]),
    "--model",
    m.model,
    "-",
  ];
}

/**
 * What a CLI's JSON events said: its last message (the answer), its tokens, its last error, and
 * its model usage as its events report it (goal 075).
 */
export interface CliAnswer {
  text: string;
  tokensIn: number;
  tokensOut: number;
  error?: string | undefined;
  calls: CallUsage[];
}

/** OpenCode's answer from its `--format json` events. */
export function readOpencodeAnswer(out: string): CliAnswer {
  const t = newTally();
  readOpencodeEvents(out.split("\n"), t);
  return {
    text: t.lastText,
    tokensIn: t.tokensIn,
    tokensOut: t.tokensOut,
    error: t.errors.at(-1) ?? t.notes.at(-1),
    calls: t.calls,
  };
}

/** Codex's answer from its `exec --json` events. */
export function readCodexAnswer(out: string): CliAnswer {
  const t = newCodexTally();
  readCodexEvents(out.split("\n"), t);
  return {
    text: t.lastText,
    tokensIn: t.tokensIn,
    tokensOut: t.tokensOut,
    error: t.errors.at(-1) ?? t.notes.at(-1),
    calls: t.calls,
  };
}
