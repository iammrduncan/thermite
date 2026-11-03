import { existsSync } from "node:fs";
import { join } from "node:path";

/** Claude Code's binary: THERMITE_CLAUDE_BIN, else `claude` on the PATH (read when used). */
export const claudeBin = () => process.env.THERMITE_CLAUDE_BIN ?? "claude";

/** The file descriptor Claude Code reads the sign-in token from, once, when it starts. */
export const CLAUDE_TOKEN_FD = 3;

/**
 * What every Claude Code run here has in its environment, the agents' and the supervisor's
 * advisors': where the token is (CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR), never the token, and no
 * update checks, reports or other traffic. It reads no CLAUDE.md of the project's or anyone's
 * (goal 166): an agent's prompt is only what its role's definition rendered, which Thermite keeps.
 * Never CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: it would turn on Claude Code's own sandbox, which cannot
 * start in a rig (index.ts's opening comment says why).
 */
export const CLAUDE_BASE_ENV: Readonly<Record<string, string>> = {
  CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: String(CLAUDE_TOKEN_FD),
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
  DISABLE_AUTOUPDATER: "1",
};

/**
 * Claude Code's command line behind `sh`, which moves the run's stdin, the token, to file
 * descriptor 3 (CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR) and gives Claude Code its prompt's file
 * for its own. Claude Code reads the token from there once, so it is in no environment: not Claude
 * Code's, nor its commands'. `after` is more of the shell line, after the redirection (where the
 * output goes). The broker gives a run only its stdin; the supervisor, which starts an advisor's
 * Claude Code itself, opens descriptor 3 directly and keeps stdin for the prompt.
 */
export function claudeShell(argv: string[], after = ""): string[] {
  const prompt = `"$${PROMPT_VAR}"`;
  return ["sh", "-c", `exec ${CLAUDE_TOKEN_FD}<&0 && exec "$@" < ${prompt}${after}`, "sh", ...argv];
}

/**
 * The prompt's file in a run's own folder, and the variable that names it to the shell: Claude
 * Code reads its prompt on stdin (`-p` with none given). One argument holds at most 128 KiB on
 * Linux, and a brief or a planner's context has no such limit (goal 171).
 */
export const CLAUDE_PROMPT = "claude-prompt.txt";
export const PROMPT_VAR = "THERMITE_CLAUDE_PROMPT";

/** Claude Code's executable as an absolute path (found on PATH), or undefined if it is not there. */
export function claudeExe(): string | undefined {
  const bin = claudeBin();
  if (bin.startsWith("/")) return bin;
  for (const dir of (process.env.PATH ?? "").split(":")) {
    const p = join(dir, bin);
    if (dir && existsSync(p)) return p;
  }
  return undefined;
}
