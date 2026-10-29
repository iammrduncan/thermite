import { z } from "zod";
import { canonicalSha } from "./canonical.ts";
import { AgentsContext } from "./compaction.ts";
import { DURATION_PATTERN, parseDuration } from "./duration.ts";
import { CampaignId, MAX_LANES, MAX_LANES_REASON } from "./ids.ts";
import { KbWrites } from "./kb.ts";
import { McpUses } from "./mcp.ts";
import { additionRefusals, RoleAdditions } from "./role-additions.ts";

export { MAX_LANES, MAX_LANES_REASON } from "./ids.ts";

/**
 * Campaign contract, schema version 1.
 *
 * A contract is frozen data: changing anything makes a new version. The `mode` field selects
 * one of three shapes (hill climb, goal, research); the shared fields come first.
 */

/** A campaign's (or a kit's, a case's) name; the dashboard's Copy panel checks names with it too. */
export const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const IdSchema = z.string().regex(ID_PATTERN, "lowercase id");
export const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, "sha256 hex");
/** A full commit id (SHA-1 or SHA-256). Abbreviations are refused: they can be ground. */
export const CommitSchema = z
  .string()
  .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/, "full git commit id (40 or 64 hex)");
export const DurationSchema = z.string().regex(DURATION_PATTERN, 'duration like "30m" or "8h"');
const MetricSchema = z.string().min(1);
const Direction = z.enum(["max", "min"]);
/** A regular expression that compiles; checked when the contract is validated, not at use. */
const RegexSchema = z
  .string()
  .min(1)
  .refine((p) => {
    try {
      new RegExp(p);
      return true;
    } catch {
      return false;
    }
  }, "invalid regular expression");

/**
 * A research campaign's web search policy. Thermite has no web search of its own (web search comes
 * from an MCP server the campaign names, goal 046), so nothing reads it: a contract may still carry
 * it, and keeps its hash, until a new contract version leaves it out.
 */
const SearchPolicy = z.strictObject({
  /** What public search may be used for, stated for agents and auditors. */
  allowed_purposes: z.array(z.string().min(1)).default([]),
  /** Regular expressions; matching queries are refused and logged. */
  blocked_patterns: z.array(RegexSchema).default([]),
});

/**
 * What a worker's lane may use. Optional and without schema defaults, so contracts written
 * before it keep their hash; laneLimits() fills the defaults.
 */
const LaneLimits = z.strictObject({
  /** One shell or lane-tool command (a build, a test). Unset: no limit (the trial's end). */
  run_timeout_s: z.number().int().min(10).max(7200).optional(),
  run_rss_mib: z.number().int().min(256).max(16_384).optional(),
  /** The trial's workspace, build trees included. */
  workspace_mib: z.number().int().min(256).max(65_536).optional(),
  /**
   * One development run on the measurement device. Unset: no limit on a dedicated development
   * card; on a card the judge shares, the rig's own (the judge needs the card back).
   */
  dev_run_timeout_s: z.number().int().min(10).max(3600).optional(),
  dev_run_rss_mib: z.number().int().min(256).max(16_384).optional(),
  /**
   * A worker's whole trial. Unset: the rig's own (Edit rig, THERMITE_TRIAL_MINUTES), which is none
   * unless someone set one (goal 079).
   */
  trial_minutes: z.number().int().min(1).max(1440).optional(),
  /**
   * A trial ends after this many failed model calls in a row (a provider's 5xx, a broken
   * connection, a request it refused). Unset: none; a rate limit's waits never count (goal 079).
   */
  failures_in_a_row: z.number().int().min(1).max(10_000).optional(),
  /** A trial ends after this many replies in a row cut off at the output limit. Unset: none. */
  cutoffs_in_a_row: z.number().int().min(1).max(10_000).optional(),
  /**
   * How many times a worker that stops without submitting is told to go on. Unset: no number; it
   * is told for as long as it keeps working, and a nudge it answers without any work ends the
   * trial (goal 079). 0: never.
   */
  nudges: z.number().int().min(0).max(10_000).optional(),
  /**
   * The field notes a Pi worker records from one model reply; past it, a note is refused in words
   * and the trial goes on. Unset: no limit (goal 147).
   */
  notes_per_turn: z.number().int().min(1).max(10_000).optional(),
  /**
   * Processes and threads each of a lane's users may have at once (RLIMIT_NPROC): its commands
   * and OpenCode or Claude Code, its development runs, and its Pi worker. Unset: 256.
   */
  processes: z.number().int().min(64).max(65_536).optional(),
});

/**
 * A folder inside a repository, such as examples/matmul-cpu/project: its path from the top,
 * separated by /. No part is empty or starts with a dot, so ".", "..", ".git" and absolute paths
 * are refused. A project in one folder of its repository uses that folder as its root.
 */
export const FolderSchema = z
  .string()
  .max(300)
  .regex(
    /^[A-Za-z0-9_@+-][A-Za-z0-9._@+-]*(?:\/[A-Za-z0-9_@+-][A-Za-z0-9._@+-]*)*$/,
    "a folder in the repository, such as examples/matmul-cpu/project: its path from the top, with no / at either end and no part that starts with a dot",
  );

const Common = {
  schema_version: z.literal(1),
  campaign: CampaignId,
  version: z.number().int().positive(),
  title: z.string().min(1),
  project: z.strictObject({
    repo: z.string().min(1),
    commit: CommitSchema.optional(),
    /**
     * The project's folder in its repository, when it is not the whole repository. The rig
     * fetches the repository's commit and the run starts from that folder. Optional and without a
     * default, so contracts written before it keep their hash.
     */
    folder: FolderSchema.optional(),
    kit: z.strictObject({ repo: z.string().min(1), commit: CommitSchema }).optional(),
  }),
  target: z.strictObject({ type: z.string().min(1), class: z.string().min(1) }).optional(),
  models: z.array(z.strictObject({ name: z.string().min(1), sha256: Sha256Schema })).default([]),
  lanes: z
    .strictObject({
      count: z.number().int().min(1).max(MAX_LANES, MAX_LANES_REASON),
      trials_per_epoch: z.number().int().min(1).default(3),
      /** Raised limits for heavy projects (see laneLimits for the defaults). */
      limits: LaneLimits.optional(),
      /**
       * The target queue depth (goal 081): queued experiments to keep ready for the lanes' next
       * trials. Below it, the planner is asked to top the queue up, and the teachers when it
       * can't. A target that drives ideas, never a cap; 0 asks for none. Unset: two for each
       * lane. Optional and without a default, so contracts written before it keep their hash.
       */
      queue_target: z.number().int().min(0).max(1000).optional(),
      /**
       * Keep working while the judge works (goal 135): a lane's next trial starts when its last
       * one ends, and a round ends when its trials end. Unset or false: they wait for the judge's
       * verdicts. A run's keep_working rule turns it on or off. Optional and without a default, so
       * contracts written before it keep their hash.
       */
      keep_working: z.boolean().optional(),
    })
    .default({ count: 2, trials_per_epoch: 3 }),
  budget: z
    .strictObject({
      wall_hours: z.number().positive().optional(),
      device_hours: z.number().positive().optional(),
      llm_usd: z.number().nonnegative().optional(),
      max_open_attempts: z.number().int().positive().default(4),
    })
    .default({ max_open_attempts: 4 }),
  min_duration: DurationSchema.optional(),
  max_duration: DurationSchema.optional(),
  search_policy: SearchPolicy.optional(),
  /**
   * The campaign's additional information, from its author (goal 078): background, links, what
   * was tried, limits and what good looks like, in Markdown, with no length limit. The planner,
   * the workers and the advisors get it as data to weigh, never as a rule (brief.ts).
   */
  notes: z.string().optional(),
  /**
   * What the campaign's author thinks is true, one entry each (goal 078): a starting point for the
   * agents to test, not a fact. A research run starts with them as its hypotheses. Optional and
   * without a default, so contracts written before it keep their hash.
   */
  hypotheses: z.array(z.string().min(1)).optional(),
  /**
   * The campaign's own context window and compaction point for all its runs' agents (goal 070):
   * each agent's window is the lower of this and its own model's, and this point replaces the
   * rig's. Optional and without a default, so contracts written before it keep their hash.
   */
  agents_context: AgentsContext.optional(),
  /**
   * The owner's additions to a role's instructions for this campaign (goal 166): one text for
   * each role, by its id, added to every prompt of that role and labelled as the owner's; the
   * role's own text stays whole. Optional and without a default, so contracts written before it
   * keep their hash.
   */
  role_additions: RoleAdditions.optional(),
  /**
   * Which kinds of item each role may write in its own slot of Thermite's knowledge base (goal
   * 175): planner, worker, teacher, merged-by, auditor, review-panel, synthesizer and
   * final-writer, each with its kinds. Left out: core/kb.ts's KB_WRITES_DEFAULT. Optional and
   * without a default, so contracts written before it keep their hash.
   */
  kb_writes: KbWrites.optional(),
};

const EditPolicy = {
  /** Globs of paths a candidate may change. Anything else is refused at V0. */
  editable_paths: z.array(z.string().min(1)).min(1),
  /** Regular expressions; an added line matching one is refused at V0. */
  forbidden_patterns: z.array(RegexSchema).default([]),
  /**
   * Ideas the campaign's author wants tried, one entry each (goal 078): the planner and the
   * workers get them as starting points, not rules. Optional and without a default, so contracts
   * written before it keep their hash.
   */
  ideas: z.array(z.string().min(1)).optional(),
  /**
   * Starting links from the campaign's author (goal 078): pages the agents get with the brief.
   * Nothing fetches them up front; a worker fetches one when it needs it. Optional and without a
   * default, so contracts written before it keep their hash. A research contract's are its seeds.
   */
  links: z.array(z.url()).optional(),
};

const Acceptance = z
  .strictObject({
    alpha_screen: z.number().gt(0).lt(1).default(0.1),
    alpha_confirm: z.number().gt(0).lt(1).default(0.05),
    equivalence_band: z.number().positive().default(0.005),
    looks: z.array(z.number().int().positive()).min(1).default([3, 6, 9]),
    confirm_blocks: z.number().int().positive().default(5),
    /**
     * Runs per arm and cell inside each block; the block uses their median. More than one makes
     * a single disturbed run (a noisy shared host) unable to swing a block.
     */
    runs_per_cell: z.number().int().min(1).max(9).default(1),
    audit: z
      .strictObject({
        ratio_to_median: z.number().positive().default(3),
        absolute: z.number().positive().default(0.15),
      })
      .default({ ratio_to_median: 3, absolute: 0.15 }),
  })
  .default({
    alpha_screen: 0.1,
    alpha_confirm: 0.05,
    equivalence_band: 0.005,
    looks: [3, 6, 9],
    confirm_blocks: 5,
    runs_per_cell: 1,
    audit: { ratio_to_median: 3, absolute: 0.15 },
  });

const Guard = z.strictObject({
  metric: MetricSchema,
  direction: Direction,
  /** Allowed regression per promotion step, as a fraction (0.01 = 1%). */
  max_step_regression: z.number().min(0),
  /** Allowed regression against the campaign baseline, as a fraction. */
  max_total_regression: z.number().min(0),
});

const HardConstraint = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("min"), metric: MetricSchema, value: z.number() }),
  z.strictObject({ kind: z.literal("max"), metric: MetricSchema, value: z.number() }),
  /** Refused by parseContract (goal 163); kept here so a contract stored before still reads. */
  z.strictObject({ kind: z.literal("check"), check: z.string().min(1) }),
]);

export const HillClimbContract = z.strictObject({
  ...Common,
  ...EditPolicy,
  mode: z.literal("hill_climb"),
  objective: z.strictObject({
    policy: z.enum(["single", "lexicographic"]).default("single"),
    primary: z.strictObject({
      metric: MetricSchema,
      direction: Direction,
      min_effect: z.number().positive(),
    }),
    secondary: z.array(z.strictObject({ metric: MetricSchema, direction: Direction })).default([]),
  }),
  guards: z.array(Guard).default([]),
  hard_constraints: z.array(HardConstraint).default([]),
  monitor_only: z.array(MetricSchema).default([]),
  cells: z.array(z.string().min(1)).min(1),
  held_out_cells: z.array(z.string().min(1)).default([]),
  acceptance: Acceptance,
});

const Verify = z.discriminatedUnion("type", [
  /** A verifier script in the project kit; agents see pass/fail and bounded diagnostics. */
  z.strictObject({ type: z.literal("code"), verifier: z.string().min(1) }),
  z.strictObject({
    type: z.literal("metric_threshold"),
    metric: MetricSchema,
    op: z.enum([">=", "<=", ">", "<"]),
    value: z.number(),
    cells: z.array(z.string().min(1)).optional(),
  }),
  /** Subjective goals: the review panel reviews them blind, the owner gives final acceptance. */
  z.strictObject({ type: z.literal("review"), criteria: z.array(z.string().min(1)).min(1) }),
]);

const GoalItem = z.strictObject({
  id: IdSchema,
  description: z.string().min(1),
  priority: z.number().int().min(1).default(1),
  required: z.boolean().default(true),
  parent: IdSchema.optional(),
  verify: Verify,
});

export const GoalContract = z
  .strictObject({
    ...Common,
    ...EditPolicy,
    mode: z.literal("goal"),
    goals: z.array(GoalItem).min(1),
    success: z
      .strictObject({
        policy: z.enum(["all_required", "k_of_n"]).default("all_required"),
        k: z.number().int().positive().optional(),
      })
      .default({ policy: "all_required" }),
    /** What a verified solution is (a commit, an artifact, a report). */
    deliverable: z.string().min(1),
    /** Outcomes that must never be reported as success (special cases, reductions, ...). */
    insufficient: z.array(z.string().min(1)).default([]),
    /** Failure modes every candidate is checked for by adversarial audit. */
    adversarial_checklist: z.array(z.string().min(1)).default([]),
    infeasibility: z
      .strictObject({
        allowed: z.boolean(),
        min_refuted_approaches: z.number().int().positive().optional(),
      })
      .default({ allowed: false }),
    /** Epochs during which lanes get no cross-lane evidence. */
    independence_epochs: z.number().int().min(0).default(2),
    /** Approach families that must stay alive at once. */
    min_live_families: z.number().int().min(1).default(2),
    /** Runs per cell when a metric threshold is checked; its interval needs several. */
    threshold_reps: z.number().int().min(2).max(20).default(5),
    held_out_cells: z.array(z.string().min(1)).default([]),
  })
  .superRefine((c, ctx) => {
    const ids = new Set<string>();
    for (const g of c.goals) {
      if (ids.has(g.id)) ctx.addIssue({ code: "custom", message: `duplicate goal id ${g.id}` });
      ids.add(g.id);
    }
    for (const g of c.goals) {
      if (g.parent && !ids.has(g.parent)) {
        ctx.addIssue({ code: "custom", message: `goal ${g.id} has unknown parent ${g.parent}` });
      }
    }
    if (c.success.policy === "all_required" && !c.goals.some((g) => g.required)) {
      ctx.addIssue({ code: "custom", message: "all_required needs at least one required goal" });
    }
    if (c.success.policy === "k_of_n") {
      if (c.success.k === undefined || c.success.k > c.goals.length) {
        ctx.addIssue({ code: "custom", message: "k_of_n needs 1 <= k <= number of goals" });
      }
    }
    if (c.infeasibility.allowed && c.infeasibility.min_refuted_approaches === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "infeasibility.allowed requires min_refuted_approaches",
      });
    }
  });

export const ResearchContract = z.strictObject({
  ...Common,
  mode: z.literal("research"),
  topic: z.string().min(1),
  questions: z.array(z.string().min(1)).min(1),
  /**
   * What an answer to each question must cover (goal 117), one entry per question, in order: the
   * reviewers judge a question's answer card against it. Optional and without a default, so
   * contracts written before it keep their hash; left out, a question's rubric is the question.
   */
  rubrics: z.array(z.string().min(1)).optional(),
  /**
   * Starting links: the harness fetches and archives them when the run starts (goal 078), and
   * every research worker's brief lists them. Without a search provider, research follows links
   * from these.
   */
  seeds: z.array(z.url()).default([]),
  /**
   * A floor of verified claims (goal 112): the run must have at least this many, in total, before
   * the review panel is first asked whether its questions are answered. It delays the check; it
   * never ends a run. Optional and without a default, so contracts written before it keep their
   * hash; left out, the check needs only a verified claim for each question.
   */
  min_verified_claims: z.number().int().min(1).optional(),
  /**
   * The MCP servers the campaign's agents use (goal 068), as a kit names them: a research
   * campaign has no kit. Optional and without a default, so contracts written before it keep
   * their hash.
   */
  mcp_servers: McpUses.optional(),
  scope: z
    .strictObject({
      include_domains: z.array(z.string()).default([]),
      exclude_domains: z.array(z.string()).default([]),
      source_types: z.array(z.string()).default([]),
      languages: z.array(z.string()).default([]),
    })
    .default({ include_domains: [], exclude_domains: [], source_types: [], languages: [] }),
  report_cadence: z
    .strictObject({
      digest_minutes: z.number().int().positive().default(60),
      report_hours: z.number().positive().default(24),
    })
    .default({ digest_minutes: 60, report_hours: 24 }),
  quality: z
    .strictObject({
      /** Claims count only when every quote is found verbatim in the archived source. */
      verbatim_quotes: z.literal(true).default(true),
      min_independent_sources: z.number().int().min(1).default(2),
    })
    .default({ verbatim_quotes: true, min_independent_sources: 2 }),
  fetch_policy: z
    .strictObject({
      respect_robots: z.boolean().default(true),
      per_domain_per_minute: z.number().int().positive().default(6),
      max_bytes: z.number().int().positive().default(5_000_000),
      allow_logins: z.literal(false).default(false),
    })
    .default({
      respect_robots: true,
      per_domain_per_minute: 6,
      max_bytes: 5_000_000,
      allow_logins: false,
    }),
});

export const ContractSchema = z
  .discriminatedUnion("mode", [HillClimbContract, GoalContract, ResearchContract])
  .superRefine((c, ctx) => {
    if (c.min_duration && c.max_duration) {
      if (parseDuration(c.max_duration) < parseDuration(c.min_duration)) {
        ctx.addIssue({ code: "custom", message: "max_duration is shorter than min_duration" });
      }
    }
    if (c.mode === "research" && !c.min_duration) {
      ctx.addIssue({ code: "custom", message: "research campaigns need min_duration" });
    }
    if (c.mode === "research" && c.rubrics && c.rubrics.length !== c.questions.length) {
      ctx.addIssue({
        code: "custom",
        message: `rubrics has ${c.rubrics.length} entries for ${c.questions.length} questions: give one for each question, in order`,
      });
    }
    for (const why of additionRefusals(c.mode, c.role_additions))
      ctx.addIssue({ code: "custom", path: ["role_additions"], message: why });
    if (c.mode === "hill_climb" && !c.target) {
      ctx.addIssue({ code: "custom", message: "hill_climb campaigns need a target" });
    }
    // A held-out cell runs only at confirmation: one in cells too would be measured at
    // screening, its figures in every verdict.
    if (c.mode === "hill_climb") {
      const measured = new Set(c.cells);
      const both = [...new Set(c.held_out_cells.filter((x) => measured.has(x)))];
      if (both.length)
        ctx.addIssue({
          code: "custom",
          path: ["held_out_cells"],
          message: `${both.join(", ")} ${both.length === 1 ? "is" : "are"} in both cells and held_out_cells: a held-out cell is measured only at confirmation, so it can't be one of cells`,
        });
    }
  });

export type Contract = z.infer<typeof ContractSchema>;
export type HillClimbContract = z.infer<typeof HillClimbContract>;
export type GoalContract = z.infer<typeof GoalContract>;
export type ResearchContract = z.infer<typeof ResearchContract>;
export type Mode = Contract["mode"];

export type ContractParse =
  | { ok: true; contract: Contract; sha: string }
  | { ok: false; errors: string[] };

/** Validates a contract and returns it with defaults applied and its content hash. */
export function parseContract(input: unknown): ContractParse {
  const r = ContractSchema.safeParse(input);
  if (!r.success) {
    return {
      ok: false,
      errors: r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    };
  }
  // A `check` hard constraint was accepted and never checked; it is refused (the owner,
  // 2026-10-27, goal 163). A contract stored before keeps it, and nothing reads it.
  const checks = ("hard_constraints" in r.data ? r.data.hard_constraints : []).flatMap((h, i) =>
    h.kind === "check" ? [i] : [],
  );
  if (checks.length)
    return {
      ok: false,
      errors: checks.map((i) => `hard_constraints.${i}: ${CHECK_CONSTRAINT_REFUSED}`),
    };
  return { ok: true, contract: r.data, sha: contractSha(r.data) };
}

/** Why a `check` hard constraint is refused, and what to use. */
export const CHECK_CONSTRAINT_REFUSED =
  "a `check` hard constraint is not supported: the kit's own checks run on every candidate anyway. Remove it, or bound a metric with `min` or `max`";

export interface LaneLimitValues {
  /** Unset: a lane command runs until it ends (no default time limit; owner, 2026-10-16). */
  runTimeoutS?: number | undefined;
  runRssMib: number;
  workspaceMib: number;
  /** Unset: see dev_run_timeout_s. */
  devRunTimeoutS?: number | undefined;
  devRunRssMib: number;
  trialMinutes?: number | undefined;
  /** RLIMIT_NPROC for each of the lane's users (lane, development and agent). */
  processes: number;
  /** Failed model calls in a row that end a trial; unset: none (goal 079). */
  failuresInARow?: number | undefined;
  /** Replies in a row cut off at the output limit that end a trial; unset: none (goal 079). */
  cutoffsInARow?: number | undefined;
  /** Nudges to a worker that stopped without submitting; unset: no number (goal 079). */
  nudges?: number | undefined;
  /** Field notes a Pi worker records from one model reply; unset: no limit (goal 147). */
  notesPerTurn?: number | undefined;
}

/** A dev run's limit on a device the judge shares, when the contract sets none. */
export const SHARED_DEV_RUN_S = 300;

/** A lane user's processes and threads when the contract sets none (the broker's own default). */
export const LANE_PROCESSES = 256;

/** A contract's lane limits, with the defaults for anything it leaves out. */
export function laneLimits(contract: Pick<Contract, "lanes">): LaneLimitValues {
  const l = contract.lanes.limits ?? {};
  return {
    runTimeoutS: l.run_timeout_s,
    runRssMib: l.run_rss_mib ?? 2048,
    workspaceMib: l.workspace_mib ?? 2048,
    devRunTimeoutS: l.dev_run_timeout_s,
    devRunRssMib: l.dev_run_rss_mib ?? 4096,
    trialMinutes: l.trial_minutes,
    processes: l.processes ?? LANE_PROCESSES,
    failuresInARow: l.failures_in_a_row,
    cutoffsInARow: l.cutoffs_in_a_row,
    nudges: l.nudges,
    notesPerTurn: l.notes_per_turn,
  };
}

/** The content hash of a validated contract: sha256 of its canonical JSON. */
export function contractSha(contract: Contract): string {
  return canonicalSha(contract);
}
