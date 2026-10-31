import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import { COMPACT_AT_DEFAULT } from "../../../core/compaction.ts";
import { type KeptAt, keptLine } from "../../compaction/index.ts";
import type { ModelConfig } from "../../model/index.ts";
import { hookArgv } from "../hooks/index.ts";
import { agentPath } from "../path.ts";
import { CLAUDE_BASE_ENV } from "./shell.ts";

/**
 * Claude Code as Thermite starts it, for the harness's agents and the supervisor's advisors: its
 * exit words, its environment and compaction settings, and its command line. Its entry, as every
 * role runs it, is src/agents/cli/claude-code.ts.
 *
 * Claude Code's own sandbox stays off, in the harness's trials and in the advisors (whose Claude
 * Code has none of its own tools), so the images carry no bubblewrap.
 * CLAUDE_CODE_SUBPROCESS_ENV_SCRUB would make the sandbox mandatory, and it cannot start in a rig:
 * its bubblewrap mounts, which the GPU fence (Landlock) refuses, as do a container's own
 * confinement and masked /proc; its network bridge's sockets, in TMPDIR, pass the 108-byte limit
 * of a socket's path in the lanes' areas. The scrub also forces Claude Code's default permission
 * mode, which refuses file edits and most commands in a headless run.
 */

export { claudeArgs, claudeModelId, claudeTerminalArgs } from "./args.ts";
export type { ClaudeTally } from "./events.ts";
export {
  claudeResultUsage,
  closeClaudeRun,
  newClaudeTally,
  readClaudeEvents,
} from "./events.ts";
export {
  CLAUDE_BASE_ENV,
  CLAUDE_PROMPT,
  CLAUDE_TOKEN_FD,
  claudeBin,
  claudeExe,
  claudeShell,
  PROMPT_VAR,
} from "./shell.ts";
export {
  CLAUDE_TERMINAL,
  CLAUDE_TERMINAL_ENV,
  claudeTerminalLog,
  claudeTerminalSeeds,
  claudeTerminalSettings,
} from "./terminal.ts";
export { claudeTranscript, type TranscriptState } from "./transcript.ts";
export type { PlanWindows, UsageWindow } from "./windows.ts";
export { mergeUsage } from "./windows.ts";

/** What to say when the image has no Claude Code: it is in an image only when built with it. */
export const NO_CLAUDE_CODE =
  "this rig's harness image has no Claude Code: build the image with the Claude Code option (CLAUDE_CODE_VERSION), or give the rig another harness on Edit rig";

/**
 * Why Claude Code exited, in words. A missing program says so, rather than the shell's note. Its
 * own `error:` line, anywhere in its output, comes before the last line (Bun prints the source
 * around an error after it).
 */
export function claudeExitWords(code: number | string | null, note: string, output = ""): string {
  if ((code === 126 || code === 127) && /claude: (No such file or directory|not found)/.test(note))
    return NO_CLAUDE_CODE;
  const own = /(?:^|\n)\s*error: ([^\n]+)/.exec(output)?.[1]?.trim();
  return `Claude Code exited ${code}: ${own ?? note}`;
}

/**
 * Claude Code's own compaction settings from the route (goal 070): the window it compacts within
 * (CLAUDE_CODE_AUTO_COMPACT_WINDOW, the route's window, so the owner's cap; Claude Code takes
 * 100,000 to 1,000,000 tokens and raises a smaller one to 100,000) and the compaction point
 * (CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, a percent of its window less the room it keeps for a reply;
 * it can only bring Claude Code's own point earlier). Its auto-compaction is on by default.
 */
export function claudeCompactionEnv(
  m: Pick<ModelConfig, "contextWindow" | "compactAt">,
): Record<string, string> {
  return {
    ...(m.contextWindow > 0 ? { CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(m.contextWindow) } : {}),
    CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: String(m.compactAt ?? COMPACT_AT_DEFAULT),
  };
}

/**
 * The environment Claude Code runs in: its home, Thermite's command and no telemetry. The token is
 * not in it: Claude Code reads it from file descriptor 3 (claudeShell).
 */
export function claudeEnv(o: {
  home: string;
  apiUrl: string;
  auth: string;
  tmp: string;
  /** The trial's or the call's length; none: a day, the most a command may ask for. */
  maxCommandMs?: number | undefined;
  extra?: Record<string, string> | undefined;
}): Record<string, string> {
  return {
    ...o.extra,
    HOME: o.home,
    PATH: agentPath(),
    TMPDIR: o.tmp,
    THERMITE_HARNESS_URL: o.apiUrl,
    THERMITE_TRIAL_AUTH: o.auth,
    ...CLAUDE_BASE_ENV,
    // A build or a test may run for most of the trial. Without a trial length (goal 079), a day:
    // the most a command may ask for, as Claude Code needs a number.
    BASH_MAX_TIMEOUT_MS: String(
      o.maxCommandMs !== undefined ? Math.max(120_000, o.maxCommandMs) : 86_400_000,
    ),
  };
}

/** Claude Code's PreCompact hook, as a program (compaction-hook.ts, in this folder). */
export const CLAUDE_HOOK = fileURLToPath(
  new URL(`./compaction-hook${extname(fileURLToPath(import.meta.url))}`, import.meta.url),
);

/** The folder in a Claude Code run's own area where its PreCompact hook copies the transcript. */
export const CLAUDE_DROPS = "claude-compactions";

/**
 * Claude Code's settings for a run that keeps its conversation before each compaction (goal 070),
 * given with `--settings` (Claude Code reads them whatever `--setting-sources` says): Thermite's
 * own hook program (compaction-hook.ts), run by Node without a shell, with the folder for its
 * copies (`drops`, in the run's own area). As the PreCompact hook, it copies the transcript and
 * prints the line that tells the summary where Thermite keeps the conversation (Claude Code
 * 2.1.305 appends a PreCompact hook's output to the compaction's instructions); as the PostCompact
 * hook, it keeps the summary. Claude Code keeps its transcript private to the agent's user, so
 * these copies are what the harness reads.
 */
export function claudeHookSettings(drops: string, at: KeptAt): string {
  return JSON.stringify({ hooks: compactionHooks(drops, at) });
}

/** One of Claude Code's hooks: a program run by Node without a shell, with its arguments. */
const commandHook = ([command, ...args]: string[], timeout: number) => [
  { hooks: [{ type: "command", command, args, timeout }] },
];

function compactionHooks(drops: string, at: KeptAt) {
  return {
    PreCompact: commandHook([process.execPath, CLAUDE_HOOK, "claude", drops, keptLine(at)], 60),
    PostCompact: commandHook([process.execPath, CLAUDE_HOOK, "claude-post", drops], 60),
  };
}

/**
 * The hooks whose signals Thermite follows in a trial (goal 169), each running Thermite's hook
 * program (../hooks/main.ts). Its PostToolUse and Stop hooks also give the agent the owner's
 * messages inside its turn, and wait for the harness at most a few seconds.
 */
export const CLAUDE_SIGNAL_HOOKS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "Stop",
  "StopFailure",
  "Notification",
  "SessionEnd",
] as const;

/**
 * Claude Code's settings for a trial (`--settings`): the hooks that signal each turn and tool
 * and give the agent the owner's messages inside its turn (goal 169), and, where the trial's
 * conversation is kept, its compaction hooks (claudeHookSettings).
 */
export function claudeTrialSettings(keep?: { drops: string; at: KeptAt } | undefined): string {
  const signals = Object.fromEntries(
    CLAUDE_SIGNAL_HOOKS.map((e) => [e, commandHook(hookArgv("claude-code"), 30)]),
  );
  return JSON.stringify({
    hooks: { ...signals, ...(keep ? compactionHooks(keep.drops, keep.at) : {}) },
  });
}
