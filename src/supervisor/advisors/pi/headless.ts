import { readFileSync } from "node:fs";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { z } from "zod";
import { mcpAgentTools } from "../../../agents/mcp/index.ts";
import type { ModelConfig } from "../../../agents/model/index.ts";
import type { UsageRoute } from "../../../core/usage.ts";
import type { AdvisorCall, AdvisorResult, AdvisorUsage } from "../call.ts";
import { type AdvisorRuntime, advisorRoute } from "../config.ts";
import { checkAnswer, piAdvisor } from "./agent.ts";
import { advisorPiTools } from "./tools.ts";

/** An advisor in Pi, as its runtime in the advisors file names it. */
export type PiRuntime = Extract<AdvisorRuntime, { runtime: "openai" }>;

/** The route's key, from the advisors file or its key file; "" when it has none. */
export function piKey(rt: PiRuntime): string {
  return rt.api_key ?? (rt.api_key_file ? readFileSync(rt.api_key_file, "utf8").trim() : "");
}

/** The advisor's model route, with `apiKey` as its key (the route's own, or its call's proxy's). */
export function piModel(rt: PiRuntime, at: { baseUrl: string; apiKey: string }): ModelConfig {
  return {
    api: rt.api === "anthropic" || rt.api === "chatgpt" ? rt.api : undefined,
    baseUrl: at.baseUrl,
    model: rt.model,
    apiKey: at.apiKey,
    contextWindow: rt.context_window,
    ...(rt.compact_at !== undefined ? { compactAt: rt.compact_at } : {}),
    maxTokens: rt.max_tokens ?? 0,
    reasoning: rt.reasoning,
  };
}

/** The call's start time as a name, for the files its compactions keep. */
export const callStamp = () => new Date().toISOString().replace(/[:.]/g, "-");

/**
 * An advisor on a model route (OpenAI-compatible, Anthropic, or a ChatGPT sign-in), run here in
 * Pi with read-only tools; it answers by calling `answer`, and a refused answer is asked again
 * with its problems.
 */
export async function runPi<S extends z.ZodType>(
  rt: PiRuntime,
  input: AdvisorCall<S>,
): Promise<AdvisorResult<z.infer<S>>> {
  const result: AdvisorResult<z.infer<S>> = {
    output: undefined,
    tokensIn: 0,
    tokensOut: 0,
    usd: 0,
  };
  const t = input.tools ?? {};
  const { tools, mcpAt } = advisorPiTools(t);
  const apiKey = piKey(rt);
  if (!apiKey) return { ...result, error: `advisor ${rt.name} has no key` };
  const cfg = piModel(rt, { baseUrl: rt.base_url.replace(/\/$/, ""), apiKey });
  // Each model call's usage, the compaction summaries' included (goal 075).
  const usage: AdvisorUsage = { ...(advisorRoute(rt) as UsageRoute), calls: [] };
  result.usage = usage;
  // Its instructions name the MCP servers that gave it tools.
  const sent = input.prompt({
    program: "pi",
    mcpServers: [...new Set((t.mcp?.tools ?? []).map((x) => x.server))],
    kbWrites: t.kb?.writes,
  });
  const call = callStamp();
  const end = await piAdvisor({
    name: rt.name,
    cfg,
    sent,
    tools: (mcp: AgentTool[]) => [...tools.slice(0, mcpAt), ...mcp, ...tools.slice(mcpAt)],
    mcp: t.mcp?.tools.length
      ? { listed: t.mcp, tools: (m) => mcpAgentTools(m.tools, m.call) }
      : undefined,
    answerSchema: input.answerSchema,
    check: async (answer) => {
      const r = await checkAnswer(input.schema, input.accept, answer);
      if (r.ok) result.output = r.output as z.infer<S>;
      return r;
    },
    maxTurns: rt.max_turns,
    timeoutS: rt.timeout_s,
    keep: async (n, markdown) => {
      if (!input.keeper) throw new Error("this advisor's call has no place to keep it");
      return input.keeper.keep(rt.name, call, n, markdown);
    },
    compacted: (c) => input.keeper?.done?.(c),
    later: input.later,
    usage: (u) => usage.calls.push(u),
  });
  result.tokensIn = end.tokensIn;
  result.tokensOut = end.tokensOut;
  if (end.compactions.length) result.compactions = end.compactions;
  result.usd =
    (result.tokensIn * rt.usd_per_mtok_in + result.tokensOut * rt.usd_per_mtok_out) / 1e6;
  if (!end.answered) result.error = end.error;
  return result;
}
