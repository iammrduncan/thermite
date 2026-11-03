import type { Agent, AgentTool } from "@earendil-works/pi-agent-core";
import type { McpForAgent } from "../mcp/index.ts";
import type { Prompt } from "../prompt.ts";

/**
 * What a role's call in Pi hands its Pi view (goal 169), whoever runs it: a worker's trial, a
 * planner's call or an advisor's. The call hands the view its levers once its agent is built, and
 * asks it, when the agent stops, whether the owner interrupted it. Each of the view's commands is
 * one of these levers.
 */
export interface RoleView {
  attach(levers: ViewLevers): void;
  /** Whether the agent's reply stopped because the owner interrupted it: asked once per stop. */
  interrupted(): boolean;
}

/** What the Pi view's console reaches in a running call: each of its calls is one of these. */
export interface ViewLevers {
  agent: Agent;
  /** Compacts the conversation before the agent's next model call, as the owner asked. */
  compact(): void;
  /** The owner's words as the call's role puts them to its agent: a later turn of the call. */
  ownerTurn(text: string): Prompt;
  /** Keeps a later turn once it enters the conversation (goal 166). */
  sent?: ((p: Prompt) => void) | undefined;
  /** The call's MCP tools now, with the servers that failed. */
  mcp(): McpForAgent | undefined;
  /** Gives the agent a new list of MCP tools, from its next turn. */
  setMcp(mcp: McpForAgent): void;
  /** The call's counts so far. */
  status(): ViewCounts;
  /** Why the call takes no more of the owner's words (it has answered, or is ending). */
  closed(): string | undefined;
}

/** A call's counts, as its Pi view shows them. */
export interface ViewCounts {
  turns: number;
  toolCalls: number;
  tokensIn: number;
  tokensOut: number;
  compactions: number;
  /** Its time left, when it has a length. */
  msLeft?: number | undefined;
  maxTurns?: number | undefined;
  model: string;
}

/** A wait for the provider, as the view draws it: until when, its kind and the provider's words. */
export interface ViewWait {
  until: string;
  kind: string;
  words: string;
}

/**
 * Lets a call give its agent new tools while it runs (the owner's /mcp reconnect in its Pi view):
 * from the agent's next turn in the run under way, declared to the model as Pi declares a change
 * of tools, and for its later runs. Set up before the agent's first run: Pi reads its next-turn
 * hook when a run starts.
 */
export function swappableTools(agent: Agent): (tools: AgentTool[]) => void {
  let next: AgentTool[] | undefined;
  agent.prepareNextTurnWithContext = (turn) => {
    const tools = next;
    next = undefined;
    return tools ? { context: { ...turn.context, tools } } : undefined;
  };
  return (tools) => {
    agent.state.tools = tools;
    next = tools;
  };
}
