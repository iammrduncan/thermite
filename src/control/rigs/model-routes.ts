import { CHATGPT_API } from "../../core/agents.ts";
import type { ControlRoute } from "../../core/api/model-route.ts";
import { sha256Hex } from "../../core/canonical.ts";
import type { ControlParts } from "../parts.ts";
import { cappedWindow, claudeModelName, isOpencodeOwn, providerBase } from "../providers/index.ts";
import {
  type AgentRole,
  codexTakes,
  type Effort,
  type Harness,
  type ModelProvider,
} from "../store/index.ts";
import { neededHarness } from "./model.ts";

/**
 * The model routes a rig's agents get from control, each with its provider's key or a
 * subscription's token: its workers' and its planner's, and its advisors' by role. Control writes
 * them to the rig's config on the message bus (bus/config.ts), sealed to the rig. The key is
 * opened only here, and nothing caches or logs it.
 */

/** What a route needs of control: its store, the box that opens keys, and ChatGPT's logins. */
export type RouteParts = Pick<ControlParts, "store" | "secrets" | "chatgpt">;

/**
 * A route as a rig receives it: the provider's endpoint and key (or a subscription's token, for
 * Claude Code only; or a ChatGPT login's access token, renewed here), the model and the harness
 * it runs in. Undefined when the key can't be opened or the login renewed. `cap`: the owner's
 * cap on the model's context window (goal 070), which the route carries when it is the lower.
 */
async function routeOf(
  parts: RouteParts,
  p: ModelProvider,
  model: string,
  harness: Harness,
  effort: Effort | null | undefined,
  cap?: number | undefined,
  compactAt?: number | undefined,
): Promise<ControlRoute | undefined> {
  // The compaction point (goal 070), only when the owner set one: a route without it keeps its
  // revision, and the harness applies its default.
  const compact = compactAt ? { compact_at: compactAt } : {};
  const compactRev = compactAt ? [`compact_at ${compactAt}`] : [];
  // Other providers take a reasoning effort up to high.
  const reasoning = effort ? (effort === "xhigh" || effort === "max" ? "high" : effort) : null;
  const contextWindow = cappedWindow(
    p.models.find((m) => m.id === model)?.context_window ?? 0,
    cap,
  );
  // The reply limit: the model's maximum output from the provider's list; 0, none sent and the
  // provider's own applies (goal 079).
  const maxOutput = p.models.find((m) => m.id === model)?.max_output ?? 0;
  const outputRev = maxOutput ? [`max_output ${maxOutput}`] : [];
  if (p.type === "chatgpt") {
    const access = await parts.chatgpt.access(p);
    if (typeof access !== "string") return undefined;
    return {
      name: p.name,
      type: "chatgpt",
      harness: harness === "opencode" || harness === "codex" ? harness : "pi",
      version: p.version,
      base_url: CHATGPT_API,
      model,
      context_window: contextWindow,
      ...compact,
      max_tokens: maxOutput,
      reasoning,
      key_hint: p.key_hint,
      // A renewed token is a new revision: the rig takes it on its next round. So is a cap.
      revision: sha256Hex(
        [
          p.name,
          "chatgpt",
          p.version,
          harness,
          model,
          reasoning ?? "",
          access,
          ...(cap ? [contextWindow] : []),
          ...compactRev,
          ...outputRev,
        ].join("\n"),
      ).slice(0, 16),
      api_key: access,
    };
  }
  let key = "";
  try {
    // OpenCode's own provider may have no key (its free models need none).
    if (p.key_sealed) key = parts.secrets.open(p.key_sealed);
  } catch {
    return undefined;
  }
  const base = providerBase(p.type, p.base_url);
  // A Claude subscription: its token, for Claude Code only, under Claude Code's model name.
  if (p.type === "claude")
    return {
      name: p.name,
      type: "claude",
      harness: "claude-code",
      version: p.version,
      base_url: base,
      model: claudeModelName(model),
      context_window: contextWindow,
      ...compact,
      max_tokens: maxOutput,
      reasoning: null,
      effort: effort ?? null,
      key_hint: p.key_hint,
      revision: sha256Hex(
        [
          p.name,
          "claude",
          p.version,
          model,
          contextWindow,
          effort ?? "",
          p.key_sealed,
          ...compactRev,
          ...outputRev,
        ].join("\n"),
      ).slice(0, 16),
      api_key: key,
    };
  // OpenCode's own provider, under the OpenCode harness, runs through OpenCode's built-in one:
  // it needs no key (its free models), so none is sent.
  const native = harness === "opencode" && isOpencodeOwn(p);
  if (native) key = "";
  return {
    name: p.name,
    type: native ? "opencode" : p.type === "opencode" ? "openai" : p.type,
    // Codex speaks only OpenAI's Responses API: an OpenAI-compatible key's provider.
    harness:
      harness === "claude-code" || (harness === "codex" && !codexTakes(p.type)) ? "pi" : harness,
    version: p.version,
    base_url: base,
    model,
    context_window: contextWindow,
    ...compact,
    max_tokens: maxOutput,
    reasoning,
    key_hint: p.key_hint,
    // Changes with anything about the route, even a provider deleted and made again.
    revision: sha256Hex(
      [
        p.name,
        p.type,
        native,
        harness,
        p.version,
        base,
        model,
        contextWindow,
        reasoning ?? "",
        p.key_sealed,
        ...compactRev,
        ...outputRev,
      ].join("\n"),
    ).slice(0, 16),
    api_key: key,
  };
}

/**
 * A rig's other agent's route (planner or an advisor), when the owner gave it a model, with the
 * agent's own cap on its window and its compaction point (goal 070), as the workers' route has.
 */
async function roleRouteOf(parts: RouteParts, rig: string, role: AgentRole) {
  const a = parts.store.agentModels.byRole(rig)[role];
  const p = a ? parts.store.modelProviders.get(a.provider) : undefined;
  if (!a || !p) return null;
  // The harness the owner chose for the agent (goal 073), else what its model needs: Claude
  // Code for a subscription, OpenCode for OpenCode's own models, else Pi.
  const harness = a.harness ?? neededHarness(p, a.model);
  return (await routeOf(parts, p, a.model, harness, a.effort, a.contextCap, a.compactAt)) ?? null;
}

/** The workers' route, or null when the rig has none (its own settings), and the planner's. */
export type ModelRoutes = { route: ControlRoute | null; planner: ControlRoute | null };

/**
 * The model route of the rig's agents and the planner's own, or, when the workers' provider's key
 * can't be opened or its ChatGPT login renewed, why, in words. The rig then keeps what it has.
 */
export async function modelRoutesOf(
  parts: RouteParts,
  rig: string,
): Promise<ModelRoutes | { error: string }> {
  const r = parts.store.agentModels.forRig(rig);
  const planner = await roleRouteOf(parts, rig, "planner");
  if (!r) return { route: null, planner };
  const route = await routeOf(
    parts,
    r.provider,
    r.model,
    r.harness,
    r.effort,
    r.contextCap,
    r.compactAt,
  );
  if (!route)
    return {
      error:
        r.provider.type === "chatgpt"
          ? "the ChatGPT login could not be renewed: sign in again on the Providers page"
          : "the provider's key cannot be opened: enter it again",
    };
  return { route, planner };
}

/**
 * The advisors' routes, by role, when the owner gave them models (each with its key or a
 * subscription's token). A role with none keeps the rig's advisors file: the supervisor's own
 * configuration. Goal 074: the teachers' one or two models (a second only with a first), their
 * merged by model, the auditor and the review panel. Goal 166: the synthesizer and the final
 * writer, which with none use the first teacher's model.
 */
export async function advisorRoutesOf(parts: RouteParts, rig: string) {
  const first = await roleRouteOf(parts, rig, "teachers");
  const second = first ? await roleRouteOf(parts, rig, "second_teacher") : null;
  return {
    teacher_models: first ? [first, ...(second ? [second] : [])] : [],
    merged_by: await roleRouteOf(parts, rig, "merged_by"),
    auditor: await roleRouteOf(parts, rig, "auditor"),
    review_panel: await roleRouteOf(parts, rig, "review_panel"),
    synthesizer: await roleRouteOf(parts, rig, "synthesizer"),
    final_writer: await roleRouteOf(parts, rig, "final_writer"),
  };
}
