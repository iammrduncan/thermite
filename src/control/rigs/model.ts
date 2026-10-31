import { z } from "zod";
import { reaches, routeRefusal } from "../../core/agents.ts";
import {
  type AdvisorSetupView,
  AdvisorsFileSchema,
  type AdvisorsFileView,
} from "../../core/api/control/rigs.ts";
import {
  COMPACT_AT_DEFAULT,
  COMPACT_AT_MAX,
  COMPACT_AT_MIN,
  compactAtRefusal,
} from "../../core/compaction.ts";
import { isOpencodeOwn } from "../providers/index.ts";
import {
  type AgentRole,
  type ControlStore,
  EFFORTS,
  type Effort,
  HARNESSES,
  type Harness,
  type ModelProvider,
} from "../store/index.ts";

/**
 * Each agent's model on a rig, from outside the dashboard (goals 029, 070, 074 and 166): REST's
 * `POST /v1/rigs/<rig>/model` and MCP's `set_rig_model` set one agent's model, or clear it, as a
 * row of Edit rig's section "2 · The agents" does; `GET /v1/rigs/<rig>/model` and MCP's
 * `rig_models` read them all. Both call Edit rig's own code (setRigModel and rigModels in
 * rigs/agent-models.ts), so Edit rig and its twins check and refuse alike. This module holds what the
 * twins share: the request's fields, its checks of shape, and the answer.
 *
 * The agents (goal 074): the work, the workers and the planner; the advisors, the teachers, the
 * auditor and the review panel. The teachers take one or two models (`model`, and `second_model`
 * for a second teacher), and with two a `merged_by` model that merges their advice.
 */

/** The agents, as REST, MCP and the pages name them (goals 074 and 166). */
export const MODEL_AGENTS = [
  "workers",
  "planner",
  "teachers",
  "auditor",
  "review_panel",
  "synthesizer",
  "final_writer",
] as const;
export type ModelAgent = (typeof MODEL_AGENTS)[number];

/**
 * Each model control keeps for a rig's agents but the workers (AgentRole: the planner, each of
 * the teachers' models, the auditor, the review panel, the synthesizer, the final writer), with
 * the words Edit rig and its twins say for it.
 */
export const ROLE_WORDS: Record<
  AgentRole,
  { label: string; who: string; given: string; cleared: string; whose: string }
> = {
  planner: {
    label: "planner",
    who: "the planner",
    given: "a model for the planner",
    cleared: "the planner back to the workers' model",
    whose: "The planner's",
  },
  teachers: {
    label: "teachers",
    who: "the teachers",
    given: "a model for the teachers",
    cleared: "the teachers back to the rig's advisors file",
    whose: "The first teacher's",
  },
  second_teacher: {
    label: "second teacher",
    who: "the second teacher",
    given: "a model for a second teacher",
    cleared: "the teachers back to one teacher",
    whose: "The second teacher's",
  },
  merged_by: {
    label: "merged by",
    who: "the teachers' merged by model",
    given: "a merged by model for the teachers",
    cleared: "the teachers' merged by model back to the rig's advisors file",
    whose: "The merged by model's",
  },
  auditor: {
    label: "auditor",
    who: "the auditor",
    given: "a model for the auditor",
    cleared: "the auditor back to the rig's advisors file",
    whose: "The auditor's",
  },
  review_panel: {
    label: "review panel",
    who: "the review panel",
    given: "a model for the review panel",
    cleared: "the review panel back to the rig's advisors file",
    whose: "The review panel's",
  },
  synthesizer: {
    label: "synthesizer",
    who: "the synthesizer",
    given: "a model for the synthesizer",
    cleared: "the synthesizer back to the first teacher's model",
    whose: "The synthesizer's",
  },
  final_writer: {
    label: "final writer",
    who: "the final writer",
    given: "a model for the final writer",
    cleared: "the final writer back to the first teacher's model",
    whose: "The final writer's",
  },
};

/** A model for one of an agent's places, in the dashboard's terms. */
export interface ModelChoice {
  provider: string;
  model: string;
  /** Left out: what its model needs. */
  harness?: Harness | undefined;
  effort?: Effort | undefined;
  /** A cap on the model's context window in tokens (goal 070). */
  contextWindow?: number | undefined;
  /** The model's compaction point, in percent of the window (goal 070). */
  compactAt?: number | undefined;
}

/** One agent's model request, in the dashboard's terms. */
export interface RigModelRequest {
  /** Default: the workers. The old names are still taken in v0.1.0. */
  agent?: ModelAgent | undefined;
  provider?: string | undefined;
  model?: string | undefined;
  /** True: the agent's default again, as Edit rig's first choice in its row. */
  clear?: boolean | undefined;
  /**
   * The agent's harness (goal 073); left out, what its model needs (the workers': harnessFor on
   * the dashboard, which keeps a rig's Codex or OpenCode where it can).
   */
  harness?: Harness | undefined;
  effort?: Effort | undefined;
  /** A cap on the agent's context window in tokens (goal 070): every agent has its own. */
  contextWindow?: number | undefined;
  /** The agent's compaction point, in percent of the window (goal 070). */
  compactAt?: number | undefined;
  /** The teachers only: a second teacher's model; null, one teacher only (goal 074). */
  secondModel?: ModelChoice | null | undefined;
  /** The teachers only: the model that merges two teachers' advice; null, the advisors file's. */
  mergedBy?: ModelChoice | null | undefined;
}

/**
 * One agent's model on control, the harness it runs in (goal 073), and its own cap and
 * compaction point (goal 070).
 */
export interface AgentModel {
  provider: string;
  model: string;
  effort: Effort | null;
  /** The harness it runs in: the owner's choice, else what its model needs (goal 073). */
  harness: Harness;
  /** A cap on the model's context window in tokens; null: the provider's window. */
  context_cap: number | null;
  /** The compaction point in percent of the window; null: the harness's default. */
  compact_at: number | null;
}
/** The workers' model: as every agent's. */
export type WorkersModel = AgentModel;
/**
 * The teachers' models on control (goal 074): one or two teachers, and the model that merges the
 * advice of two. No models: the rig's advisors file's; merged_by null: the file's.
 */
export interface TeachersModels {
  models: AgentModel[];
  merged_by: AgentModel | null;
}
/**
 * Each agent's model on control; null: its default (Edit rig's first choice in its row). The
 * synthesizer's and the final writer's default is the first teacher's model (goal 166).
 */
export interface AgentModels {
  workers: WorkersModel | null;
  planner: AgentModel | null;
  teachers: TeachersModels;
  auditor: AgentModel | null;
  review_panel: AgentModel | null;
  synthesizer: AgentModel | null;
  final_writer: AgentModel | null;
}

/** What a call did: Edit rig's words, the window the agent's route carries, and every agent's model. */
export interface RigModelOutcome {
  ok: string;
  /** The window the agent's model route carries, in tokens; null: unknown, or the model cleared. */
  contextWindow: number | null;
  /** The agent's compaction point (percent); null: the default, or the model cleared. */
  compactAt?: number | null | undefined;
  agents: AgentModels;
}

const providerField = z.string().min(1).max(200).describe("The model provider's name in Providers");
const modelField = z
  .string()
  .min(1)
  .max(200)
  .describe("A model id, as the providers tool lists it");
const harnessField = z
  .enum(HARNESSES)
  .describe(
    "Where the agent runs: pi, opencode (OpenCode v2), claude-code or codex; left out, what its model needs",
  );
const effortField = z.enum(EFFORTS).describe("How long the model thinks, as Effort on Edit rig");
const windowField = z
  .number()
  .int()
  .describe("Any agent: a cap on its model's context window in tokens");
// Any number: one that is not a whole percent in range is refused in words.
const pointField = z
  .number()
  .describe(
    `Any agent: the share of the context window, in percent (${COMPACT_AT_MIN} to ${COMPACT_AT_MAX}), at which its conversation is compacted; left out, ${COMPACT_AT_DEFAULT}`,
  );

/** Another model of the teachers': the request's own fields, in an object. */
const TeacherModelBody = z.strictObject({
  provider: providerField,
  model: modelField,
  harness: harnessField.optional(),
  effort: effortField.optional(),
  context_window: windowField.optional(),
  compact_at: pointField.optional(),
});
type TeacherModelBody = z.infer<typeof TeacherModelBody>;

/** The request's fields over REST and MCP, in snake case (MCP adds the rig). */
export const rigModelFields = {
  agent: z
    .enum(MODEL_AGENTS)
    .optional()
    .describe(
      "Whose model: workers (default), planner, teachers, auditor, review_panel, synthesizer or final_writer",
    ),
  provider: providerField.optional(),
  model: modelField.optional(),
  clear: z
    .boolean()
    .optional()
    .describe(
      "true: the agent goes back to its default, with no provider or model: the workers to the rig's own settings, the planner to the workers' model, the synthesizer and the final writer to the first teacher's model, another advisor to the one in the rig's advisors file (off when the file names none); the teachers with their second and merged by models",
    ),
  harness: harnessField.optional(),
  effort: effortField.optional(),
  context_window: windowField.optional(),
  compact_at: pointField.optional(),
  second_model: TeacherModelBody.nullable()
    .optional()
    .describe(
      "The teachers only: a second teacher, with its own model: {provider, model, harness?, effort?, context_window?, compact_at?}, each field as for the first teacher. null: one teacher only. Left out: as it is",
    ),
  merged_by: TeacherModelBody.nullable()
    .optional()
    .describe(
      "The teachers only: the model that merges the advice of two teachers into one set: {provider, model, harness?, effort?, context_window?, compact_at?}. null: the one in the rig's advisors file. Left out: as it is. Two teachers without a merged by model: the first review that comes back is the set",
    ),
};

export const RigModelBody = z.strictObject(rigModelFields);
export type RigModelBody = z.infer<typeof RigModelBody>;

const choiceOf = (b: TeacherModelBody | null | undefined): ModelChoice | null | undefined =>
  b
    ? {
        provider: b.provider,
        model: b.model,
        harness: b.harness,
        effort: b.effort,
        contextWindow: b.context_window,
        compactAt: b.compact_at,
      }
    : b;

export const rigModelRequest = (b: RigModelBody): RigModelRequest => ({
  agent: b.agent,
  provider: b.provider,
  model: b.model,
  clear: b.clear,
  harness: b.harness,
  effort: b.effort,
  contextWindow: b.context_window,
  compactAt: b.compact_at,
  secondModel: choiceOf(b.second_model),
  mergedBy: choiceOf(b.merged_by),
});

/** Why a request has the wrong fields for its agent, in words; undefined when its shape is right. */
export function rigModelShapeRefusal(r: RigModelRequest): string | undefined {
  const others = r.secondModel !== undefined || r.mergedBy !== undefined;
  if (others && r.agent !== "teachers")
    return "second_model and merged_by are for the teachers only: give agent teachers.";
  const own =
    r.provider !== undefined ||
    r.model !== undefined ||
    r.harness !== undefined ||
    r.effort !== undefined ||
    r.contextWindow !== undefined ||
    r.compactAt !== undefined;
  if (r.clear) {
    if (own || others) return "Give clear alone, or a provider and a model.";
    return undefined;
  }
  // The teachers' second or merged by model alone: the first teacher keeps its model.
  if (own || !others) {
    if (!r.provider || !r.model)
      return r.agent === "teachers"
        ? "Give a provider and a model, second_model or merged_by, or clear: true."
        : "Give a provider and a model, or clear: true.";
    // Every agent takes its own harness (goal 073), cap and point (goal 070); a planner with no
    // model of its own has none to set, and uses the workers'.
    if (r.compactAt !== undefined) {
      const point = compactAtRefusal(r.compactAt);
      if (point) return point;
    }
  }
  for (const c of [r.secondModel, r.mergedBy])
    if (c?.compactAt !== undefined) {
      const point = compactAtRefusal(c.compactAt);
      if (point) return point;
    }
  return undefined;
}

/** One place's new model (null: its default), as a request asks for it. */
export interface RoleChange {
  role: "workers" | AgentRole;
  choice: ModelChoice | null;
}

/**
 * What a request changes, in order (after rigModelShapeRefusal): the agent's own model, and for
 * the teachers their second and merged by models. Clearing the teachers clears all three.
 */
export function rigModelChanges(r: RigModelRequest): RoleChange[] {
  const agent = r.agent ?? "workers";
  const own: ModelChoice | null =
    r.clear || !r.provider || !r.model
      ? null
      : {
          provider: r.provider,
          model: r.model,
          harness: r.harness,
          effort: r.effort,
          contextWindow: r.contextWindow,
          compactAt: r.compactAt,
        };
  if (agent !== "teachers") return [{ role: agent, choice: own }];
  if (r.clear)
    return [
      { role: "teachers", choice: null },
      { role: "second_teacher", choice: null },
      { role: "merged_by", choice: null },
    ];
  return [
    ...(own ? [{ role: "teachers" as const, choice: own }] : []),
    ...(r.secondModel !== undefined
      ? [{ role: "second_teacher" as const, choice: r.secondModel }]
      : []),
    ...(r.mergedBy !== undefined ? [{ role: "merged_by" as const, choice: r.mergedBy }] : []),
  ];
}

/** Whether a provider's model runs only in OpenCode: OpenCode's own (free) models. */
export const opencodeOnly = (p: ModelProvider, model: string): boolean =>
  isOpencodeOwn(p) && (p.type === "opencode" || !p.key_sealed || model.endsWith("-free"));

/**
 * The harness a model needs when the owner chooses none: Claude Code for a Claude subscription,
 * OpenCode for OpenCode's own models, else Pi (a ChatGPT sign-in too).
 */
export const neededHarness = (p: ModelProvider, model: string): Harness =>
  p.type === "claude" ? "claude-code" : opencodeOnly(p, model) ? "opencode" : "pi";

/** A harness's name as the dashboard shows it. */
export const HARNESS_NAMES: Record<Harness, string> = {
  pi: "Pi",
  opencode: "OpenCode v2",
  "claude-code": "Claude Code",
  codex: "Codex",
};

/**
 * Why a harness cannot run a provider's model, in words, for `who` ("the planner"); undefined
 * when it can (goal 073). A Claude subscription runs only in Claude Code, and Claude Code only on
 * one; Codex only on OpenAI's Responses API; OpenCode's own models only in OpenCode.
 */
export function harnessRefusal(
  p: ModelProvider,
  model: string,
  harness: Harness,
  who: string,
): string | undefined {
  // The rules of the provider's kind (core/agents.ts), then OpenCode's free models, which are
  // told apart by more than their provider's kind.
  const refused = routeRefusal(p.type, harness);
  if (refused === "claude-code" && harness !== "claude-code")
    return `A Claude subscription runs only in Claude Code: choose Claude Code for ${who}, or another model.`;
  if (refused === "claude-code")
    return `Claude Code runs only with a Claude subscription here: choose ${reaches("codex", p.type) ? "Pi, OpenCode v2 or Codex" : "Pi or OpenCode v2"} for this provider.`;
  if (refused === "codex")
    return "Codex runs only with a ChatGPT subscription or an OpenAI-compatible provider: choose Pi or OpenCode v2 for this provider.";
  if (harness !== "opencode" && opencodeOnly(p, model))
    return `OpenCode's free models run only in OpenCode: choose OpenCode v2 for ${who}, or another model.`;
  return undefined;
}

/** Each agent's model, as control keeps them for the rig. */
export function agentModelsOf(store: ControlStore, rig: string): AgentModels {
  const w = store.agentModels.byRig()[rig];
  const roles = store.agentModels.byRole(rig);
  const of = (role: AgentRole): AgentModel | null => {
    const r = roles[role];
    if (!r) return null;
    const p = store.modelProviders.get(r.provider);
    return {
      provider: r.provider,
      model: r.model,
      effort: r.effort,
      harness: r.harness ?? (p ? neededHarness(p, r.model) : "pi"),
      context_cap: r.contextCap ?? null,
      compact_at: r.compactAt ?? null,
    };
  };
  // A second teacher only with a first: without one, the teachers are the advisors file's.
  const first = of("teachers");
  const second = first ? of("second_teacher") : null;
  return {
    workers: w
      ? {
          provider: w.provider,
          model: w.model,
          effort: w.effort ?? null,
          harness: w.harness,
          context_cap: w.contextCap ?? null,
          compact_at: w.compactAt ?? null,
        }
      : null,
    planner: of("planner"),
    teachers: {
      models: [...(first ? [first] : []), ...(second ? [second] : [])],
      merged_by: of("merged_by"),
    },
    auditor: of("auditor"),
    review_panel: of("review_panel"),
    synthesizer: of("synthesizer"),
    final_writer: of("final_writer"),
  };
}

/** What a rig's advisors file sets up, as its supervisor reports it (core/api/control/rigs.ts). */
export type { AdvisorSetupView, AdvisorsFileView };

/** A file that names no advisor: what a supervisor that reports no advisors at all has. */
const NO_ADVISORS: AdvisorsFileView = {
  teachers: [],
  merged_by: null,
  auditor: null,
  review_panel: [],
};

/**
 * What a rig's advisors file sets up, from its supervisor's last report; undefined when control
 * can't tell: no report yet, or a supervisor older than this field. A supervisor that reports no
 * advisors (`advisors: null`, every version) has none in its file, nor from control.
 */
export function advisorsFileOf(
  supervisor: Record<string, unknown> | null | undefined,
): AdvisorsFileView | undefined {
  if (!supervisor || !("advisors" in supervisor)) return undefined;
  const advisors = supervisor.advisors;
  if (advisors === null) return NO_ADVISORS;
  const file = AdvisorsFileSchema.safeParse((advisors as { file?: unknown } | undefined)?.file);
  return file.success ? file.data : undefined;
}

/** The answer of `rig_models` and its REST twin: each agent's model, and the advisors file's. */
export const rigModelsAnswer = (store: ControlStore, rig: string, agents: AgentModels) => ({
  rig,
  agents,
  // null: the supervisor has not reported it (none yet, or an older supervisor).
  advisors_file: advisorsFileOf(store.reportedRigs.supervisor(rig)) ?? null,
});

/**
 * The answer over REST and MCP: the agent as asked (an old name too), and the window and point
 * of the model the call gave it (for the teachers, the first teacher's; null when it gave none).
 */
export const rigModelAnswer = (rig: string, r: RigModelRequest, out: RigModelOutcome) => ({
  rig,
  agent: r.agent ?? "workers",
  model: r.clear ? null : (r.model ?? null),
  context_window: out.contextWindow,
  // The agent's compaction point (goal 070): null, the default.
  compact_at: out.compactAt ?? null,
  said: out.ok,
  agents: out.agents,
});
