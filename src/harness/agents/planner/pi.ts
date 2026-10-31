import { Agent, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { type CompactionReport, Compactor, summarizer } from "../../../agents/compaction/index.ts";
import { linkSession, type SessionLink } from "../../../agents/live-session.ts";
import type { McpForAgent } from "../../../agents/mcp/index.ts";
import { mcpAgentTools } from "../../../agents/mcp/index.ts";
import { buildModel, type ModelConfig, PiMeter } from "../../../agents/model/index.ts";
import { type RoleView, swappableTools } from "../../../agents/pi-view/index.ts";
import { messageText, type Prompt, systemText } from "../../../agents/prompt.ts";
import {
  renderCompacted,
  renderPlannerTurn,
  renderResearchPlannerTurn,
} from "../../../agents/roles/index.ts";
import { routeRefusal } from "../../../core/agents.ts";
import { canonicalJson } from "../../../core/canonical.ts";
import type { CallUsage } from "../../../core/usage.ts";
import { classifyProviderError, KIND_WORDS } from "../provider-errors.ts";
import { PlannerCallError } from "./causes.ts";
import { PLAN_SPEC, type PlannerCallSpec } from "./submit.ts";

/**
 * The planner in Pi: one agent with submit_plan, the knowledge base's tools and the MCP servers'
 * tools, compacted near its window. It runs in the controller, or, on a rig whose agents run in
 * their own terminal, in a process of its own in its Pi view (planner-main.ts, goal 169).
 */

/**
 * The MCP servers the run's kit gives the planner (goal 068): their names (in the prompt, and for
 * another harness's configuration) and, in Pi, a tool for each MCP tool through the gateway.
 */
export interface PlannerMcp {
  servers: string[];
  tools: AgentTool[];
  /**
   * In its own process: the gateway's list its tools came from, which its Pi view's /mcp shows
   * and /mcp reconnect lists again.
   */
  listed?: McpForAgent | undefined;
  /**
   * Thermite's knowledge base (goal 175): the kinds the planner may write, and in Pi its tools
   * (kb_search, kb_read, and kb_write when it may write). None: no knowledge base tools.
   */
  kb?: { writes: string[]; tools: AgentTool[] } | undefined;
}

/**
 * Where the planner's compactions go (goal 070): in Pi, a planner call's conversation grows with
 * what its tools return (past research, MCP servers) and is compacted near the window as a
 * worker's is. The harness keeps each conversation in the run's research folder and records it;
 * a planner in its own process asks the harness over its call's routes.
 */
export interface PlannerCompaction {
  keep(
    n: number,
    markdown: string,
  ): { path: string; rel: string } | Promise<{ path: string; rel: string }>;
  done(r: CompactionReport): unknown;
}

/** What a planner call in Pi takes besides its route and its prompt. */
export interface PlannerPiOptions {
  signal?: AbortSignal | undefined;
  mcp?: PlannerMcp | undefined;
  compaction?: PlannerCompaction | undefined;
  /** Each model call's usage (goal 075). */
  usage?: ((u: CallUsage) => void) | undefined;
  spec?: PlannerCallSpec | undefined;
  /** Keeps each later turn the call sends, as its first prompt is kept (goal 166). */
  kept?: ((p: Prompt) => void) | undefined;
  /**
   * In its own process, in its Pi view (goal 169): the view's console, given the call's levers,
   * and the session's link, which sends its lines to Live and brings the owner's messages in
   * before its next model call.
   */
  view?: RoleView | undefined;
  link?: Pick<SessionLink, "live" | "messages" | "read"> | undefined;
}

export async function callPlanner(
  cfg: ModelConfig,
  sent: Prompt,
  o: PlannerPiOptions = {},
): Promise<unknown> {
  const { signal, mcp, compaction, usage, kept } = o;
  const spec = o.spec ?? PLAN_SPEC;
  if (routeRefusal(cfg.api, "pi") === "claude-code")
    throw new Error(
      "a Claude subscription runs only in Claude Code, and none is set up for the planner",
    );
  const { models, model, thinkingLevel } = buildModel(cfg);
  // Each model call's usage, the compaction summaries' included (goal 075).
  const meter = usage ? new PiMeter(usage) : undefined;
  let captured: unknown;
  const submit: AgentTool = {
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
  };
  // Thermite's knowledge base (goal 175), run by the harness for the planner's slot; the MCP
  // servers the run's kit gives the planner, through the harness's gateway; and submit_plan.
  const toolsWith = (mcpTools: AgentTool[]) => [...(mcp?.kb?.tools ?? []), ...mcpTools, submit];
  const agent = new Agent({
    initialState: {
      systemPrompt: systemText(sent),
      model,
      thinkingLevel,
      tools: toolsWith(mcp?.tools ?? []),
    },
    streamFn: meter ? meter.streamFn(models) : models.streamSimple.bind(models),
  });
  meter?.watch(agent);
  // Its later turns (goal 166), numbered after its first message.
  let said = 0;
  const turnOf = sent.role === "research-planner" ? renderResearchPlannerTurn : renderPlannerTurn;
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
      const { rel } = await compaction.keep(n, markdown);
      return { path: `the run's research folder, ${rel}` };
    },
    done: async (r) => {
      await compaction?.done(r);
    },
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
  // In its Pi view (goal 169): the owner's console reaches the call through these levers, and the
  // owner's messages come in before its next model call, until it has sent its plan.
  const closed = () =>
    captured === undefined ? undefined : "the planner has sent its plan: nothing more goes in";
  if (o.link) {
    const waiting = o.link.messages;
    linkSession(agent, {
      ...o.link,
      messages: waiting ? async () => (closed() ? [] : waiting()) : undefined,
      ownerTurn: (m) =>
        turnOf({ program: "pi", turn: ++said, kind: "owner", id: m.id, text: m.text }),
      sent: kept,
    });
  }
  if (o.view) {
    const counts = { turns: 0, toolCalls: 0, tokensIn: 0, tokensOut: 0 };
    agent.subscribe((e) => {
      if (e.type === "turn_end") counts.turns++;
      else if (e.type === "tool_execution_start") counts.toolCalls++;
      else if (e.type === "message_end" && e.message.role === "assistant") {
        const u = (e.message as { usage?: { input?: number; output?: number } }).usage;
        counts.tokensIn += u?.input ?? 0;
        counts.tokensOut += u?.output ?? 0;
      }
    });
    const swap = swappableTools(agent);
    let listed = mcp?.listed;
    o.view.attach({
      agent,
      compact: () => compactor.force("asked"),
      ownerTurn: (text) => turnOf({ program: "pi", turn: ++said, kind: "owner", text }),
      sent: kept,
      mcp: () => listed,
      setMcp: (m) => {
        listed = m;
        swap(toolsWith(mcpAgentTools(m.tools, m.call)));
      },
      status: () => ({ ...counts, compactions: compactor.count, model: cfg.model }),
      closed,
    });
  }
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
      throw new PlannerCallError(
        "cancelled",
        o.view?.interrupted()
          ? "the owner stopped its reply from its Pi view"
          : "the call was stopped",
      );
    throw new PlannerCallError("text_only", "it answered in text and did not call submit_plan");
  }
  return captured;
}
