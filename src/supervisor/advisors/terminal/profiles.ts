import { join } from "node:path";
import {
  type CliProgram,
  type CliTally,
  claudeProgram,
  codexProgram,
  opencodeProgram,
} from "../../../agents/cli/index.ts";
import {
  codexEnv,
  codexHooks,
  codexNotify,
  codexTerminalConfig,
  codexTerminalLog,
  OPENCODE_DROPS,
  OPENCODE_PLUGIN,
  OPENCODE_PLUGIN_LINK,
  opencodeKeepEnv,
  opencodeModelId,
  runEnv,
} from "../../../agents/programs/index.ts";
import { codexAdvisorConfig, codexAdvisorTerminalArgs, opencodeAdvisorConfig } from "../cli.ts";
import type { AdvisorModelProxy } from "../proxy.ts";
import type { PastSearchServer } from "../tools/index.ts";

/**
 * Each program's advisor profile in its own terminal (goal 169): the program's own entry
 * (src/agents/cli/), which the one path runs for every role, with what an advisor's call sets up
 * differently from a trial's. Its tools are today's headless advisor's: none of the program's
 * own, only the advisor's MCP tools, which the supervisor serves on localhost for the call
 * (tools/mcp.ts), and the model through the call's key-adding proxy (proxy.ts), never the harness.
 * Thermite's hooks (Claude Code, Codex) and its plugin (OpenCode) write the call's signals and ask
 * the call's turn routes (turns.ts) for the owner's messages inside its turn: the program's
 * environment names them, `THERMITE_HARNESS_URL` and the call's credential in `THERMITE_TRIAL_AUTH`,
 * as a trial's names the harness. No other route of a trial's is reached.
 */

/** What the supervisor serves one advisor's call: its MCP tools and its model proxy, when it has them. */
export interface AdvisorServed {
  tools?: PastSearchServer | undefined;
  /** None for Claude Code (its token goes to it alone) and for OpenCode's own models. */
  proxy?: AdvisorModelProxy | undefined;
}

/** Claude Code's MCP configuration in the call's home, which only the call's user reads. */
const CLAUDE_MCP = ["claude-home", "mcp.json"];
/** Where Codex's home is in the call's folder, as the trial's entry has it: CODEX_HOME. */
const CODEX_HOME = ["codex-home", ".codex"];

/**
 * Claude Code for an advisor: the trial's terminal with no tools of its own (`--tools ""`, the
 * call's), and only the advisor's MCP servers, from a file the setup writes. Its permissions stay
 * bypassed, so no screen waits: with none of its own tools, they cover only the advisor's MCP tools,
 * which today's headless advisor allows by name.
 */
function claudeAdvisor(served: AdvisorServed) {
  const p = claudeProgram;
  const mcp = served.tools?.mcpConfig;
  return {
    ...p,
    setup: (run) => {
      const s = p.setup(run);
      return mcp
        ? { ...s, script: `${s.script} && umask 077 && cat > ${CLAUDE_MCP.join("/")}`, stdin: mcp }
        : s;
    },
    terminal: {
      ...p.terminal,
      start: (run, at) => {
        const plan = p.terminal.start(run, at);
        // `--mcp-config` takes several values: it goes last.
        return mcp
          ? { ...plan, args: [...plan.args, "--mcp-config", join(run.area, ...CLAUDE_MCP)] }
          : plan;
      },
    },
  } satisfies typeof p;
}

/**
 * The Codex CLI for an advisor: its read-only sandbox, every tool feature off but MCP's and
 * Thermite's hooks, the advisor's MCP servers, and the model through the call's proxy.
 */
function codexAdvisor(served: AdvisorServed) {
  const p = codexProgram;
  const servers = served.tools?.servers ?? [];
  return {
    ...p,
    // Its configuration is seeded by the terminal host; the setup writes its hooks.
    setup: () => ({
      script:
        'mkdir -p codex-home/.codex codex-tmp && printf %s "$1" > codex-home/.codex/hooks.json && : > codex-events.jsonl && chmod 0644 codex-events.jsonl && : > codex-signals.jsonl && chmod 0644 codex-signals.jsonl',
      args: ["sh", codexHooks()],
    }),
    env: (run) =>
      codexEnv({
        home: run.home,
        apiUrl: run.apiUrl,
        auth: run.auth,
        proxyAuth: served.proxy?.token ?? "",
        mcpAuth: served.tools?.token,
        tmp: run.tmp,
      }),
    terminal: {
      ...p.terminal,
      start: (run, at) => ({
        args: codexAdvisorTerminalArgs(run.model, {
          cwd: at.cwd,
          resume: at.resume ? at.session : undefined,
        }),
        seeds: [
          {
            path: join(run.area, ...CODEX_HOME, "config.toml"),
            content: codexTerminalConfig(
              codexAdvisorConfig(run.model, served.proxy?.root ?? "", servers, run.keptAt, {
                notify: codexNotify(),
              }),
              at.cwd,
            ),
            mode: 0o600,
          },
        ],
        log: codexTerminalLog(join(run.area, ...CODEX_HOME)),
      }),
    },
  } satisfies typeof p;
}

/**
 * OpenCode for an advisor: its server and its terminal, as a trial's, with every action denied but
 * the advisor's MCP tools, as its own agent, and Thermite's plugin, which writes its events (the
 * call's record) and steers the owner's messages in.
 */
function opencodeAdvisor(served: AdvisorServed) {
  const p = opencodeProgram;
  const servers = served.tools?.servers ?? [];
  return {
    ...p,
    // Its configuration is seeded by the terminal host; the setup links the plugin.
    setup: (run) => ({
      script: `mkdir -p opencode-home/.config/opencode/plugins opencode-tmp && ln -sf "$1" opencode-home/${OPENCODE_PLUGIN_LINK} && : > opencode-signals.jsonl && chmod 0644 opencode-signals.jsonl${run.keptAt ? ` && mkdir -p ${OPENCODE_DROPS} && chmod 0755 ${OPENCODE_DROPS}` : ""} && : > opencode-events.jsonl && chmod 0644 opencode-events.jsonl`,
      args: ["sh", OPENCODE_PLUGIN],
    }),
    env: (run) => ({
      ...runEnv(run.home, run.apiUrl, run.auth, {}),
      TMPDIR: run.tmp,
      ...(served.proxy ? { THERMITE_PROXY_AUTH: served.proxy.token } : {}),
      ...(served.tools ? { THERMITE_MCP_AUTH: served.tools.token } : {}),
      ...(run.keptAt ? opencodeKeepEnv(join(run.area, OPENCODE_DROPS), run.keptAt) : {}),
    }),
    terminal: {
      ...p.terminal,
      start: (run, at) => ({
        ...p.terminal.start(run, at),
        seeds: [
          {
            path: join(run.home, ".config", "opencode", "opencode.jsonc"),
            content: JSON.stringify({
              ...opencodeAdvisorConfig(run.model, served.proxy?.root ?? "", servers),
              model: opencodeModelId(run.model),
            }),
            mode: 0o600,
          },
        ],
      }),
    },
  } satisfies typeof p;
}

/** The programs an advisor runs in its own terminal. */
export type AdvisorProgramId = "claude-code" | "codex" | "opencode";

/** An advisor's program in its own terminal, with what the supervisor serves its call. */
export function advisorProgram(id: AdvisorProgramId, served: AdvisorServed): CliProgram<CliTally> {
  if (id === "claude-code") return claudeAdvisor(served);
  if (id === "codex") return codexAdvisor(served);
  return opencodeAdvisor(served);
}
