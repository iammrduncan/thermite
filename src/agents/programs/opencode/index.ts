import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  compactionTokens,
  type FoundCompaction,
  type KeptAt,
  keptLine,
  opencodeEnded,
} from "../../compaction/index.ts";
import { type McpAccess, opencodeMcp } from "../../mcp/index.ts";
import type { ModelConfig } from "../../model/index.ts";
import { agentPath } from "../path.ts";

export { newTally, type OpencodeTally, readNew, readOpencodeEvents } from "./events.ts";
export { NO_OPENCODE, opencodeBin, opencodeExe, opencodeExitWords } from "./run.ts";
export { type OpencodeLogState, opencodeSession } from "./session-events.ts";
export {
  OPENCODE_TERMINAL,
  opencodeServerArgs,
  opencodeServerUrl,
  opencodeTerminalArgs,
} from "./terminal.ts";

/**
 * OpenCode as Thermite starts it, for the harness's agents and the supervisor's advisors: its
 * configuration, its compaction plugin and its environment. Its entry, as every role runs it, is
 * src/agents/cli/opencode.ts.
 */

/** This module's own extension: `.js` when built, `.ts` when run from the source. */
const OWN_EXT = extname(fileURLToPath(import.meta.url));
/** Thermite's OpenCode plugin (plugin.ts, in this folder), which OpenCode loads. */
export const OPENCODE_PLUGIN = fileURLToPath(new URL(`./plugin${OWN_EXT}`, import.meta.url));
/** Where OpenCode finds the plugin, under its home: a link in its own settings' plugins folder. */
export const OPENCODE_PLUGIN_LINK = `.config/opencode/plugins/thermite${OWN_EXT}`;
/** The folder in an OpenCode run's own area where the plugin keeps each compaction's session. */
export const OPENCODE_DROPS = "opencode-compactions";

/**
 * What Thermite's plugin reads from OpenCode's environment (goal 070): its folder, and the line
 * that tells the summary where the harness keeps the conversation.
 */
export function opencodeKeepEnv(drops: string, at: KeptAt): Record<string, string> {
  return { THERMITE_COMPACTION_DROPS: drops, THERMITE_COMPACTION_LINE: keptLine(at) };
}

/**
 * The compactions Thermite's plugin saw end, in `drops`, past the first `count`; each comes `at`
 * that many of a read's live entries (goal 070). OpenCode's own output does not report them; the
 * plugin's records do.
 */
export function opencodeFound(
  root: string,
  drops: string[],
  count: number,
  at: number,
): FoundCompaction[] {
  return opencodeEnded(root, drops)
    .filter((n) => n > count)
    .map(() => ({ at, tokensBefore: null, tokensAfter: null }));
}

/** The model as OpenCode names it: its own models, or the rig's provider as "thermite". */
export function opencodeModelId(m: ModelConfig): string {
  return m.api === "opencode" ? `opencode/${m.model}` : `thermite/${m.model}`;
}

/**
 * OpenCode's configuration for a run. Nobody answers a question in a headless run, so OpenCode's
 * question tool is denied. A provider other than OpenCode's own is reached through the harness's
 * key-adding proxy (`proxyRoot`), with the run's proxy credential from THERMITE_PROXY_AUTH.
 *
 * Compaction (goal 070): OpenCode compacts its conversation on its own (`compaction.auto`), but
 * only for a model whose window it knows. For the rig's provider, the model's `limit.context` is
 * the route's window (so the owner's cap), and `compaction.buffer`, the tokens it keeps free
 * below that window, puts its compaction point at the route's share. OpenCode's own models keep
 * the windows and the compaction point OpenCode knows for them.
 */
export function opencodeConfig(
  m: ModelConfig,
  proxyRoot: string,
  mcp?: McpAccess | undefined,
): Record<string, unknown> {
  const config: Record<string, unknown> = {
    $schema: "https://opencode.ai/config.json",
    permissions: [{ action: "question", resource: "*", effect: "deny" }],
  };
  // The MCP servers the run's kit gives this agent (goal 068), each at the harness's gateway.
  const servers = opencodeMcp(mcp);
  if (servers) config.mcp = servers;
  const point = m.api !== "opencode" ? compactionTokens(m) : undefined;
  config.compaction = {
    auto: true,
    ...(point !== undefined ? { buffer: m.contextWindow - point } : {}),
  };
  if (m.api !== "opencode") {
    const anthropic = m.api === "anthropic";
    config.providers = {
      thermite: {
        name: "Thermite route",
        env: ["THERMITE_PROXY_AUTH"],
        // A ChatGPT sign-in: OpenAI's Responses API (OpenCode's own OpenAI provider posts to
        // {base}/responses with store off and the whole history; the proxy drops what the
        // route refuses, such as max_output_tokens).
        package: anthropic
          ? "@opencode/ai/providers/anthropic"
          : m.api === "chatgpt"
            ? "@opencode/ai/providers/openai"
            : "@opencode/ai/providers/openai-compatible",
        // Anthropic's client posts to {base}/messages; its API is at /v1/messages.
        settings: { baseURL: anthropic ? `${proxyRoot}/v1` : proxyRoot },
        models: {
          [m.model]: {
            name: m.model,
            ...(point !== undefined ? { limit: { context: m.contextWindow } } : {}),
          },
        },
      },
    };
  }
  return config;
}

/**
 * What every OpenCode run gets in its environment, a worker's and an advisor's (goal 166,
 * decision 7): no project configuration and no project instruction files. OpenCode 2.1.4 reads
 * the variable when it starts its server (packages/cli/src/server-process.ts) and then reads no
 * `opencode.json`, `.opencode/` or `AGENTS.md` of the project's; its own settings, in its home,
 * stay. Its read tool still adds an `AGENTS.md` it finds in a folder below the workspace's top
 * when the agent reads a file there: no setting turns that off.
 */
export const OPENCODE_BASE_ENV: Readonly<Record<string, string>> = {
  OPENCODE_DISABLE_PROJECT_CONFIG: "1",
};

/** The environment of an OpenCode run: its home, Thermite's command and how to reach the API. */
export function runEnv(home: string, apiUrl: string, auth: string, extra: Record<string, string>) {
  return {
    ...extra,
    ...OPENCODE_BASE_ENV,
    HOME: home,
    PATH: agentPath(),
    THERMITE_HARNESS_URL: apiUrl,
    THERMITE_TRIAL_AUTH: auth,
    THERMITE_PROXY_AUTH: auth,
  };
}

/** `opencode run` as Thermite starts it, headless with its permissions approved, for this model. */
export const opencodeArgs = (m: ModelConfig) => [
  "run",
  "--standalone",
  "--auto",
  "--format",
  "json",
  "--model",
  opencodeModelId(m),
];
