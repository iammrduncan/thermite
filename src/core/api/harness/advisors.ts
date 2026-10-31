import { z } from "zod";
import { ADVISOR_ROLES } from "../../agents.ts";
import { ExperimentText, QueuePosition } from "../../commands.ts";
import { AgentsContext } from "../../compaction.ts";
import { AttemptId, ExperimentId, RunId } from "../../ids.ts";
import { McpUse } from "../../mcp.ts";
import { AdvisorAgent, CallUsage, UsageHarness } from "../../usage.ts";
import type { Route } from "../route.ts";
import {
  CardSubmission,
  KIND_PATHS,
  PAGE_MAX,
  PAPER_EXPERIMENTS_MAX,
  PAPER_MAX,
  PaperExperiment,
  PaperSubmission,
  type ResearchKind,
  ResearchVerdicts,
  SEARCH_MAX,
  SEARCH_QUERY_MAX,
  SOURCE_CHARS_MAX,
} from "./research.ts";

/**
 * The harness's API for its supervisor's advisors (src/harness/api/ answers it): the runs and
 * their briefs, the run's code, evidence and research to read, the audits, reviews, cards and
 * papers that wait for an advisor, and where the advisors' answers go. None of these can set a
 * verdict, a contract or a champion. Every route takes the supervisor's token. A run or an attempt
 * the harness names is a run's or an attempt's ID: the supervisor names its records' files by them.
 */

/** An owner's message as an advisor's brief or package gives it. */
const OwnerMessage = z.looseObject({
  id: z.number(),
  text: z.string(),
  /** In the teachers' brief: read in an earlier round (a standing wish, not to answer again). */
  read: z.boolean().optional(),
});
const OwnerMessages = z.array(OwnerMessage).optional();

/**
 * A run as the harness lists it for the advisors: the owner's messages each role has not read, the
 * MCP servers its kit names, the campaign's own context settings and the owner's additions to its
 * roles, and whether the planner's round left its queue below its target (goal 081).
 */
export const RunRow = z.looseObject({
  id: RunId,
  campaign: z.string(),
  mode: z.string(),
  status: z.string(),
  owner_messages_waiting: z.partialRecord(z.enum(ADVISOR_ROLES), z.array(z.number())).optional(),
  mcp_servers: z.array(McpUse).optional(),
  agents_context: AgentsContext.nullable().optional(),
  /**
   * The owner's additions to the roles for the run's campaign (goal 166), by role id, with the
   * version of the contract they are in; null: none. Read loosely: a role this build does not
   * know is never asked for.
   */
  role_additions: z
    .object({ version: z.number(), roles: z.record(z.string(), z.string()) })
    .nullable()
    .optional(),
  queue_low: z
    .looseObject({
      event: z.number(),
      at: z.string(),
      round: z.number(),
      ready: z.number(),
      target: z.number(),
    })
    .nullable()
    .optional(),
});
export type RunRow = z.infer<typeof RunRow>;

export const RUNS = {
  method: "GET",
  path: "/v1/runs",
  answer: z.looseObject({ runs: z.array(RunRow) }),
} as const satisfies Route;

/**
 * A run's brief, the teachers' input: what the supervisor reads of it (the daily report its
 * figures, the advisors what they withhold or pass on); the rest goes to the teachers as it came.
 */
export const RunBrief = z.looseObject({
  champion: z.looseObject({ seq: z.number() }),
  families: z.array(
    z.looseObject({
      id: z.string(),
      status: z.string(),
      attempts: z.number(),
      best_delta: z.number().nullable(),
    }),
  ),
  evidence: z.array(z.looseObject({ verdict: z.string().nullable(), lifecycle: z.string() })),
  epochs: z.array(z.looseObject({ n: z.number(), planner_valid: z.boolean() })),
  directives: z.array(z.unknown()),
  goals: z.array(z.looseObject({ id: z.string(), status: z.string() })).optional(),
  budget: z.looseObject({
    device_hours_used: z.number(),
    tokens: z.looseObject({ in: z.number(), out: z.number() }),
  }),
  owner_messages: OwnerMessages,
  background: z.unknown().optional(),
  past_research: z.unknown().optional(),
  /** What the run's own research holds (goal 098): its tools read the rest. */
  research: z.unknown().optional(),
});

export const BRIEF = {
  method: "GET",
  path: "/v1/brief",
  answer: RunBrief,
} as const satisfies Route;

/** The teachers' rules for the planner; rules naming a direction the run lacks are left out. */
export const DIRECTIVES = {
  method: "POST",
  path: "/v1/directives",
  body: z.object({ run: z.string().min(1), directives: z.unknown() }),
  answer: z.looseObject({
    left_out: z.array(z.looseObject({ rule: z.string(), why: z.string() })).optional(),
  }),
  /** Up to 20 rules, each with its rationale and citations. */
  maxBytes: 1024 * 1024,
} as const satisfies Route;

/** The longest path of a file a teacher reads, and the most lines of one read. */
export const READ_PATH_MAX = 500;
export const READ_LINES_MAX = 100_000;
/** An attempt's id, as a read names it. */
const AttemptRef = z.string().min(1).max(64);
/** A read the teachers make: its answer goes to the teacher as it came. */
export interface Read extends Route {
  method: "GET";
  answer: z.ZodUnknown;
}

/** A query's whole number from `min`: none when it is not given. */
const from = (min: number) => z.number().int().min(min);

/** A file's lines, from `offset` (1 first), at most `limit` of them. */
export const LinesQuery = z.object({
  path: z.string().min(1).max(READ_PATH_MAX),
  offset: from(1).optional(),
  limit: from(1).max(READ_LINES_MAX).optional(),
});

/**
 * The teachers' reads of a run's code and evidence (goal 081), each by its `run`: the champion's
 * tree, one of its files by lines, an attempt's diff in parts, and the judge's public findings.
 * Each answer goes to the teacher as it came.
 */
export const CODE_FILES = {
  method: "GET",
  path: "/v1/code/files",
  answer: z.unknown(),
} as const satisfies Route;
export const CODE_FILE = {
  method: "GET",
  path: "/v1/code/file",
  answer: z.unknown(),
} as const satisfies Route;
export const DiffQuery = z.object({
  attempt: AttemptRef,
  offset: from(0).optional(),
});
export const CODE_DIFF = {
  method: "GET",
  path: "/v1/code/diff",
  answer: z.unknown(),
} as const satisfies Route;
export const EvidenceQuery = AttemptRef.optional();
export const EVIDENCE = {
  method: "GET",
  path: "/v1/evidence",
  answer: z.unknown(),
} as const satisfies Route;

/**
 * The teachers' reads of a run's own research (goal 098), each by its `run`: each kind a page at a
 * time, one source's archived text in parts, one file of its research folder by lines, and a
 * search of all of it. Each answer goes to the teacher as it came.
 */
export const PageQuery = z.object({
  offset: from(0).optional(),
  limit: from(1).max(PAGE_MAX).optional(),
  question: from(0).max(1000).optional(),
  state: z.string().min(1).max(20).optional(),
});
/** One kind's list of a run's research. */
export function researchList(kind: ResearchKind) {
  return {
    method: "GET",
    path: `/v1/research/${KIND_PATHS[kind]}`,
    answer: z.unknown(),
  } as const satisfies Route;
}
export const SourceQuery = z.object({
  source: z.string().min(1).max(100),
  offset: from(0).optional(),
  limit: from(1).max(SOURCE_CHARS_MAX).optional(),
});
export const RESEARCH_SOURCE = {
  method: "GET",
  path: "/v1/research/source",
  answer: z.unknown(),
} as const satisfies Route;
export const RESEARCH_FILE = {
  method: "GET",
  path: "/v1/research/file",
  answer: z.unknown(),
} as const satisfies Route;
/** A search: its words, the kinds it keeps (a list with commas), and how many hits. */
export const SearchQuery = z.object({
  q: z.string().max(SEARCH_QUERY_MAX).default(""),
  kinds: z.string().max(200).optional(),
  limit: from(1).max(SEARCH_MAX).optional(),
});
export const RESEARCH_SEARCH = {
  method: "GET",
  path: "/v1/research/search",
  answer: z.unknown(),
} as const satisfies Route;

/** An audit that waits for the auditor: its own id, the attempt, and the owner's messages. */
const AuditPackage = z.looseObject({
  id: z.number().optional(),
  attempt: AttemptId,
  run: RunId.optional(),
  owner_messages: OwnerMessages,
  past_research: z.string().optional(),
});
export const AUDITS_PENDING = {
  method: "GET",
  path: "/v1/audits/pending",
  answer: z.looseObject({ audits: z.array(AuditPackage) }),
} as const satisfies Route;

/** The longest reasons of an audit or a reviewer, and an audit's citations. */
export const REASONS_MAX = 8000;
export const CITATIONS_MAX = 20;
export const CITATION_MAX = 500;
/** The longest name of an advisor, as its answers record it. */
export const ADVISOR_NAME_MAX = 100;

/** The auditor's decision on an attempt. An audit can block, never pass. */
export const AUDITS = {
  method: "POST",
  path: "/v1/audits",
  body: z.strictObject({
    attempt: z.string().min(1).max(64),
    decision: z.enum(["clear", "block", "needs_owner"]),
    reasons: z.string().min(1).max(REASONS_MAX),
    citations: z.array(z.string().min(1).max(CITATION_MAX)).max(CITATIONS_MAX).default([]),
    auditor: z.string().min(1).max(ADVISOR_NAME_MAX),
  }),
  answer: z.looseObject({ effect: z.string().optional() }),
  maxBytes: 256 * 1024,
} as const satisfies Route;

/** A review that waits for the review panel: a goal's, or a research run's (goal 112). */
const ReviewPackage = z.looseObject({
  id: z.number(),
  run: RunId.optional(),
  goal: z.string().optional(),
  kind: z.string().optional(),
  owner_messages: OwnerMessages,
  past_research: z.string().optional(),
});
/** The kinds of review a supervisor asks for (`?kinds=goal,research`); none named: goal only. */
export const REVIEW_KINDS = ["goal", "research"] as const;
export const REVIEWS_PENDING = {
  method: "GET",
  path: "/v1/reviews/pending",
  answer: z.looseObject({ reviews: z.array(ReviewPackage) }),
} as const satisfies Route;

/** The longest words of a review's failed try. */
export const TRY_ERROR_MAX = 4000;
/** A try of a review that the supervisor could not post (goal 116): kept with the review. */
export const REVIEW_TRIES = {
  method: "POST",
  path: "/v1/reviews/:id/tries",
  body: z.strictObject({
    try: z.number().int().min(1).max(1000),
    error: z.string().min(1).max(TRY_ERROR_MAX),
  }),
  answer: z.unknown(),
  maxBytes: 16 * 1024,
} as const satisfies Route;

/** The most reviewers whose answers one review takes. */
export const REVIEWERS_MAX = 8;
/** The review panel's answers: every reviewer's, blind to the others. */
export const REVIEW = {
  method: "POST",
  path: "/v1/reviews/:id",
  body: z.strictObject({
    results: z
      .array(
        z.strictObject({
          reviewer: z.string().min(1).max(ADVISOR_NAME_MAX),
          pass: z.boolean(),
          reasons: z.string().min(1).max(REASONS_MAX),
          research: ResearchVerdicts.optional(),
        }),
      )
      .min(1)
      .max(REVIEWERS_MAX),
  }),
  answer: z.looseObject({ result: z.string().optional(), accepted: z.boolean().optional() }),
  maxBytes: 4 * 1024 * 1024,
} as const satisfies Route;

/** For each running research run, the questions whose evidence changed since their card. */
export const CARDS_PENDING = {
  method: "GET",
  path: "/v1/research/cards/pending",
  answer: z.looseObject({
    runs: z.array(
      z.looseObject({
        run: RunId,
        questions: z
          .array(z.looseObject({ index: z.number(), through: z.string().nullable().optional() }))
          .optional(),
      }),
    ),
  }),
} as const satisfies Route;

/** The synthesizer's cards for a run: each kept as its question's next version, or refused. */
export const CARDS = {
  method: "POST",
  path: "/v1/research/cards/:run",
  body: CardSubmission,
  answer: z.looseObject({
    results: z.array(
      z.union([
        z.looseObject({ question: z.number(), accepted: z.literal(true), version: z.number() }),
        z.looseObject({
          question: z.number(),
          accepted: z.literal(false),
          problems: z.array(z.string()),
        }),
      ]),
    ),
  }),
  maxBytes: 2 * 1024 * 1024,
} as const satisfies Route;

/** The research runs that wait for their paper (goal 112), each as the final writer's package. */
export const PAPERS_PENDING = {
  method: "GET",
  path: "/v1/research/papers/pending",
  answer: z.looseObject({
    papers: z.array(z.looseObject({ run: RunId, review: z.number() })),
  }),
} as const satisfies Route;

/** A paper's problems, each at its line (null: the whole paper). */
const PaperProblems = z.array(z.looseObject({ line: z.number().nullable(), problem: z.string() }));

/** A draft checked by the harness's code, for the final writer's check_paper tool. */
export const PAPER_CHECK = {
  method: "POST",
  path: "/v1/research/papers/:run/check",
  body: z.strictObject({
    paper: z.string().min(1).max(PAPER_MAX),
    // The next experiments beside it, when the writer has them (goal 119): checked too.
    experiments: z.array(PaperExperiment).max(PAPER_EXPERIMENTS_MAX).optional(),
  }),
  answer: z.looseObject({ ok: z.boolean(), problems: PaperProblems }),
  maxBytes: 1024 * 1024,
} as const satisfies Route;

/** The final writer's paper, with the STE checker's result: accepted, or refused with problems. */
export const PAPER = {
  method: "POST",
  path: "/v1/research/papers/:run",
  body: PaperSubmission,
  answer: z.looseObject({
    accepted: z.boolean(),
    cited: z.number().optional(),
    experiments: z.array(z.string()).optional(),
    problems: PaperProblems.optional(),
  }),
  maxBytes: 2 * 1024 * 1024,
} as const satisfies Route;

/** The most messages an advisor role's receipts name, and the longest answer to one. */
export const RECEIPTS_MAX = 100;
export const ANSWER_TEXT_MAX = 2000;

/** Which of the owner's messages an advisor role was given, and what it answered. */
export const ADVISOR_MESSAGES = {
  method: "POST",
  path: "/v1/advisor-messages",
  body: z.strictObject({
    run: z.string().min(1).max(100),
    role: z.enum(ADVISOR_ROLES),
    read: z.array(z.number().int().positive()).max(RECEIPTS_MAX).default([]),
    answers: z
      .array(
        z.strictObject({
          message: z.number().int().positive(),
          text: z.string().min(1).max(ANSWER_TEXT_MAX),
          advisor: z.string().min(1).max(ADVISOR_NAME_MAX).optional(),
        }),
      )
      .max(RECEIPTS_MAX)
      .default([]),
  }),
  answer: z.unknown(),
  maxBytes: 256 * 1024,
} as const satisfies Route;

/** The most experiments one request adds to a run's queue, and the most it moves. */
export const QUEUE_PART_MAX = 20;

/** An advisor's additions and moves for a run's queue, recorded with its role as who made them. */
export const AdvisorQueueRequest = z.strictObject({
  run: z.string().min(1).max(100),
  /** The advisor role that proposes them: it is recorded as who added or moved each one. */
  role: z.enum(["teacher", "auditor"]),
  add: z
    .array(
      z.strictObject({
        title: ExperimentText.title,
        details: ExperimentText.details.optional(),
        family: ExperimentText.family.optional(),
        why: z.string().trim().min(1).max(2000),
        position: QueuePosition.optional(),
        /** A research run's task: the question it is about, an index from 0 (goal 117). */
        question: z.number().int().min(0).optional(),
      }),
    )
    .max(QUEUE_PART_MAX)
    .default([]),
  move: z
    .array(
      z.strictObject({
        id: ExperimentId,
        position: QueuePosition,
        why: z.string().trim().min(1).max(2000),
      }),
    )
    .max(QUEUE_PART_MAX)
    .default([]),
});
export type AdvisorQueueRequest = z.infer<typeof AdvisorQueueRequest>;
/** What an advisor adds to a run's queue, and moves in it, as the supervisor sends them. */
export type QueueAdd = NonNullable<z.input<typeof AdvisorQueueRequest>["add"]>[number];
export type QueueMove = NonNullable<z.input<typeof AdvisorQueueRequest>["move"]>[number];

export const QUEUE = {
  method: "POST",
  path: "/v1/queue",
  body: AdvisorQueueRequest,
  answer: z.looseObject({
    added: z.array(z.string()),
    moved: z.array(z.string()),
    refused: z.array(z.string()),
  }),
  maxBytes: 256 * 1024,
} as const satisfies Route;

/** An advisor's field notes, each checked on its own: recorded, or refused with its problem. */
export const JOURNAL = {
  method: "POST",
  path: "/v1/journal",
  body: z.strictObject({
    run: z.string().min(1).max(100),
    role: z.enum(ADVISOR_ROLES),
    by: z.string().trim().min(1).max(ADVISOR_NAME_MAX),
    notes: z.array(z.unknown()),
  }),
  answer: z.looseObject({ recorded: z.array(z.number()), problems: z.array(z.string()) }),
  maxBytes: 2 * 1024 * 1024,
} as const satisfies Route;

/** The most model calls one request records. */
export const MODEL_CALLS_MAX = 500;

/** An advisor's model usage in a run (goal 075), as the supervisor's code measured it. */
export const MODEL_CALLS = {
  method: "POST",
  path: "/v1/model-calls",
  body: z.strictObject({
    run: z.string().min(1).max(100),
    round: z.string().min(1).max(200).nullable(),
    agent: AdvisorAgent,
    harness: UsageHarness,
    provider: z.string().min(1).max(100).nullable(),
    model: z.string().min(1).max(200),
    calls: z.array(CallUsage).min(1).max(MODEL_CALLS_MAX),
  }),
  answer: z.unknown(),
  maxBytes: 1024 * 1024,
} as const satisfies Route;
