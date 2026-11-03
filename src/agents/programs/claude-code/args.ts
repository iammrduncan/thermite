import type { ModelConfig } from "../../model/index.ts";

/**
 * Claude Code's command line, headless (`-p`, claudeArgs) and in its own terminal
 * (claudeTerminalArgs, goal 169). Both run it with no settings files, no MCP servers but those
 * given, and its permissions bypassed.
 */

/** Claude Code's model name for a route's model (claude-code:opus-5.5[1m] → claude-opus-5-5[1m]). */
export function claudeModelId(m: ModelConfig): string {
  return m.model;
}

interface ClaudeFlags {
  tools?: string | undefined;
  /** A file with the MCP servers it may use (at the harness's gateway), and only those. */
  mcpConfig?: string | undefined;
  /** Thermite's settings for the run, as JSON (claudeHookSettings, claudeTrialSettings). */
  settings?: string | undefined;
}

/** The flags both forms share: the model, its effort, permissions, settings and MCP servers. */
function claudeFlags(m: ModelConfig, o: ClaudeFlags): string[] {
  return [
    "--model",
    claudeModelId(m),
    "--permission-mode",
    "bypassPermissions",
    "--setting-sources",
    "",
    "--strict-mcp-config",
    ...(o.mcpConfig ? ["--mcp-config", o.mcpConfig] : []),
    ...(o.settings ? ["--settings", o.settings] : []),
    ...(o.tools !== undefined ? ["--tools", o.tools] : []),
    ...(m.effort
      ? ["--effort", m.effort]
      : m.reasoning && m.reasoning !== "off"
        ? ["--effort", m.reasoning]
        : []),
  ];
}

/**
 * The flags every headless Claude Code run here has: no settings files, no MCP, permissions
 * bypassed; `settings`, Thermite's own (its PreCompact hook), when given.
 */
export function claudeArgs(
  m: ModelConfig,
  o: ClaudeFlags & { session?: string | undefined },
): string[] {
  return [
    "--output-format",
    "stream-json",
    "--verbose",
    ...claudeFlags(m, o),
    ...(o.session ? ["--resume", o.session] : []),
  ];
}

/**
 * Claude Code's command line in its own terminal (goal 169), with its question tool denied, so
 * nothing waits for an answer. A new session takes the id the harness gives it and its first
 * message after `--`: `--disallowedTools` takes several values, and would take the message too.
 * After a crash, `resume` opens the same session again, with no message.
 */
export function claudeTerminalArgs(
  m: ModelConfig,
  o: ClaudeFlags & { session: string; resume?: boolean | undefined; first?: string | undefined },
): string[] {
  const start = o.resume
    ? ["--resume", o.session]
    : ["--session-id", o.session, ...(o.first !== undefined ? ["--", o.first] : [])];
  return [...claudeFlags(m, o), "--disallowedTools", "AskUserQuestion", ...start];
}
