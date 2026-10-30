import type { Agent } from "@earendil-works/pi-agent-core";
import { z } from "zod";
import type { CompactionReport } from "../../../agents/compaction/index.ts";
import type { ModelConfig } from "../../../agents/model/index.ts";
import type { Prompt, Section } from "../../../agents/prompt.ts";
import type { KbCall, NoteRequest } from "../../../agents/tools/index.ts";
import type { McpCallResult } from "../../../common/mcp-client.ts";
import type { LaneLimitValues } from "../../../core/contract.ts";
import type { McpToolInfo } from "../../../core/mcp.ts";
import type { OwnerAddition } from "../../../core/role-additions.ts";
import type { CallUsage } from "../../../core/usage.ts";
import type { Role, Runner } from "../../broker/index.ts";
import type { SessionLink } from "../live-session.ts";
import { PROVIDER_ERROR_KINDS, type ProviderErrorKind, TrialFailing } from "../provider-errors.ts";
import type { IdeaInput } from "../tools/index.ts";

/**
 * What a worker trial takes and gives: its spec from the scheduler, what it reaches the harness
 * through, and its result. The programs of their own (OpenCode, Claude Code, Codex) take and give
 * the same.
 */

export interface TrialSpec {
  trialId: string;
  /** The trial's own token: it binds API calls to this trial and stops working when it ends. */
  token?: string | undefined;
  run: string;
  lane: Role;
  /** The lane's workspace: a git repository at the parent commit, owned by the lane user. */
  workspace: string;
  /** The directory the lane owns for this trial (the workspace's parent); the disk cap's scope. */
  workspaceRoot?: string | undefined;
  parentCommit: string;
  /** The contract's editable paths (globs): only changes there are submitted. */
  editablePaths: string[];
  /**
   * The run's part of its prompt, as the scheduler gathered it from the ledger: the assignment
   * and its context, then the owner's messages, each section with its source (a text is one).
   */
  brief: string | readonly Section[];
  /**
   * Its whole prompt, as the harness rendered it from the worker's definition and recorded it
   * (goal 166); without it, the worker renders it from the brief.
   */
  sent?: Prompt | undefined;
  /** The trial's length: none unless the campaign or the rig sets one (goal 079). */
  wallMs?: number | undefined;
  /** A cap on the trial's turns: none unless configured (the owner's direction, 2026-10-15). */
  maxTurns?: number | undefined;
  /** The contract's lane limits (the server enforces them too). */
  limits?: LaneLimitValues | undefined;
  /**
   * The MCP servers the run's kit gives its workers (goal 068), by name: the trial reaches them
   * through the harness's gateway with its own token.
   */
  mcpServers?: string[] | undefined;
  /**
   * The kinds the worker may write in the knowledge base, as the run's contract lets a worker
   * (goal 175): it gets kb_search and kb_read, and kb_write when it may write one. Undefined: no
   * knowledge base tools.
   */
  kbWrites?: string[] | undefined;
  /** The owner's addition to the worker for the run's campaign (goal 166); none: no section. */
  addition?: OwnerAddition | undefined;
}

export const SubmitOutcome = z.object({
  attempt: z.string(),
  lifecycle: z.string(),
  violations: z.array(z.string()).optional(),
  duplicate_of: z.string().optional(),
});
export type SubmitOutcome = z.infer<typeof SubmitOutcome>;

export interface TrialDeps {
  runner: Runner;
  /** argv prefix that runs the lane tool (lanetool.ts or its build). */
  laneTool: string[];
  model: ModelConfig;
  submit(req: {
    run: string;
    lane: string;
    parent: string;
    patch_base64: string;
    hypothesis: string;
    claim?: string | undefined;
    known_flaws: string[];
  }): Promise<SubmitOutcome>;
  status(attempt: string): Promise<unknown>;
  devRun?(req: { lane: string; command: string; timeoutS?: number }): Promise<unknown>;
  /** An idea for the run's experiment queue: proposed by this lane, for the planner to take. */
  idea?(req: IdeaInput): Promise<{ experiment: string }>;
  /** A field note: written by this lane, in the run's journal. */
  note?(req: NoteRequest): Promise<{ note: number }>;
  /** The research service (sources, claims and notes in the run's folder): one operation. */
  research?(op: string, args: Record<string, unknown>): Promise<unknown>;
  /** The knowledge base's tools (goal 175), run by the harness for the trial's own slot. */
  kb?: KbCall | undefined;
  /** The live view: the session's turns out, the owner's messages in. */
  link?: SessionLink | undefined;
  /** The MCP tools the run's kit gives its workers, and how to call one (the harness's gateway). */
  mcp?: McpForAgent | undefined;
  /** Where a compaction keeps the conversation, and where it is said (goal 070). */
  compaction?: CompactionLink | undefined;
  /** Each model call's usage, as the trial's code measures it (goal 075). */
  modelUsage?: ((u: CallUsage) => void) | undefined;
  /** Told of each wait for the provider (a rate limit, a failed call) before it (goal 079). */
  waiting?: ((w: ProviderWait) => void) | undefined;
  /**
   * Keeps each later turn the trial sends its worker (goal 166): a nudge, a warning, a
   * continuation. The harness keeps the trial's first prompt itself.
   */
  sent?: ((p: Prompt) => void) | undefined;
  /** The trial's Pi view, when its worker draws one in its terminal (goal 169). */
  view?: TrialView | undefined;
}

/**
 * A trial's Pi view (goal 169; src/harness/agents/pi-view/): the trial hands it its levers once
 * its agent is built, and asks it, when the agent stops, whether the owner interrupted it.
 */
export interface TrialView {
  attach(levers: TrialLevers): void;
  /** Whether the agent's reply stopped because the owner interrupted it: asked once per stop. */
  interrupted(): boolean;
}

/** What the Pi view's console reaches in a running trial: each of its calls is one of these. */
export interface TrialLevers {
  agent: Agent;
  /** Compacts the conversation before the agent's next model call, as the owner asked. */
  compact(): void;
  /** The owner's words as the trial's role puts them to its agent: a later turn of the trial. */
  ownerTurn(text: string): Prompt;
  /** Keeps a later turn once it enters the conversation (goal 166). */
  sent?: ((p: Prompt) => void) | undefined;
  /** The trial's MCP tools now, with the servers that failed. */
  mcp(): McpForAgent | undefined;
  /** Gives the agent a new list of MCP tools, from its next turn. */
  setMcp(mcp: McpForAgent): void;
  /** The trial's counts so far. */
  status(): TrialStatus;
  /** Why the trial takes no more of the owner's words (it has submitted, or is ending). */
  closed(): string | undefined;
}

/** A trial's counts, as its Pi view shows them. */
export interface TrialStatus {
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

/** A trial waits for its provider and then goes on in the same conversation (goal 079). */
export interface ProviderWait {
  until: string;
  kind: ProviderErrorKind;
  /** The provider's words. */
  words: string;
}

/**
 * A trial's compactions through the harness (goal 070): the harness keeps each conversation in
 * the run's research folder, where the agent can read it, and records each compaction.
 */
export interface CompactionLink {
  /** Keeps the conversation before compaction `n`: its path on disk and in the run's folder. */
  keep(n: number, markdown: string): Promise<{ path: string; rel: string }>;
  /** Records the compaction: the event, and the live view's lines with the summary. */
  done(r: CompactionReport): Promise<unknown>;
}

/** An agent's MCP tools in Pi: what the gateway listed for it, and a call through the gateway. */
export interface McpForAgent {
  tools: McpToolInfo[];
  /** The servers whose tools could not be listed, and why. */
  unavailable?: { server: string; why: string }[] | undefined;
  call(server: string, tool: string, args: Record<string, unknown>): Promise<McpCallResult>;
}

/** How a trial stopped. */
export const TRIAL_STOPS = [
  "submitted",
  "no_submission",
  "finished",
  "interrupted",
  "turns",
  "wall",
  "context",
  "error",
] as const;

/** A count a trial reports: a whole number from 0. */
const count = z.number().int().min(0);

/**
 * A trial's result. A worker process (worker-main.ts) runs as the lane's agent user and prints it
 * as its last line: the harness reads it with this schema, and refuses anything else.
 */
export const TrialResult = z.object({
  submitted: SubmitOutcome.optional(),
  stopped: z.enum(TRIAL_STOPS),
  turns: count,
  toolCalls: count,
  tokensIn: count,
  tokensOut: count,
  /** How many times the trial's conversation was compacted (goal 070). */
  compactions: count.optional(),
  /** Model calls whose usage the worker could not hand to the harness (goal 075). */
  usageUnrecorded: count.optional(),
  error: z.string().optional(),
  /**
   * The kind of the provider's error a trial ended on (goal 079): no credits, a refused key or an
   * unserved model stop the run's agents until a model check passes.
   */
  errorKind: z.enum(PROVIDER_ERROR_KINDS).optional(),
  /** The model's provider refused for now (a subscription's full usage window): not before this (ISO). */
  retryAfter: z.string().optional(),
  /**
   * The trial ended while its model calls were failing with the provider's passing faults or the
   * model's own errors, with no call that worked since (goal 079): since when, and the newest
   * failure. Once that has lasted 30 minutes, in this trial or across the run's trials, the
   * scheduler stops the run's agents as for no credits.
   */
  failing: TrialFailing.optional(),
});
export type TrialResult = z.infer<typeof TrialResult>;
