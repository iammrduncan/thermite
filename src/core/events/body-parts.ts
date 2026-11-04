import type { Harness } from "../agents.ts";
import type { KbItemFile } from "../kb/index.ts";

/** The parts of some events' bodies (bodies.ts), each named once. */

/** A job put back in the queue, or blocked after too many expiries. */
export interface JobRequeued {
  fence: number;
  expiries: number;
  state: string;
}

/** A guard in a verdict's event (goal 184). */
export interface VerdictGuard {
  metric: string;
  status: string;
  change: number | null;
  low: number | null;
  high: number | null;
  values?: unknown;
  vs_start?: { change: number | null; spent: boolean } | undefined;
}

/** A champion from another rig, judged here. */
export interface PropagationJudged {
  attempt: string;
  source_rig: unknown;
  source_run: unknown;
  source_seq: unknown;
  tree: unknown;
  verdict: string;
}

export interface ConclusionDecided {
  proposal: number;
  kind: string;
}

export type QueuePosition = number | "end" | "top";
export type McpAgents = "advisors" | "planner" | "workers";

/** The agents' model route, as the harness took it. */
export interface ModelRouteInfo {
  source: "control" | "environment" | "none";
  name?: string | undefined;
  version?: number | undefined;
  revision?: string | undefined;
  harness?: Harness | undefined;
  model?: string | undefined;
  base_url?: string | undefined;
  key_hint?: string | undefined;
}

/** A research run's digest, or its final report. */
export interface ResearchReport {
  sources: number;
  domains: number;
  verified: number;
  corroborated: number;
  drafts: number;
  hypotheses: number;
  findings: number;
  draft_findings: number;
  questions: { question: string; verified: number }[];
  last_hour: { sources: number; verified: number; questions_covered: number };
  elapsed_ms: number;
  min_ms: number;
  max_ms: number | null;
  min_verified_claims: number | null;
  paper?: boolean | undefined;
  no_paper?: string | undefined;
  unsupported_numbers: number;
  /** The report cut to 60,000 characters (cutSaid); the knowledge base gets it whole as `file`. */
  report: string;
  /** The report whole, as the knowledge base keeps its item's file (goal 175). */
  file?: KbItemFile | undefined;
}
