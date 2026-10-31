import { join } from "node:path";
import type { z } from "zod";
import {
  claudeCompactions,
  claudeOwn,
  claudeTranscript,
} from "../../../agents/compaction/index.ts";
import {
  CLAUDE_BASE_ENV,
  claudeBin,
  claudeCompactionEnv,
  claudeExe,
  claudeHookSettings,
  claudeResultUsage,
} from "../../../agents/programs/index.ts";
import { messageText } from "../../../agents/prompt.ts";
import type { UsageRoute } from "../../../core/usage.ts";
import type { AdvisorCall, AdvisorResult } from "../call.ts";
import { type AdvisorRuntime, advisorRoute } from "../config.ts";
import { serveAdvisorTools } from "../tools/index.ts";
import { callId, collectCompactions, lastJsonObject, runCli } from "./cli.ts";

/**
 * An advisor in Claude Code, with a Claude subscription's token from control: none of Claude
 * Code's own tools, only the advisor's, served to it over MCP on localhost for the call.
 */
export async function runClaudeCode<S extends z.ZodType>(
  rt: Extract<AdvisorRuntime, { runtime: "claude-code" }>,
  input: AdvisorCall<S>,
): Promise<AdvisorResult<z.infer<S>>> {
  // None of Claude Code's own tools; the run's past research, when it has a search, and the MCP
  // servers the run's kit gives the advisors, over MCP on localhost for this call alone, with
  // only those servers and only their tools allowed.
  const t = input.tools;
  const past =
    t?.kb || t?.mcp?.servers.length || t?.code || t?.research || t?.paper
      ? await serveAdvisorTools({
          kb: t.kb,
          mcp: t.mcp,
          code: t.code,
          research: t.research,
          paper: t.paper,
        })
      : undefined;
  // Before each of Claude Code's own compactions, its PreCompact hook copies the conversation
  // into the call's folder and tells the summary where the supervisor keeps it; after the call,
  // each compaction its transcript shows is kept with the round's records (goal 070).
  const call = callId();
  const at = input.keeper?.at?.(rt.name, call);
  const keeper = input.keeper;
  try {
    return await runCli(
      {
        extra: at
          ? (home) => ["--settings", claudeHookSettings(join(home, "compactions"), at)]
          : undefined,
        collect: keeper
          ? (home) => {
              const said = claudeTranscript(home, []);
              return collectCompactions({
                harness: "claude-code",
                advisor: rt.name,
                call,
                count: said !== undefined ? claudeCompactions(said) : 0,
                own: claudeOwn({
                  root: home,
                  drops: ["compactions"],
                  home: [],
                  title: `Advisor ${rt.name}`,
                }),
                keeper,
              });
            }
          : undefined,
        argv: [
          claudeExe() ?? claudeBin(),
          "-p",
          "--output-format",
          "json",
          "--model",
          rt.model,
          "--tools",
          "",
          "--setting-sources",
          "",
          "--strict-mcp-config",
          ...(rt.effort ? ["--effort", rt.effort] : []),
          ...(past?.args ?? []),
        ],
        timeout_s: rt.timeout_s,
        // The token on file descriptor 3, as for the agents in the harness: in no environment
        // and no file. Claude Code's own sandbox stays off; with none of its tools, Claude Code
        // runs no commands here. It compacts on its own, within the advisor's window and at its
        // point, as the workers' Claude Code does (goal 070).
        env: {
          ...CLAUDE_BASE_ENV,
          ...claudeCompactionEnv({
            contextWindow: rt.context_window ?? 0,
            compactAt: rt.compact_at,
          }),
        },
        token: rt.token,
        // Its model usage, from its JSON result, which does not say how many calls it made.
        usage: {
          route: advisorRoute(rt) as UsageRoute,
          calls: (out) => {
            const u = claudeResultUsage(lastJsonObject(out), null);
            return u ? [u] : [];
          },
        },
      },
      messageText(
        input.prompt({
          program: "claude-code",
          mcpServers: t?.mcp?.servers ?? [],
          kbWrites: t?.kb?.writes,
          answerSchema: input.answerSchema,
        }),
      ),
      input.schema,
    );
  } finally {
    await past?.close();
  }
}
