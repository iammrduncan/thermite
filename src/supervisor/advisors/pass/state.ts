import type { McpGateway } from "../../../agents/mcp/index.ts";
import type { LiveKind } from "../../../core/live.ts";
import type { McpUse } from "../../../core/mcp.ts";
import type { KbControl } from "../../kb/index.ts";
import type { RunningAdvisors } from "../config.ts";
import type { AdvisorTerminals } from "../terminal/index.ts";

export interface AdviseConfig {
  harnessUrl: string;
  harnessToken: string;
  home: string;
  advisors: RunningAdvisors;
  fetchImpl?: typeof fetch | undefined;
  /** Retry spacing for an audit or review whose advisor failed. */
  retryMs?: number | undefined;
  /** A line in the live view (the supervisor's own lines, relayed unsigned). */
  live?: ((line: { kind: LiveKind; text: string; run?: string | undefined }) => void) | undefined;
  /**
   * The advisors' MCP servers (goal 068): the supervisor's gateway, holding the servers control
   * gave the rig for advisors, and each run's servers as its kit names them (read each round).
   */
  mcp?: { gateway: McpGateway; uses: Map<string, McpUse[]> } | undefined;
  /**
   * The deployment's STE checker for the final writer's papers (goal 112): THERMITE_STE_CHECKER,
   * a script run with Node. None: the papers are not checked for style, and say so.
   */
  steChecker?: string | undefined;
  /**
   * Where the advisors' kb_search and kb_read ask control (goal 175): the bus, or control's HTTP
   * API. None: the advisors get no knowledge base tools.
   */
  kb?: KbControl | undefined;
  /**
   * On a rig whose agents run in their own terminal (goal 169): what the teachers', the auditor's
   * and the reviewers' calls take there. None: they run headless.
   */
  terminals?: AdvisorTerminals | undefined;
}

export interface AdviseState {
  lastTeacherAt: Record<string, string>;
  tried: Record<string, string>;
  tries: Record<string, number>;
  spend?: { day: string; usd: number } | undefined;
  /** Per run, the newest owner's message to the teachers that already started a round. */
  ownerSeen?: Record<string, number> | undefined;
  /** Per run, the newest owner's message already told it waits for the spending limit. */
  limitSaid?: Record<string, number> | undefined;
  /** Runs already told their advisors get no MCP server because they may fetch any page. */
  mcpOffSaid?: Record<string, boolean> | undefined;
  /**
   * Per run, the newest time its queue fell below its target (the harness's queue_low event)
   * that already started a teachers' round (goal 081).
   */
  ideasSeen?: Record<string, number> | undefined;
  /** Runs already told their teachers read no code because they may fetch any page. */
  codeOffSaid?: Record<string, boolean> | undefined;
  /** Runs already told their teachers read none of the run's research: they may fetch any page. */
  researchOffSaid?: Record<string, boolean> | undefined;
  /**
   * Each open audit's last error, by its retry key (goal 079): the words its hand-off to the
   * owner gives once its tries are spent.
   */
  auditErrors?: Record<string, string> | undefined;
  stats: {
    teacher_runs: number;
    directive_sets: number;
    directives: number;
    audits: number;
    reviews: number;
    /** Research papers the harness accepted from the final writer (goal 112). */
    papers?: number | undefined;
    /** Answer cards the harness kept from the synthesizer (goal 117). */
    cards?: number | undefined;
    errors: number;
    tokens_in: number;
    tokens_out: number;
    usd: number;
    last_error?: string | undefined;
  };
}

/**
 * An audit is tried at most this often before it is left to the owner; a review's try from this
 * one on posts it, each reviewer that gave no answer failing it.
 */
export const MAX_TRIES = 5;

export function emptyAdviseState(): AdviseState {
  return {
    lastTeacherAt: {},
    tried: {},
    tries: {},
    stats: {
      teacher_runs: 0,
      directive_sets: 0,
      directives: 0,
      audits: 0,
      reviews: 0,
      papers: 0,
      cards: 0,
      errors: 0,
      tokens_in: 0,
      tokens_out: 0,
      usd: 0,
    },
  };
}
