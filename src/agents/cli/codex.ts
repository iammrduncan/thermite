import { lstatSync } from "node:fs";
import { join } from "node:path";
import { codexOwn, findCodexRollout, readUnder } from "../compaction/index.ts";
import {
  type CodexTally,
  codexArgs,
  codexBin,
  codexConfig,
  codexEnv,
  codexExe,
  codexExitWords,
  codexHooks,
  codexNotify,
  codexRollout,
  codexTerminalArgs,
  codexTerminalConfig,
  codexTerminalLog,
  hookSignals,
  newCodexTally,
  readCodexEvents,
  tallyLog,
} from "../programs/index.ts";
import type { CliProgram, CliRun } from "./program.ts";

/**
 * Trials, model checks and planner calls in the Codex CLI, OpenAI's open-source agent program,
 * for a ChatGPT sign-in or an OpenAI-compatible route. Codex runs headless (`codex exec --json`,
 * its approvals and its own sandbox off), or in its own terminal where the rig says so (goal 169;
 * terminal.ts), as the lane's own user, in the lane's workspace, under the lane's memory, disk
 * and time limits, as OpenCode and Claude Code do: it has the lane's access and none of the
 * judge's. Its own sandbox would cut its commands off the harness API;
 * the boundary is the user it runs as, not its permission rules.
 *
 * It starts with a home of its own (CODEX_HOME) whose configuration names one provider: the
 * harness API's model proxy, over OpenAI's Responses API (the only API Codex speaks), with the
 * trial's token, or a check's or plan's short-lived one, from THERMITE_PROXY_AUTH. The proxy
 * checks that token and adds the real key, so a ChatGPT sign-in's access token or a provider's
 * key never reaches the lane (unlike a Claude subscription's token, which only Claude Code may
 * carry). Its analytics, feedback, update checks and history file are off, and so is its hosted
 * web search, which the ChatGPT route may refuse: the agent fetches pages with its shell or with
 * `thermite-trial research fetch`. A project's own execution-policy rules are not loaded.
 *
 * Thermite's own tools are the `thermite-trial` command, which calls the harness API with the
 * trial's token. One `codex exec` takes one prompt (on its stdin, so a long brief fits): a run
 * that ends without a submission is resumed (`codex exec resume`) with a nudge or the owner's
 * messages.
 */

/**
 * What the Codex CLI itself uses, as its limits note says: in its own terminal, the default, with
 * the terminal host, as the harness image's terminal check measured it (2026-10-29: 304 to 307 MiB
 * at its peak).
 */
export const CODEX_MEMORY = "about 300 MiB";

/** Where a trial's Codex home is, under the trial's area: CODEX_HOME. */
const CODEX_HOME = ["codex-home", ".codex"];

/** The largest rollout read to compare with the output, in bytes: a larger one is not compared. */
const ROLLOUT_COMPARE_MAX = 16 * 1024 * 1024;

/**
 * The thread's rollout, which `codex exec` writes as the trial goes (readable by the harness: Codex
 * writes it 0644), read whole into a tally; undefined when there is none, or it is too large.
 */
function rolloutTally(run: CliRun, thread: string | undefined) {
  const parts = findCodexRollout(run.area, CODEX_HOME, thread);
  if (!parts) return undefined;
  if (lstatSync(join(run.area, ...parts)).size > ROLLOUT_COMPARE_MAX) return undefined;
  const text = readUnder(run.area, parts, ROLLOUT_COMPARE_MAX);
  return text === undefined ? undefined : tallyLog(codexRollout, text);
}

/** A trial's configuration for Codex: its route through the proxy, its MCP servers, its notify. */
const trialConfig = (run: CliRun) =>
  codexConfig(run.model, `${run.apiUrl}/v1/model-proxy`, run.mcp, run.keptAt, codexNotify());

/**
 * Codex in the CLI trial loop and the one-prompt call: `codex exec` resumes its thread with each
 * continuation; in its own terminal (goal 169), the workspace trusted, and its rollout copied by
 * the terminal host.
 */
export const codexProgram: CliProgram<CodexTally> = {
  id: "codex",
  name: "Codex",
  prefix: "codex",
  eventsVar: "THERMITE_CODEX_EVENTS",
  turnWords: "each message or tool call is one",
  memory: CODEX_MEMORY,
  bin: codexBin,
  exe: codexExe,
  // Its hooks and notify signal each turn and tool, and its hooks give the agent the owner's
  // messages inside its turn (goal 169).
  setup: (run) => ({
    script:
      'mkdir -p codex-home/.codex codex-tmp && cat > codex-home/.codex/config.toml && printf %s "$1" > codex-home/.codex/hooks.json && : > codex-events.jsonl && chmod 0644 codex-events.jsonl && : > codex-signals.jsonl && chmod 0644 codex-signals.jsonl',
    args: ["sh", codexHooks()],
    stdin: trialConfig(run),
  }),
  // The proxy takes the trial's credential, and so does the gateway of its MCP servers (goal 068).
  env: (run) =>
    codexEnv({
      home: run.home,
      apiUrl: run.apiUrl,
      auth: run.auth,
      proxyAuth: run.auth,
      mcpAuth: run.mcp?.auth,
      tmp: run.tmp,
      extra: run.env,
    }),
  args: (run, session) => codexArgs(run.model, { session, hooks: true }),
  newTally: newCodexTally,
  read: readCodexEvents,
  found: (t) => t.compactions.splice(0),
  // Each compaction's conversation, from Codex's rollout of the thread in its home (goal 070).
  own: (run, t) =>
    codexOwn({
      root: run.area,
      home: CODEX_HOME,
      title: run.title,
      thread: () => t.session,
    }),
  exitWords: codexExitWords,
  // Its rollout of the thread, compared with its output at the trial's end (goal 169).
  sessionLog: (run, t) => rolloutTally(run, t.session),
  signals: {
    adapter: () => hookSignals("codex"),
    how: { "after-tool": "Codex's PostToolUse hook", "turn-end": "Codex's Stop hook" },
  },
  // In its own terminal: its configuration with the workspace trusted (else it asks), its thread
  // resumed after a crash, its rollout copied (goal 169).
  terminal: {
    start: (run, at) => ({
      args: codexTerminalArgs(run.model, {
        cwd: at.cwd,
        resume: at.resume ? at.session : undefined,
      }),
      seeds: [
        {
          path: join(run.area, ...CODEX_HOME, "config.toml"),
          content: codexTerminalConfig(trialConfig(run), at.cwd),
          mode: 0o600,
        },
      ],
      log: codexTerminalLog(join(run.area, ...CODEX_HOME)),
    }),
    log: { adapter: () => codexRollout, from: "copy" },
    // Its compactions (goal 070), as its output reports them headless.
    take: (e, t, at) => {
      if (e.type === "compaction")
        t.compactions.push({ at, tokensBefore: null, tokensAfter: null });
    },
  },
  call: {
    setup: (c) => ({
      script: "mkdir -p home/.codex tmp && cat > home/.codex/config.toml",
      stdin: codexConfig(c.model, `${c.apiUrl}/v1/model-proxy`, c.mcp, c.keptAt),
    }),
    // It reaches the model through the proxy with a credential minted for this call.
    env: (c) =>
      codexEnv({
        home: c.home,
        apiUrl: c.apiUrl,
        auth: "",
        proxyAuth: c.proxyAuth(),
        mcpAuth: c.mcp?.auth,
        tmp: c.tmp,
      }),
    args: (c) => codexArgs(c.model),
    // Each compaction's conversation, from its rollout in the call's folder (goal 070).
    own: (c, title, t) =>
      codexOwn({ root: c.dir, home: ["home", ".codex"], title, thread: () => t.session }),
  },
  check: { baseUrl: (m) => m.baseUrl },
};
