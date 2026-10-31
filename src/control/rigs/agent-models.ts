import { compactAtRefusal, compactAtWords } from "../../core/compaction.ts";
import { listText } from "../../core/words.ts";
import { cappedWindow, capWords, contextCapRefusal, isOpencodeOwn } from "../providers/index.ts";
import {
  type AgentRole,
  type ControlStore,
  codexTakes,
  type Effort,
  type Harness,
} from "../store/index.ts";
import type { RigView } from "../views/index.ts";
import {
  type AgentModels,
  agentModelsOf,
  HARNESS_NAMES,
  harnessRefusal,
  neededHarness,
  type RigModelOutcome,
  type RigModelRequest,
  ROLE_WORDS,
  rigModelChanges,
  rigModelShapeRefusal,
} from "./model.ts";

/**
 * Each of a rig's agents' models (goals 029, 070, 073, 074): what Providers, Edit rig, Start a run,
 * REST and MCP give or clear, with the same checks and the same refusals in words (goal 125, T5).
 */

/**
 * A rig whose agents' model works only inside OpenCode (OpenCode's free models) while its
 * research workers would run in Pi: a research run there could not work. From the model and
 * harness chosen now, else control's record, else the rig's report.
 */
export const opencodeOnlyModel = (
  store: ControlStore,
  u: RigView,
  chosen?: string,
  picked = "",
): string | undefined => {
  let provider: ReturnType<typeof store.modelProviders.get>;
  let model: string | undefined;
  let harness: Harness | undefined;
  if (chosen) {
    const [pRaw, mRaw] = chosen.split("|");
    provider = store.modelProviders.get(decodeURIComponent(pRaw ?? ""));
    model = decodeURIComponent(mRaw ?? "");
    harness = harnessKept(store, u.id, chosen, picked);
  } else {
    const given = store.agentModels.byRig()[u.id];
    if (given) {
      provider = store.modelProviders.get(given.provider);
      model = given.model;
      harness = given.harness;
    } else if (u.model?.model) {
      const fake = { type: "openai" as const, base_url: u.model.base_url ?? "" };
      return isOpencodeOwn(fake) &&
        u.model.model.endsWith("-free") &&
        u.model.harness !== "opencode"
        ? u.model.model
        : undefined;
    }
  }
  if (!provider || !model || !isOpencodeOwn(provider) || harness === "opencode") return undefined;
  return provider.type === "opencode" || !provider.key_sealed || model.endsWith("-free")
    ? model
    : undefined;
};
export const researchNeedsOpencode = (rig: string, model: string) =>
  `${model} is one of OpenCode's free models, which work only inside OpenCode, and ${rig}'s agents would run in Pi: a research run there could not work. Set the agents' harness to OpenCode, or give the rig a model Pi can use.`;
/** A rig whose agents have no model: none from control, and the rig reports none. */
export const agentsModelMissing = (store: ControlStore, u: RigView) =>
  !store.agentModels.byRig()[u.id] && u.model?.source === "none";
/**
 * The harness a model needs when the owner leaves it to control: Claude Code for a Claude
 * subscription, OpenCode for OpenCode's free models, else Pi (a ChatGPT sign-in too, unless the
 * owner picks Codex).
 */
export const harnessFor = (store: ControlStore, choice: string, picked: string): Harness => {
  if (picked === "opencode" || picked === "pi" || picked === "codex") return picked;
  const [pRaw, mRaw] = choice.split("|");
  const p = store.modelProviders.get(decodeURIComponent(pRaw ?? ""));
  return p ? neededHarness(p, decodeURIComponent(mRaw ?? "")) : "pi";
};
/**
 * The harness to give a rig with a model, when the owner names none (New campaign and Start a
 * run): the rig's own when control gave it this model already, so a rig on Codex or OpenCode
 * stays there; else what the model needs (harnessFor).
 */
export const harnessKept = (
  store: ControlStore,
  rig: string,
  choice: string,
  picked: string,
): Harness => {
  if (picked) return harnessFor(store, choice, picked);
  const [pRaw, mRaw] = choice.split("|");
  const had = store.agentModels.byRig()[rig];
  return had &&
    had.provider === decodeURIComponent(pRaw ?? "") &&
    had.model === decodeURIComponent(mRaw ?? "")
    ? had.harness
    : harnessFor(store, choice, "");
};

/**
 * Gives a rig a provider's model under a harness, as Providers and Edit rig both do. `cap`: a cap
 * on the model's context window in tokens (goal 070), or null for none. Left out (Providers' form,
 * which has no field for it, or a form without Edit rig's Context fields), a cap the rig has
 * stays while it keeps the same model.
 */
export const giveRigModel = (
  store: ControlStore,
  rig: string,
  choice: string,
  picked: Harness,
  effort?: Effort | undefined,
  by = "owner:ui",
  cap?: number | null,
  at?: number | null,
): { ok: string; contextWindow: number; compactAt: number | undefined } | { error: string } => {
  let harness = picked;
  const [pRaw, mRaw] = choice.split("|");
  let provider = "";
  let model = "";
  try {
    provider = decodeURIComponent(pRaw ?? "");
    model = decodeURIComponent(mRaw ?? "");
  } catch {
    // A malformed choice lists no model.
  }
  const p = store.modelProviders.get(provider);
  if (!p?.models.some((m) => m.id === model))
    return { error: "That provider does not list that model." };
  // A Claude subscription runs only in Claude Code, and Claude Code only on one.
  if (p.type === "claude") harness = "claude-code";
  else if (harness === "claude-code")
    return {
      // Codex too, where the provider is one Codex takes.
      error: `Claude Code runs only with a Claude subscription here: choose ${codexTakes(p.type) ? "Pi, OpenCode v2 or Codex" : "Pi or OpenCode v2"} for this provider.`,
    };
  // The Codex CLI speaks only OpenAI's Responses API.
  if (harness === "codex" && !codexTakes(p.type))
    return {
      error:
        "Codex runs only with a ChatGPT subscription or an OpenAI-compatible provider: choose Pi or OpenCode v2 for this provider.",
    };
  // OpenCode's free models (and a keyless OpenCode provider) need its own client.
  if (
    harness !== "opencode" &&
    isOpencodeOwn(p) &&
    (p.type === "opencode" || !p.key_sealed || model.endsWith("-free"))
  )
    return {
      error:
        "OpenCode's free models run only in the OpenCode harness: choose OpenCode v2 for this rig.",
    };
  const listed = p.models.find((m) => m.id === model)?.context_window ?? 0;
  const had = store.agentModels.byRig()[rig];
  const contextCap =
    cap === undefined
      ? had?.provider === provider && had.model === model
        ? had.contextCap
        : undefined
      : (cap ?? undefined);
  if (typeof cap === "number") {
    const refused = contextCapRefusal(model, listed, cap);
    if (refused) return { error: refused };
  }
  // The compaction point (goal 070), kept as the cap is.
  const compactAt =
    at === undefined
      ? had?.provider === provider && had.model === model
        ? had.compactAt
        : undefined
      : (at ?? undefined);
  if (typeof at === "number") {
    const refused = compactAtRefusal(at);
    if (refused) return { error: refused };
  }
  store.agentModels.assignRig(rig, { provider, model, harness, effort, contextCap, compactAt });
  store.auditLog.add(by, "rig_model_given", {
    rig,
    provider,
    model,
    harness,
    effort: effort ?? null,
    context_cap: contextCap ?? null,
    compact_at: compactAt ?? null,
  });
  const capped = capWords(listed, contextCap);
  return {
    ok: `${rig} takes ${model} from "${provider}" under ${HARNESS_NAMES[harness]} within a minute, and checks it.${capped ? ` Its context window: ${capped}.` : ""}${compactAt ? ` Its conversations are compacted at ${compactAtWords(compactAt)}.` : ""}`,
    contextWindow: cappedWindow(listed, contextCap),
    compactAt,
  };
};
/** Returns a rig's workers to the rig's own settings, as Providers and Edit rig both do. */
export const clearRigModel = (store: ControlStore, rig: string, by = "owner:ui") => {
  store.agentModels.assignRig(rig, null);
  store.auditLog.add(by, "rig_model_given", { rig, provider: null, model: null });
};
/**
 * Checks a model for one of a rig's other agents (or one of the teachers' models), as its row on
 * Edit rig does, or (an empty choice) its default again: the workers' model for the planner,
 * the one in the rig's advisors file for an advisor. Nothing changes here: applyAgentModel saves what this
 * allows. `harness` (goal 073): where it runs; left out (a line's Runs in on its empty choice, or
 * a form without it), the one it has while it keeps the same model, else what the model needs.
 * `cap` and `at`: the agent's own cap on its model's window and its compaction point (goal 070),
 * or null for none; left out (a form without the line's Context fields), the agent keeps its own
 * while it keeps the same model, as giveRigModel does for the workers.
 */
export type AgentModelPlan =
  | { role: AgentRole; clear: true }
  | {
      role: AgentRole;
      clear: false;
      provider: string;
      model: string;
      effort: Effort | undefined;
      harness: Harness;
      contextCap: number | undefined;
      compactAt: number | undefined;
      listed: number;
    };
export const checkAgentModel = (
  store: ControlStore,
  rig: string,
  role: AgentRole,
  choice: string,
  effort: Effort | undefined,
  picked?: Harness | undefined,
  cap?: number | null,
  at?: number | null,
): AgentModelPlan | { error: string } => {
  if (!choice) return { role, clear: true };
  const [pRaw, mRaw] = choice.split("|");
  let provider = "";
  let model = "";
  try {
    provider = decodeURIComponent(pRaw ?? "");
    model = decodeURIComponent(mRaw ?? "");
  } catch {
    // A malformed choice lists no model.
  }
  const p = store.modelProviders.get(provider);
  if (!p?.models.some((m) => m.id === model))
    return { error: `That provider does not list that model (${ROLE_WORDS[role].label}).` };
  const had = store.agentModels.byRole(rig)[role];
  const same = had?.provider === provider && had.model === model;
  const harness = picked ?? (had?.harness && same ? had.harness : neededHarness(p, model));
  const refusedHarness = harnessRefusal(p, model, harness, ROLE_WORDS[role].who);
  if (refusedHarness) return { error: refusedHarness };
  // The agent's own cap and compaction point (goal 070), checked and kept as the workers' are.
  const listed = p.models.find((m) => m.id === model)?.context_window ?? 0;
  const contextCap = cap === undefined ? (same ? had.contextCap : undefined) : (cap ?? undefined);
  if (typeof cap === "number") {
    const refused = contextCapRefusal(model, listed, cap);
    if (refused) return { error: refused };
  }
  const compactAt = at === undefined ? (same ? had.compactAt : undefined) : (at ?? undefined);
  if (typeof at === "number") {
    const refused = compactAtRefusal(at);
    if (refused) return { error: refused };
  }
  return {
    role,
    clear: false,
    provider,
    model,
    effort,
    harness,
    contextCap,
    compactAt,
    listed,
  };
};
/**
 * Saves what checkAgentModel allowed, with its record in the audit log. `ok` is Edit rig's words
 * for the change; `words` say the window and point in sentences, of `whose` model ("Its").
 */
export const applyAgentModel = (
  store: ControlStore,
  rig: string,
  plan: AgentModelPlan,
  by = "owner:ui",
  whose = "Its",
): { ok: string; contextWindow: number; compactAt: number | undefined; words: string } => {
  const role = plan.role;
  if (plan.clear) {
    store.agentModels.assignRole(rig, role, null);
    store.auditLog.add(by, "agent_model_given", { rig, role, provider: null, model: null });
    return { ok: ROLE_WORDS[role].cleared, contextWindow: 0, compactAt: undefined, words: "" };
  }
  const { provider, model, effort, harness, contextCap, compactAt, listed } = plan;
  store.agentModels.assignRole(rig, role, {
    provider,
    model,
    effort,
    harness,
    contextCap,
    compactAt,
  });
  store.auditLog.add(by, "agent_model_given", {
    rig,
    role,
    provider,
    model,
    effort: effort ?? null,
    harness,
    context_cap: contextCap ?? null,
    compact_at: compactAt ?? null,
  });
  const capped = capWords(listed, contextCap);
  return {
    ok: ROLE_WORDS[role].given,
    contextWindow: cappedWindow(listed, contextCap),
    compactAt,
    words: `${capped ? ` ${whose} context window: ${capped}.` : ""}${compactAt ? ` ${whose} conversations are compacted at ${compactAtWords(compactAt)}.` : ""}`,
  };
};

/**
 * Gives one of a rig's agents a model from a provider, or (clear) its default again, as that
 * agent's row on Edit rig does (goal 029): REST's POST /v1/rigs/<rig>/model and MCP's
 * set_rig_model. The workers' harness default: the model's. A cap on an agent's context window
 * and its compaction point (goal 070) are set anew by each call: none when left out.
 */
export async function setRigModel(
  store: ControlStore,
  rig: string,
  r: RigModelRequest,
  by: string,
): Promise<RigModelOutcome | { error: string }> {
  if (!store.reportedRigs.list().some((u) => u.id === rig)) return { error: `no rig ${rig}` };
  const shape = rigModelShapeRefusal(r);
  if (shape) return { error: shape };
  const agent = r.agent ?? "workers";
  const choice = r.clear
    ? ""
    : `${encodeURIComponent(r.provider ?? "")}|${encodeURIComponent(r.model ?? "")}`;
  if (agent === "workers") {
    if (!choice) {
      clearRigModel(store, rig, by);
      return {
        ok: `${rig} goes back to its own settings within a minute.`,
        contextWindow: null,
        agents: agentModelsOf(store, rig),
      };
    }
    // A harness named is refused in words when it cannot run the model (goal 073); none,
    // what the model needs.
    const wp = store.modelProviders.get(r.provider ?? "");
    if (wp && r.harness) {
      const refused = harnessRefusal(wp, r.model ?? "", r.harness, "the workers");
      if (refused) return { error: refused };
    }
    // MCP and REST set what they are asked: no context_window removes a cap, and no
    // compact_at a compaction point (the default applies).
    const given = giveRigModel(
      store,
      rig,
      choice,
      r.harness ?? harnessFor(store, choice, ""),
      r.effort,
      by,
      r.contextWindow ?? null,
      r.compactAt ?? null,
    );
    if ("error" in given) return given;
    return {
      ok: given.ok,
      contextWindow: given.contextWindow || null,
      compactAt: given.compactAt ?? null,
      agents: agentModelsOf(store, rig),
    };
  }
  // The other agents (goal 074): each place the request changes, the teachers' second and
  // merged by models too, all checked before any is saved. The harness named, else what the
  // model needs (goal 073): MCP and REST set what they are asked. So are each model's own cap
  // and point, set anew by each call as the workers' are (goal 070).
  const plans: AgentModelPlan[] = [];
  for (const change of rigModelChanges(r)) {
    if (change.role === "workers") continue;
    const c = change.choice;
    const cp = c ? store.modelProviders.get(c.provider) : undefined;
    const plan = c
      ? checkAgentModel(
          store,
          rig,
          change.role,
          `${encodeURIComponent(c.provider)}|${encodeURIComponent(c.model)}`,
          c.effort,
          c.harness ?? (cp ? neededHarness(cp, c.model) : undefined),
          c.contextWindow ?? null,
          c.compactAt ?? null,
        )
      : checkAgentModel(store, rig, change.role, "", undefined);
    if ("error" in plan) return plan;
    plans.push(plan);
  }
  // A second teacher needs a first one: given in this call, or one the teachers have.
  if (
    plans.some((p) => p.role === "second_teacher" && !p.clear) &&
    !plans.some((p) => p.role === "teachers" && !p.clear) &&
    !store.agentModels.byRole(rig).teachers
  )
    return {
      error:
        "The teachers have no model of their own yet: give a provider and a model for the first teacher too.",
    };
  // Several models in one call: the words say whose window and point each one is.
  const several = plans.filter((p) => !p.clear).length > 1;
  const given = plans.map((p) =>
    applyAgentModel(store, rig, p, by, several ? ROLE_WORDS[p.role].whose : "Its"),
  );
  // The model the call gave the agent itself (the first teacher's, for the teachers).
  const own = r.clear || !r.provider ? undefined : given[0];
  const said =
    r.agent === "teachers" && r.clear ? [ROLE_WORDS.teachers.cleared] : given.map((g) => g.ok);
  return {
    ok: `Control sent ${listText(said)} to ${rig}. The rig takes the change in less than one minute.${given.map((g) => g.words).join("")}`,
    contextWindow: own?.contextWindow || null,
    compactAt: own?.compactAt ?? null,
    agents: agentModelsOf(store, rig),
  };
}

/** Each of a rig's agents' models on control: MCP's rig_models, REST's GET of the same route. */
export const rigModels = (store: ControlStore, rig: string): AgentModels | { error: string } =>
  store.reportedRigs.list().some((u) => u.id === rig)
    ? agentModelsOf(store, rig)
    : { error: `no rig ${rig}` };
