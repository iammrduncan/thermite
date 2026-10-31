import { z } from "zod";
import {
  AgentsContext,
  agentsContextRefusal,
  agentsContextWords,
  COMPACT_AT_DEFAULT,
  COMPACT_AT_MAX,
  COMPACT_AT_MIN,
  CONTEXT_WINDOW_MAX,
  CONTEXT_WINDOW_MIN,
  contextApplied,
} from "../../core/compaction.ts";
import { isRigCheck } from "../../core/ids.ts";
import { cappedWindow } from "../providers/index.ts";
import type { AgentRole, ControlStore } from "../store/index.ts";
import { saveWithField } from "./saved-version.ts";

/**
 * A campaign's own context settings for all its runs (goal 070): a context window and a
 * compaction point that every agent of its runs works with. The rig sets the defaults (each
 * agent's model, with its own cap and point: set_rig_model); a campaign may set its own.
 *
 * Where it lives: the contract, as `agents_context`, optional and without a default, so a
 * contract without it keeps its hash. A contract is what control signs into each assignment, what
 * the rig's harness and supervisor already read for every run, what a copy takes, and what the
 * run's record keeps (its version and hash); a change is a new version, as for the contract's lane
 * limits, so a run's settings never change under it. Kept beside the contract on control instead,
 * the settings would need their own field in the signed assignment and their own record.
 *
 * Each agent's window is the lower of the campaign's and its own (the provider's, or the rig's cap
 * on it): the lower wins. A campaign window above what a provider lists for one of the rig's
 * agents' models is refused when a run starts, in words; a campaign point replaces the rig's.
 *
 * REST's POST /v1/campaigns/<name>/context, MCP's set_campaign_context and `thermite campaign
 * context` save a new version with the settings; copy_campaign and `thermite campaign copy` may set
 * them on a copy; `thermite assign` writes them into the contract it sends.
 */

/** The campaign's own context settings in a contract, when it sets any. */
export function contractContext(contract: unknown): AgentsContext | undefined {
  const raw = (contract as { agents_context?: unknown } | null | undefined)?.agents_context;
  const r = AgentsContext.safeParse(raw);
  return r.success && (r.data.context_window !== undefined || r.data.compact_at !== undefined)
    ? r.data
    : undefined;
}

/** A campaign's newest contract on control: its newest saved version, or else its newest assignment's. */
export function campaignContract(store: ControlStore, campaign: string): unknown {
  return (
    store.campaigns.versions(campaign)[0]?.contract ??
    store.commands.latestAssignments().get(campaign)?.payload.contract
  );
}

/** The request's fields over REST and MCP (MCP adds the campaign). */
export const campaignContextFields = {
  context_window: z
    .number()
    .int()
    .optional()
    .describe(
      `The context window, in tokens (${CONTEXT_WINDOW_MIN} to ${CONTEXT_WINDOW_MAX}), that every agent of the campaign's runs works with at most: each agent's window is the lower of this and its own model's. Left out: each agent's own`,
    ),
  // Any number: one that is not a whole percent in range is refused in words.
  compact_at: z
    .number()
    .optional()
    .describe(
      `The share of the window, in percent (${COMPACT_AT_MIN} to ${COMPACT_AT_MAX}), at which every agent's conversation is compacted, in place of the rig's. Left out: each agent's own (default ${COMPACT_AT_DEFAULT})`,
    ),
};

/** The REST body: the settings, and nothing else; an empty body removes them. */
export const CampaignContextBody = z.strictObject(campaignContextFields);
export type CampaignContextBody = z.infer<typeof CampaignContextBody>;

export interface CampaignContextRequest {
  campaign: string;
  contextWindow?: number | undefined;
  compactAt?: number | undefined;
}

export type CampaignContextOutcome =
  | {
      /** saved: a new version; unchanged: the newest version has these settings already. */
      state: "saved" | "unchanged" | "valid";
      campaign: string;
      version: number;
      sha: string;
      context: AgentsContext | undefined;
    }
  | { state: "refused"; error: string; status: 400 | 404 | 409 };

/** The settings a request asks for, as the contract keeps them (undefined: none). */
export function requestedContext(r: {
  contextWindow?: number | undefined;
  compactAt?: number | undefined;
}): AgentsContext | undefined {
  const c: AgentsContext = {
    ...(r.contextWindow !== undefined ? { context_window: r.contextWindow } : {}),
    ...(r.compactAt !== undefined ? { compact_at: r.compactAt } : {}),
  };
  return Object.keys(c).length ? c : undefined;
}

const same = (a: AgentsContext | undefined, b: AgentsContext | undefined) =>
  a?.context_window === b?.context_window && a?.compact_at === b?.compact_at;

/**
 * Sets a campaign's own context settings, or (none given) removes them: a new version of its
 * contract, saved as the New campaign page saves one, with the same sources (saveWithField). Each
 * call sets them anew: what it leaves out, the new version does not have. A campaign control knows
 * only by an assignment gets its first saved version, from that assignment. Refused in words.
 */
export function setCampaignContext(
  store: ControlStore,
  req: CampaignContextRequest,
  by: string,
): CampaignContextOutcome {
  const { campaign } = req;
  if (isRigCheck(campaign))
    return {
      state: "refused",
      error: `${campaign} is a rig check's campaign. Its agents keep the rig's settings.`,
      status: 400,
    };
  const why = agentsContextRefusal({
    context_window: req.contextWindow,
    compact_at: req.compactAt,
  });
  if (why) return { state: "refused", error: why, status: 400 };
  const want = requestedContext(req);
  const out = saveWithField(store, {
    campaign,
    field: "agents_context",
    value: want,
    same: (contract) => same(contractContext(contract), want),
    what: "the rig's settings",
    by,
    action: "campaign_context_set",
    audit: { agents_context: want ?? null },
  });
  return out.state === "refused" ? out : { ...out, context: want };
}

/** The answer REST and MCP give: the campaign's version with the settings, and what it says. */
export function campaignContextAnswer(
  out: Exclude<CampaignContextOutcome, { state: "refused" }>,
): Record<string, unknown> {
  return {
    campaign: out.campaign,
    version: out.version,
    contract_sha: out.sha,
    agents_context: out.context ?? null,
    said:
      out.state === "unchanged"
        ? `Version ${out.version} of ${out.campaign} has these settings already: ${agentsContextWords(out.context)}.`
        : `Version ${out.version} of ${out.campaign} is saved. Its runs' agents: ${agentsContextWords(out.context)}. Runs started from now take it.`,
  };
}

/**
 * Each model a run's agents work with (goal 074): the workers', and each one control keeps for the
 * other agents, the teachers' second and merged by models among them.
 */
export type AgentPlace = "workers" | AgentRole;

/**
 * The places of a campaign's runs' agents, by mode: a research run has no auditor or review
 * panel here; its planner plans its rounds from the answer cards (goals 047 and 117), and its
 * synthesizer and final writer write its cards and its paper (goal 166).
 */
export function agentsOfMode(mode: unknown): AgentPlace[] {
  const teachers: AgentPlace[] = ["teachers", "second_teacher", "merged_by"];
  return mode === "research"
    ? ["workers", "planner", ...teachers, "synthesizer", "final_writer"]
    : ["workers", "planner", ...teachers, "auditor", "review_panel"];
}

/** How each agent's model is named in words. */
export const AGENT_NAMES: Record<AgentPlace, string> = {
  workers: "Workers",
  planner: "Planner",
  teachers: "Teachers",
  second_teacher: "Teachers (second model)",
  merged_by: "Teachers (merged by)",
  auditor: "Auditor",
  review_panel: "Review panel",
  synthesizer: "Synthesizer",
  final_writer: "Final writer",
};

/** What one agent of a run works with: its model, window and compaction point. */
export interface AgentContext {
  /** The model control gives it; null: the rig's own settings, or its advisors file. */
  model: string | null;
  /**
   * Its window in tokens: the lower of the campaign's and its model's (the provider's, or the
   * rig's cap on it). Null: control does not know it (no model from control, no campaign window).
   */
  context_window: number | null;
  /** Its compaction point in percent; null: the rig's own, which control does not know. */
  compact_at: number | null;
}

/** What applies to a run's agents on a rig: the campaign's settings, and each agent's. */
export interface ContextApplies {
  campaign: AgentsContext;
  agents: Partial<Record<AgentPlace, AgentContext>>;
}

/** One agent's own model on control, with the provider's window and its cap and point. */
function ownModel(
  store: ControlStore,
  rig: string,
  agent: AgentPlace,
):
  | { model: string; listed: number; cap?: number | undefined; at?: number | undefined }
  | undefined {
  const own =
    agent === "workers" ? store.agentModels.byRig()[rig] : store.agentModels.byRole(rig)[agent];
  if (!own) return undefined;
  const listed =
    store.modelProviders.get(own.provider)?.models.find((m) => m.id === own.model)
      ?.context_window ?? 0;
  return { model: own.model, listed, cap: own.contextCap, at: own.compactAt };
}

/**
 * What applies to the agents of a run of a campaign with its own settings on a rig, as Start a
 * run says it: each agent's model, window and point. Undefined when the campaign sets none.
 */
export function contextApplies(
  store: ControlStore,
  rig: string,
  contract: unknown,
): ContextApplies | undefined {
  const campaign = contractContext(contract);
  if (!campaign) return undefined;
  const agents: Partial<Record<AgentPlace, AgentContext>> = {};
  const workers = (): AgentContext => {
    const own = ownModel(store, rig, "workers");
    if (!own)
      return {
        model: null,
        context_window: campaign.context_window ?? null,
        compact_at: campaign.compact_at ?? null,
      };
    const a = contextApplied(
      { contextWindow: cappedWindow(own.listed, own.cap), compactAt: own.at },
      campaign,
    );
    return {
      model: own.model,
      context_window: a.contextWindow || null,
      compact_at: a.compactAt ?? COMPACT_AT_DEFAULT,
    };
  };
  for (const agent of agentsOfMode((contract as { mode?: unknown } | null)?.mode)) {
    const own = agent === "workers" ? undefined : ownModel(store, rig, agent);
    // A second teacher only when control gives both teachers a model: else there is one.
    if (agent === "second_teacher" && (!own || !ownModel(store, rig, "teachers"))) continue;
    if (agent === "workers" || (agent === "planner" && !own)) {
      agents[agent] = workers();
      continue;
    }
    // The synthesizer and the final writer with no model of their own use the first teacher's.
    const first = agents.teachers;
    if (!own && (agent === "synthesizer" || agent === "final_writer") && first) {
      agents[agent] = first;
      continue;
    }
    if (!own) {
      agents[agent] = {
        model: null,
        context_window: campaign.context_window ?? null,
        compact_at: campaign.compact_at ?? null,
      };
      continue;
    }
    const a = contextApplied(
      { contextWindow: cappedWindow(own.listed, own.cap), compactAt: own.at },
      campaign,
    );
    agents[agent] = {
      model: own.model,
      context_window: a.contextWindow || null,
      compact_at: a.compactAt ?? COMPACT_AT_DEFAULT,
    };
  }
  return { campaign, agents };
}

const tokens = (n: number) => n.toLocaleString("en-US");

/** What applies, in words: the campaign's settings, then a sentence for each agent. */
export function contextAppliesWords(c: ContextApplies, rig: string): string {
  const lines = (Object.entries(c.agents) as [AgentPlace, AgentContext][]).map(([agent, a]) => {
    const from =
      a.model ??
      (agent === "workers" || agent === "planner"
        ? `the rig's own settings on ${rig}`
        : "the rig's advisors file");
    const window =
      a.context_window === null
        ? "the window of its model"
        : `${a.model ? "" : "at most "}${tokens(a.context_window)} tokens`;
    const point = a.compact_at === null ? "" : `, compacted at ${a.compact_at}% of the window`;
    return `${AGENT_NAMES[agent]}: ${window} (${from})${point}.`;
  });
  return `This campaign sets ${agentsContextWords(c.campaign)}. The lower window wins on each agent. ${lines.join(" ")}`;
}

/**
 * Why a run of a campaign with its own window cannot start on a rig, in words, or "": the window
 * is above what a provider lists for one of the rig's agents' models (control gave them). The
 * lower wins against a rig's cap; a window above the provider's is refused, as a cap is.
 */
export function campaignContextRefusal(
  store: ControlStore,
  rig: string,
  contract: unknown,
): string {
  const window = contractContext(contract)?.context_window;
  if (!window) return "";
  for (const agent of agentsOfMode((contract as { mode?: unknown } | null)?.mode)) {
    const own = ownModel(store, rig, agent);
    if (agent === "second_teacher" && !ownModel(store, rig, "teachers")) continue;
    if (own && own.listed > 0 && window > own.listed)
      return `This campaign sets a context window of ${tokens(window)} tokens. ${own.model}, the model of the ${AGENT_NAMES[agent].toLowerCase()} on ${rig}, takes at most ${tokens(own.listed)} tokens. Set the campaign's window to ${tokens(own.listed)} or less, or give that agent another model.`;
  }
  return "";
}

/**
 * One agent's own model on a rig, as the screens need it (goal 070): its model, the window its
 * provider lists (0: none), and the rig's cap and point on it. Only agents control gives a model.
 */
export interface OwnModel {
  agent: AgentPlace;
  model: string;
  listed: number;
  cap: number | null;
  at: number | null;
}

/** Every agent but the workers, in the order the screens list them. */
const AGENT_ROLE_PLACES: AgentPlace[] = [
  "planner",
  "teachers",
  "second_teacher",
  "merged_by",
  "auditor",
  "review_panel",
  "synthesizer",
  "final_writer",
];

/**
 * The agents of a rig with a model from control: those of a campaign's mode, or (no mode) every
 * agent; a second teacher only with a first.
 */
export function ownModels(store: ControlStore, rig: string, mode?: unknown): OwnModel[] {
  const agents: AgentPlace[] =
    mode === undefined ? ["workers", ...AGENT_ROLE_PLACES] : agentsOfMode(mode);
  const out: OwnModel[] = [];
  for (const agent of agents) {
    const own = ownModel(store, rig, agent);
    if (!own) continue;
    if (agent === "second_teacher" && !ownModel(store, rig, "teachers")) continue;
    out.push({
      agent,
      model: own.model,
      listed: own.listed,
      cap: own.cap ?? null,
      at: own.at ?? null,
    });
  }
  return out;
}

/**
 * What a campaign's settings give a rig's workers, and whether a run can start there, as the
 * screens show it (New campaign, Copy, the campaign's page and Start a run): the workers' window
 * and where it comes from (the campaign's, the rig's, or none control knows), their point, and the
 * model that refuses the run (campaignContextRefusal: a campaign window above what a provider
 * lists for one of the agents' models). The page's script does the same as you type
 * (context/client.ts).
 */
export interface RigContext {
  window: number | null;
  windowFrom: "campaign" | "rig" | "none";
  at: number | null;
  atFrom: "campaign" | "rig" | "none";
  refused: { model: string; listed: number } | null;
}
export function rigContext(own: readonly OwnModel[], c: AgentsContext | undefined): RigContext {
  const w = own.find((a) => a.agent === "workers");
  const rigWindow = w ? cappedWindow(w.listed, w.cap ?? undefined) : 0;
  const cw = c?.context_window;
  const fromCampaign = Boolean(cw && (rigWindow <= 0 || cw <= rigWindow));
  const refusedBy = cw ? own.find((a) => a.listed > 0 && cw > a.listed) : undefined;
  return {
    window: fromCampaign ? (cw ?? null) : rigWindow || null,
    windowFrom: fromCampaign ? "campaign" : rigWindow ? "rig" : "none",
    at: c?.compact_at ?? (w ? (w.at ?? COMPACT_AT_DEFAULT) : null),
    atFrom: c?.compact_at ? "campaign" : w ? "rig" : "none",
    refused: refusedBy ? { model: refusedBy.model, listed: refusedBy.listed } : null,
  };
}
