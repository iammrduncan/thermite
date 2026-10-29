import { Agent, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { type CompactionReport, Compactor, summarizer } from "../../../agents/compaction/index.ts";
import { buildModel, type ModelConfig, PiMeter } from "../../../agents/model/index.ts";
import { messageText, type Prompt, systemText } from "../../../agents/prompt.ts";
import { renderCompacted } from "../../../agents/roles/index.ts";
import { routeRefusal } from "../../../core/agents.ts";
import { canonicalJson } from "../../../core/canonical.ts";
import type { CallUsage } from "../../../core/usage.ts";
import { classifyProviderError, KIND_WORDS } from "../provider-errors.ts";
import { PlannerCallError } from "./causes.ts";
import { PLAN_SPEC, type PlannerCallSpec } from "./submit.ts";

/**
 * The planner in Pi: one agent with submit_plan, the knowledge base's tools and the MCP servers'
 * tools, compacted near its window.
 */

/**
 * The MCP servers the run's kit gives the planner (goal 068): their names (in the prompt, and for
 * another harness's configuration) and, in Pi, a tool for each MCP tool through the gateway.
 */
export interface PlannerMcp {
  servers: string[];
  tools: AgentTool[];
  /**
   * Thermite's knowledge base (goal 175): the kinds the planner may write, and in Pi its tools
   * (kb_search, kb_read, and kb_write when it may write). None: no knowledge base tools.
   */
  kb?: { writes: string[]; tools: AgentTool[] } | undefined;
}

/**
 * Where the planner's compactions go (goal 070): in Pi, a planner call's conversation grows with
 * what its tools return (past research, MCP servers) and is compacted near the window as a
 * worker's is. The harness keeps each conversation in the run's research folder and records it.
 */
export interface PlannerCompaction {
  keep(n: number, markdown: string): { path: string; rel: string };
  done(r: CompactionReport): void;
}

export async function callPlanner(
  cfg: ModelConfig,
  sent: Prompt,
  signal?: AbortSignal,
  mcp?: PlannerMcp,
  compaction?: PlannerCompaction,
  usage?: (u: CallUsage) => void,
  spec: PlannerCallSpec = PLAN_SPEC,
  /** Keeps each later turn the call sends, as its first prompt is kept (goal 166). */
  kept?: (p: Prompt) => void,
): Promise<unknown> {
  if (routeRefusal(cfg.api, "pi") === "claude-code")
    throw new Error(
      "a Claude subscription runs only in Claude Code, and none is set up for the planner",
    );
  const { models, model, thinkingLevel } = buildModel(cfg);
  // Each model call's usage, the compaction summaries' included (goal 075).
  const meter = usage ? new PiMeter(usage) : undefined;
  let captured: unknown;
  const agent = new Agent({
    initialState: {
      systemPrompt: systemText(sent),
      model,
      thinkingLevel,
      tools: [
        // Thermite's knowledge base (goal 175), run by the harness for the planner's slot.
        ...(mcp?.kb?.tools ?? []),
        // The MCP servers the run's kit gives the planner, through the harness's gateway.
        ...(mcp?.tools ?? []),
        {
          name: "submit_plan",
          label: "submit_plan",
          description: spec.description,
          parameters: spec.parameters,
          execute: async (_id, params) => {
            captured = params;
            return {
              content: [{ type: "text", text: "plan received" }],
              details: {},
              terminate: true,
            };
          },
        },
      ],
    },
    streamFn: meter ? meter.streamFn(models) : models.streamSimple.bind(models),
  });
  meter?.watch(agent);
  // Its later turns (goal 166), numbered after its first message.
  let said = 0;
  // Near the window its conversation is compacted and the call goes on (goal 070). The planner
  // has no file tool: the run keeps the conversation, and the summary says where.
  let tooBig: string | undefined;
  const compactor = new Compactor({
    window: cfg.contextWindow,
    at: cfg.compactAt,
    convert: (messages: AgentMessage[]) =>
      messages.filter(
        (m) =>
          m.role === "system" ||
          m.role === "user" ||
          m.role === "assistant" ||
          m.role === "toolResult",
      ) as Message[],
    summarize: summarizer(cfg, meter),
    keep: async (n, markdown) => {
      if (!compaction) throw new Error("this planner has no place to keep it");
      const { rel } = compaction.keep(n, markdown);
      return { path: `the run's research folder, ${rel}` };
    },
    done: async (r) => compaction?.done(r),
    stop: (reason) => {
      tooBig = reason;
      agent.abort();
    },
    title: "The planner",
    // What it goes on from, in its own role's words (the planner's or the research planner's).
    after: (c) => renderCompacted({ role: sent.role, turn: ++said, ...c }),
    sent: kept,
  });
  agent.prepareRequest = compactor.hook(agent);
  // A submit_plan its schema refuses goes back to the planner with the reason. The same refused
  // arguments a second time end the call (goal 079): it made no progress, and would go on.
  let repeated: string | undefined;
  const refused = new Set<string>();
  const argsOf = new Map<string, string>();
  agent.subscribe((e) => {
    if (e.type === "tool_execution_start" && e.toolName === "submit_plan")
      argsOf.set(e.toolCallId, canonicalJson(e.args ?? null));
    if (e.type !== "tool_execution_end" || e.toolName !== "submit_plan" || !e.isError) return;
    const args = argsOf.get(e.toolCallId) ?? "";
    if (refused.has(args)) {
      const why = (e.result?.content as { text?: string }[] | undefined)
        ?.map((c) => c.text ?? "")
        .join(" ");
      repeated = `it sent the same refused plan again: ${(why || "its arguments broke the tool's schema").slice(0, 500)}`;
      agent.abort();
    }
    refused.add(args);
  });
  // No time limit (goal 079): the call ends when the planner answers, or when its run is paused
  // or closed (the scheduler cancels it).
  const cancel = () => agent.abort();
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    if (!signal?.aborted) await agent.prompt(messageText(sent));
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
  if (tooBig) throw new PlannerCallError("provider_error", tooBig);
  if (repeated && captured === undefined) throw new PlannerCallError("invalid", repeated);
  if (captured === undefined) {
    if (signal?.aborted) throw new PlannerCallError("cancelled", "the run stopped during the call");
    // Why it gave no plan, from its last reply (goal 079).
    const last = [
      ...(agent.state.messages as { role?: string; stopReason?: string; errorMessage?: string }[]),
    ]
      .reverse()
      .find((m) => m.role === "assistant");
    if (last?.stopReason === "length")
      throw new PlannerCallError(
        "cut_off",
        "its reply was cut off at the output limit before it called submit_plan",
      );
    if (last?.stopReason === "error") {
      const words = last.errorMessage ?? "no detail";
      throw new PlannerCallError(
        "provider_error",
        `${KIND_WORDS[classifyProviderError(words).kind]}: ${words.slice(0, 400)}`,
      );
    }
    if (last?.stopReason === "aborted")
      throw new PlannerCallError("cancelled", "the call was stopped");
    throw new PlannerCallError("text_only", "it answered in text and did not call submit_plan");
  }
  return captured;
}
