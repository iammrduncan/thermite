import type { TSchema } from "@earendil-works/pi-ai";
import type { z } from "zod";
import type { KeptAt } from "../../agents/compaction/index.ts";
import type { Prompt } from "../../agents/prompt.ts";
import type { AdvisorFrame } from "../../agents/roles/index.ts";
import type { McpCallResult } from "../../common/mcp-client.ts";
import type { McpToolInfo } from "../../core/mcp.ts";
import type { CallUsage, UsageRoute } from "../../core/usage.ts";
import type { AdvisorRuntime } from "./config.ts";
import type {
  AdvisorCode,
  AdvisorKb,
  AdvisorPaper,
  AdvisorResearch,
  AdvisorServers,
} from "./tools/index.ts";

/**
 * One advisor call (runAdvisor): a role prompt, the tools, and an output schema; the model answers
 * with an object that must match the schema.
 */
export interface AdvisorCall<S extends z.ZodType> {
  runtime: AdvisorRuntime;
  /**
   * The role's prompt (goal 166), rendered by its definition (src/agents/roles/) for the program
   * the call runs in: its runtime gives the frame.
   */
  prompt(f: AdvisorFrame): Prompt;
  /**
   * Keeps a later turn the call sent inside it (goal 166): in Pi, the message the advisor goes on
   * from after a compaction. runAdvisor sets it.
   */
  later?: ((p: Prompt) => void) | undefined;
  schema: S;
  answerSchema: TSchema;
  tools?: AdvisorTools | undefined;
  /** Where the conversation is kept before each compaction (goal 070); none: not kept. */
  keeper?: AdvisorKeeper | undefined;
  /**
   * In Pi, a check of an answer that fits the schema: its problems in words, and the advisor is
   * asked to answer again within the same call; undefined: the answer is taken (goal 112's final
   * writer revises its paper this way). The other runtimes answer once.
   */
  accept?: ((output: z.infer<S>) => Promise<string | undefined>) | undefined;
}

export interface AdvisorResult<T> {
  output: T | undefined;
  error?: string | undefined;
  tokensIn: number;
  tokensOut: number;
  usd: number;
  /** The call's compactions (goal 070), as the supervisor records them with the round. */
  compactions?: AdvisorCompaction[] | undefined;
  /** The call's model usage (goal 075); none for a command-line agent or a call that never ran. */
  usage?: AdvisorUsage | undefined;
  /**
   * The prompts the call sent, as its role rendered them (goal 166), for the harness to keep: its
   * first message, then its later turns.
   */
  sent?: Prompt[] | undefined;
}

/** An advisor call's model usage (goal 075): where it ran, and each record. */
export interface AdvisorUsage extends UsageRoute {
  calls: CallUsage[];
}

/** One compaction of an advisor's call (goal 070): Pi's, or the advisor's own program's. */
export interface AdvisorCompaction {
  advisor: string;
  number: number;
  /** The conversation before and after, in tokens (Pi's estimates); null when not said. */
  tokens_before: number | null;
  tokens_after: number | null;
  /**
   * summary: Pi's model summarized it; trimmed: Pi's summary failed, old tool results were cut;
   * harness: the advisor's own program (Claude Code, Codex, OpenCode) compacted it.
   */
  how: "summary" | "trimmed" | "harness";
  /** The program that compacted it, when it was not Pi. */
  harness?: "claude-code" | "codex" | "opencode" | undefined;
  /** Where the conversation before it is kept, in words; null: it could not be kept. */
  kept: string | null;
  /** The summary the program went on from, when the supervisor could read it. */
  summary?: string | undefined;
  error?: string | undefined;
}

/**
 * Where an advisor's conversation is kept before each compaction of its call (goal 070), and who
 * hears of each one. The supervisor keeps it with its records of the advisors' rounds, never
 * where the run's agents read: an advisor's conversation may hold what an outside knowledge base
 * or a fetched page said, which the workers must not read.
 */
export interface AdvisorKeeper {
  /** Keeps the conversation before compaction `n` of call `call`; returns where, in words. */
  keep(advisor: string, call: string, n: number, markdown: string): string;
  /**
   * Where the conversation before each compaction of call `call` will be kept, in words, for the
   * summary of the advisor's own program (Claude Code, Codex, OpenCode) to name it.
   */
  at?(advisor: string, call: string): KeptAt;
  /** A compaction is done (a line in the run's live view). */
  done?(c: AdvisorCompaction): void;
}

/** Tools an advisor may use: read only, no shell, no files. */
export interface AdvisorTools {
  brief?: () => Promise<unknown>;
  fetchUrl?: (url: string) => Promise<unknown>;
  kbSearch?: (query: string) => Promise<unknown>;
  /**
   * Thermite's knowledge base (goal 175): kb_search and kb_read, asked of control, and kb_write
   * when the run's campaign lets the advisor's role write. Pi gets them as tools; Claude Code,
   * OpenCode and Codex over MCP on localhost; a command-line agent, not at all.
   */
  kb?: AdvisorKb | undefined;
  /**
   * The MCP servers the run's kit gives its advisors (goal 068), called by the supervisor, which
   * holds their sign-in: in Pi a tool for each MCP tool; in Claude Code each server on localhost
   * for the call; a command-line agent gets none.
   */
  mcp?: AdvisorMcp | undefined;
  /**
   * The run's code and evidence, read only (goal 081): the champion's tree, an attempt's diff
   * and the judge's public findings, through the harness. The teachers get them, unless they may
   * fetch any web page; in Claude Code, OpenCode and Codex they are served on localhost with the
   * past-research search.
   */
  code?: AdvisorCode | undefined;
  /**
   * The run's own research, read only (goal 098): its sources, claims, hypotheses, findings,
   * notes and files, through the harness. The teachers get them when the run's brief has
   * `research`, unless they may fetch any web page; served on localhost as the code tools are.
   */
  research?: AdvisorResearch | undefined;
  /**
   * The final writer's checks of its research paper (goal 112): the harness's code checks of a
   * draft, and the rig's STE checker. Served on localhost as the research tools are.
   */
  paper?: AdvisorPaper | undefined;
}

/** An advisor's MCP servers: the tools it may call, a call, and each server as an MCP server. */
export interface AdvisorMcp extends AdvisorServers {
  tools: McpToolInfo[];
  call(server: string, tool: string, args: Record<string, unknown>): Promise<McpCallResult>;
}
