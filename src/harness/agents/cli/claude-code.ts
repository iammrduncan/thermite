import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { claudeOwn } from "../../../agents/compaction/index.ts";
import { claudeMcpConfig } from "../../../agents/mcp/index.ts";
import type { ModelConfig } from "../../../agents/model/index.ts";
import {
  agentPath,
  CLAUDE_DROPS,
  CLAUDE_PROMPT,
  CLAUDE_TERMINAL_ENV,
  type ClaudeTally,
  claudeArgs,
  claudeBin,
  claudeCompactionEnv,
  claudeEnv,
  claudeExe,
  claudeExitWords,
  claudeHookSettings,
  claudeShell,
  claudeTerminalArgs,
  claudeTerminalLog,
  claudeTerminalSeeds,
  claudeTerminalSettings,
  claudeTranscript,
  claudeTrialSettings,
  closeClaudeRun,
  hookSignals,
  newClaudeTally,
  PROMPT_VAR,
  readClaudeEvents,
} from "../../../agents/programs/index.ts";
import type { Role, Runner } from "../../broker/index.ts";
import type { RigCheckReport } from "../model/index.ts";
import type { TrialResult, TrialSpec } from "../worker/index.ts";
import { runCliTrial } from "./loop.ts";
import { type CliOnceDeps, type CliOnceOptions, cliModelCheck, cliOnce } from "./once.ts";
import type { CliProgram, CliRun, CliTrialDeps } from "./program.ts";

/**
 * Trials, model checks and planner calls in Claude Code, for a Claude subscription. Anthropic
 * allows a subscription only in its own program, unmodified: the owner's token from `claude
 * setup-token` reaches Claude Code alone, on a file descriptor (claudeShell), and no other program
 * here uses it. Claude Code runs headless (`claude -p`, its permissions bypassed), or in its own
 * terminal where the rig says so (goal 169; cli/terminal.ts), as the lane's own user, in the
 * lane's workspace, under the lane's memory, disk and time limits and the GPU fence, as OpenCode
 * does: it has the lane's access and none of the judge's. It starts with a home of its own, no setting sources and no MCP servers, so nothing of a project's or a host's Claude
 * settings runs. The token is in no environment and no file, so its commands inherit no
 * credentials; they run as the same user, which could still reach the token: the owner accepted
 * that (decision 51). Claude Code's own sandbox stays off (src/agents/programs/claude-code/ says
 * why).
 *
 * Thermite's own tools are the `thermite-trial` command, which calls the harness API with the
 * trial's token. Claude Code reports the subscription's usage windows as it goes
 * (rate_limit_event); a full window ends the trial with the time it resets.
 */

/**
 * Writes a run's prompt into its folder (`cwd`), as the run's role: a trial's area is the lane's.
 * Undefined when it is written; else why not, in words.
 */
async function writeClaudePrompt(
  runner: Runner,
  role: Role,
  cwd: string,
  prompt: string,
): Promise<string | undefined> {
  const r = await runner.run({
    role,
    argv: ["sh", "-c", `umask 077 && cat > ${CLAUDE_PROMPT}`],
    cwd,
    stdin: prompt,
    timeoutMs: 30_000,
    captureBytes: 4096,
  });
  return r.exitCode === 0
    ? undefined
    : `could not write Claude Code's prompt: ${r.stderr.slice(-300)}`;
}

/**
 * Claude Code's version, by its executable, read once for each harness start: its terminal's
 * seeds mark its onboarding done for this version (claudeTerminalSeeds).
 */
const versions = new Map<string, string>();

/**
 * Reads Claude Code's version (`claude --version`, as the lane, in its area) unless it was read
 * already. Undefined when it is known; else why not, in words.
 */
async function readClaudeVersion(run: CliRun, runner: Runner): Promise<string | undefined> {
  const exe = claudeExe() ?? claudeBin();
  if (versions.has(exe)) return undefined;
  const r = await runner.run({
    role: run.role,
    argv: [exe, "--version"],
    cwd: run.area,
    env: { HOME: run.home, PATH: agentPath(), TMPDIR: run.tmp, DISABLE_AUTOUPDATER: "1" },
    timeoutMs: 30_000,
    captureBytes: 4096,
  });
  const version = /^\s*(\d+\.\d+\.\d+\S*)/.exec(r.stdout)?.[1];
  if (r.exitCode !== 0 || !version)
    return `could not read Claude Code's version, which its terminal's settings need: ${(r.stderr || r.stdout).trim().slice(-300) || `exit ${r.exitCode ?? r.signal}`}`;
  versions.set(exe, version);
  return undefined;
}

/**
 * What Claude Code itself uses, as its limits note says: in its own terminal, the default, with the
 * terminal host, as the real Claude Code acceptance measured it (2026-10-29: 553 and 574 MiB at its
 * trial's peak, with the commands it ran; 342 and 346 MiB headless).
 */
export const CLAUDE_CODE_MEMORY = "about 550 MiB";

/** Claude Code's settings in a trial: its hooks, and its compaction hooks when the conversation is kept. */
const trialSettings = (run: CliRun) =>
  claudeTrialSettings(
    run.keptAt ? { drops: join(run.area, CLAUDE_DROPS), at: run.keptAt } : undefined,
  );

/**
 * Claude Code in the CLI trial loop and the one-prompt call: headless, its token on file
 * descriptor 3 and its prompt from a file the lane (or, for a call, the controller) writes before
 * each run, a run cut short that keeps its usage, and the subscription's usage windows, a full one
 * of which ends the trial; in its own terminal (goal 169), a session of the harness's id, its
 * token given by the terminal host, and its transcript, which the host copies for the harness.
 */
export const claudeProgram: CliProgram<ClaudeTally> = {
  id: "claude-code",
  name: "Claude Code",
  prefix: "claude",
  eventsVar: "THERMITE_CLAUDE_EVENTS",
  turnWords: "each model reply is one",
  memory: CLAUDE_CODE_MEMORY,
  bin: claudeBin,
  exe: claudeExe,
  // The MCP servers the run's kit gives its workers (goal 068), at the harness's gateway with the
  // trial's own token: in a file only the lane reads.
  setup: (run) => {
    const mcp = claudeMcpConfig(run.mcp);
    return {
      script: `mkdir -p claude-home claude-tmp ${CLAUDE_DROPS} && chmod 0755 ${CLAUDE_DROPS} && : > claude-events.jsonl && chmod 0644 claude-events.jsonl && : > claude-signals.jsonl && chmod 0644 claude-signals.jsonl${mcp ? " && umask 077 && cat > claude-home/mcp.json" : ""}`,
      stdin: mcp,
    };
  },
  env: (run) => ({
    ...claudeEnv({
      home: run.home,
      apiUrl: run.apiUrl,
      auth: run.auth,
      tmp: run.tmp,
      maxCommandMs: run.wallMs,
      extra: run.env,
    }),
    ...claudeCompactionEnv(run.model),
    [PROMPT_VAR]: join(run.area, CLAUDE_PROMPT),
  }),
  // Its hooks signal each turn and tool and give the agent the owner's messages inside its turn
  // (goal 169); before each compaction, its hook copies its transcript into the run's own area
  // and tells the summary where the harness keeps it (goal 070).
  args: (run, session) => [
    "-p",
    ...claudeArgs(run.model, {
      session,
      mcpConfig: run.mcp ? join(run.home, "mcp.json") : undefined,
      settings: trialSettings(run),
    }),
  ],
  // The token comes on stdin, which the shell moves to file descriptor 3 for Claude Code.
  shell: claudeShell,
  stdin: (_prompt, run) => run.model.apiKey,
  newTally: newClaudeTally,
  read: readClaudeEvents,
  found: (t) => t.compactions.splice(0),
  // The harness reads the hook's copy, or else the transcript itself, once Claude Code reports
  // the compaction (goal 070).
  own: (run, t) =>
    claudeOwn({
      root: run.area,
      drops: [CLAUDE_DROPS],
      home: ["claude-home"],
      title: run.title,
      session: () => t.session,
    }),
  exitWords: claudeExitWords,
  signals: {
    adapter: () => hookSignals("claude-code"),
    how: { "after-tool": "Claude Code's PostToolUse hook", "turn-end": "Claude Code's Stop hook" },
  },
  // The prompt, written by the lane into its own area, for Claude Code's stdin.
  beforeRun: (prompt, run, runner) => writeClaudePrompt(runner, run.role, run.area, prompt),
  // A run cut off before its result (a submission, the cap) keeps what its stream showed.
  closeRun: closeClaudeRun,
  windows: (t) => t.usage,
  // In its own terminal: the session's id the harness gives it, its settings with the warning about
  // bypassed permissions taken as read, its onboarding and the workspace's trust seeded, and its
  // transcript copied by the host (goal 169).
  terminal: {
    prepare: readClaudeVersion,
    newSession: () => randomUUID(),
    start: (run, at) => ({
      args: claudeTerminalArgs(run.model, {
        session: at.session,
        resume: at.resume,
        mcpConfig: run.mcp ? join(run.home, "mcp.json") : undefined,
        settings: claudeTerminalSettings(trialSettings(run)),
      }),
      env: { ...CLAUDE_TERMINAL_ENV },
      seeds: claudeTerminalSeeds(run.home, at.cwd, versions.get(claudeExe() ?? claudeBin()) ?? ""),
      token: run.model.apiKey,
      log: claudeTerminalLog(run.home, at.session),
    }),
    log: { adapter: () => claudeTranscript, from: "copy" },
    // Its compactions (goal 070), and a full usage window, which ends the trial as headless.
    take: (e, t, at) => {
      if (e.type === "compaction")
        t.compactions.push({ at, tokensBefore: e.tokensBefore ?? null, tokensAfter: null });
      else if (e.type === "limit" && e.resetsAt) t.limitedUntil = e.resetsAt;
    },
  },
  // A full usage window: the trial ends, and the lane waits for the reset (never paid credits).
  stopAfterRun: (t) =>
    t.limitedUntil
      ? {
          stopped: "error",
          errorKind: "rate_limit",
          retryAfter: t.limitedUntil,
          error: `the Claude subscription's usage window is full until ${t.limitedUntil}`,
        }
      : undefined,
  call: {
    setup: (c) => {
      const mcp = claudeMcpConfig(c.mcp);
      return {
        script: `mkdir -p home tmp${c.keptAt ? " compactions" : ""}${mcp ? " && umask 077 && cat > home/mcp.json" : ""}`,
        stdin: mcp,
      };
    },
    env: (c) => ({
      ...claudeEnv({
        home: c.home,
        apiUrl: c.apiUrl,
        auth: "",
        tmp: c.tmp,
        maxCommandMs: c.timeoutMs,
      }),
      // A planner's call compacts as the workers' trials do (goal 070).
      ...claudeCompactionEnv(c.model),
      [PROMPT_VAR]: join(c.dir, CLAUDE_PROMPT),
    }),
    args: (c) => [
      "-p",
      ...claudeArgs(c.model, {
        tools: c.tools,
        mcpConfig: c.mcp ? join(c.home, "mcp.json") : undefined,
        // Its PreCompact hook, when the call's conversation is kept (goal 070).
        settings: c.keptAt ? claudeHookSettings(join(c.dir, "compactions"), c.keptAt) : undefined,
      }),
    ],
    // The prompt for Claude Code's stdin, handed over with the folder.
    prepare: (c, prompt) => writeFileSync(join(c.dir, CLAUDE_PROMPT), prompt, { mode: 0o600 }),
    own: (c, title, t) =>
      claudeOwn({
        root: c.dir,
        drops: ["compactions"],
        home: ["home"],
        title,
        session: () => t.session,
      }),
  },
  answer: (t) => t.result,
  // No tools, or the read-only file tools when it has past research to read.
  plannerTools: (read) => (read ? "Read,Grep,Glob" : ""),
  check: {
    tool: "Bash",
    why: (t) =>
      t.limitedUntil
        ? `the subscription's usage window is full until ${t.limitedUntil}`
        : undefined,
  },
};

/**
 * One worker trial in Claude Code: the CLI trial loop (cli/loop.ts) with Claude Code's entry. A
 * full usage window ends the trial with the time it resets.
 */
export function runClaudeTrial(spec: TrialSpec, deps: CliTrialDeps): Promise<TrialResult> {
  return runCliTrial(claudeProgram, { mode: "code", spec }, deps);
}

/**
 * One prompt through Claude Code outside a trial (a model check, a planner call), as `role` (the
 * planner's or the model check's own user) in a fresh directory, removed afterwards. `tools` ""
 * gives it none.
 */
export function claudeOnce(
  model: ModelConfig,
  prompt: string,
  deps: CliOnceDeps,
  o: CliOnceOptions & { tools: string },
): Promise<ClaudeTally> {
  return cliOnce(claudeProgram, model, prompt, deps, o);
}

/** The model check in Claude Code: the model must run one shell command through its Bash tool. */
export function claudeModelCheck(
  model: ModelConfig,
  deps: CliOnceDeps,
  timeoutMs?: number,
): Promise<RigCheckReport> {
  return cliModelCheck(claudeProgram, model, deps, timeoutMs);
}
