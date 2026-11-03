import { join } from "node:path";
import type { ModelConfig } from "../../model/index.ts";
import type { TerminalLog, TerminalProfile } from "../terminal.ts";
import { tomlString } from "./toml.ts";

/**
 * The Codex CLI in its own terminal (goal 169), as the spike ran Codex 0.162.1: what the terminal
 * host sends it to interrupt and to end it, its configuration and its command line there, and
 * where its rollout is.
 */

export const CODEX_TERMINAL: TerminalProfile = {
  // Esc ends the turn but not its running command, which goes on in the background until `/stop`
  // closes it.
  interrupt: [{ keys: ["esc"] }, { pauseMs: 500 }, { text: "/stop" }],
  end: [{ text: "/exit" }],
};

/**
 * Its configuration in a terminal: codexConfig's (`base`), with the workspace `cwd` trusted
 * (without it, Codex asks whether to trust the folder and waits), its notices of full access and
 * of a rate limit hidden, and no animations, tips or recaps in its terminal.
 */
export function codexTerminalConfig(base: string, cwd: string): string {
  return [
    base,
    `[projects.${tomlString(cwd)}]`,
    'trust_level = "trusted"',
    "",
    "[notice]",
    "hide_full_access_warning = true",
    "hide_rate_limit_model_nudge = true",
    "",
    "[tui]",
    "animations = false",
    "show_tooltips = false",
    "auto_recap = false",
    "",
  ].join("\n");
}

/**
 * Its command line in a terminal: no daemon, approvals and its sandbox off, Thermite's hooks run
 * without a trusted hash (as in codexArgs), in the workspace `cwd`, with the first message as its
 * last argument. After a crash, `resume` (the thread's id) continues the same thread, with the
 * same flags and no message.
 */
export function codexTerminalArgs(
  m: ModelConfig,
  o: { cwd: string; first?: string | undefined; resume?: string | undefined },
): string[] {
  const flags = [
    "--no-daemon",
    "--dangerously-bypass-approvals-and-sandbox",
    "--dangerously-bypass-hook-trust",
    "-C",
    o.cwd,
    "--model",
    m.model,
  ];
  if (o.resume) return ["resume", ...flags, o.resume];
  return [...flags, ...(o.first !== undefined ? [o.first] : [])];
}

/** Where Codex writes its rollout: `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<time>-<thread>.jsonl`. */
export function codexTerminalLog(codexHome: string): TerminalLog {
  return { dir: join(codexHome, "sessions"), depth: 3, name: "^rollout-.*\\.jsonl$" };
}
