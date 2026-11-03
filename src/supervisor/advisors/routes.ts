import { EFFORTS } from "../../core/agents.ts";
import { TEACHERS_MAX } from "../../core/api/control/rigs.ts";
import { COMPACT_AT_MAX, COMPACT_AT_MIN } from "../../core/compaction.ts";
import type { AdvisorRoute, AdvisorRoutesValue } from "../../core/link/config.ts";
import { type AdvisorRuntime, AdvisorsConfig, type RunningAdvisors } from "./config.ts";

/**
 * The advisors' models that control gives a rig (the owner's choice for each role on the rig's
 * Edit page, or over MCP and REST), as runtimes the supervisor runs. A role control gives a model
 * replaces the supervisor's own configuration for that role; a role it gives none keeps it. Each
 * runs in the harness its route names (goal 073): Pi here with read-only tools, Claude Code (a
 * Claude subscription, and only it), OpenCode v2 (OpenCode's own models too) or the Codex CLI.
 * A ChatGPT sign-in's access token lasts an hour; control's routes come in the rig's config on the
 * message bus, taken as control writes them.
 *
 * The roles (goal 074): the teachers (one or two models), their merged by model, the auditor and
 * the review panel; and (goal 166) the synthesizer and the final writer, which with no model from
 * control use the first teacher's.
 */

/** A route as control hands it (core/link/config.ts); its key stays in memory. */
export type { AdvisorRoute };

export interface ControlAdvisors {
  teachers?: AdvisorRuntime[] | undefined;
  merged_by?: AdvisorRuntime | undefined;
  auditor?: AdvisorRuntime | undefined;
  review_panel?: AdvisorRuntime[] | undefined;
  synthesizer?: AdvisorRuntime | undefined;
  final_writer?: AdvisorRuntime | undefined;
}

/** A compaction point a route carries, when it is a whole percent in range. */
const pointOf = (route: AdvisorRoute) =>
  Number.isInteger(route.compact_at) &&
  (route.compact_at as number) >= COMPACT_AT_MIN &&
  (route.compact_at as number) <= COMPACT_AT_MAX
    ? route.compact_at
    : undefined;

/**
 * One role's runtime from its route, or undefined when advisors can't run it. The route's window
 * and compaction point go with it (goal 070): Pi compacts the call's conversation with them, and
 * Claude Code, OpenCode and Codex get them in their own settings. So does its provider's name,
 * which the role's model usage is recorded with (goal 075).
 */
export function runtimeOf(route: AdvisorRoute, name: string): AdvisorRuntime | undefined {
  const compactAt = pointOf(route);
  if (route.type === "claude")
    return {
      name,
      provider: route.name,
      runtime: "claude-code",
      model: route.model,
      token: route.api_key,
      effort: EFFORTS.find((e) => e === route.effort),
      ...(route.context_window > 0 ? { context_window: route.context_window } : {}),
      ...(compactAt !== undefined ? { compact_at: compactAt } : {}),
    };
  const reasoning = route.reasoning;
  const effort =
    reasoning === "low" || reasoning === "medium" || reasoning === "high" ? reasoning : undefined;
  // OpenCode v2: the provider's API through a proxy for the call; OpenCode's own models with no key.
  if (route.harness === "opencode") {
    if (route.type === "opencode")
      return {
        name,
        provider: route.name,
        runtime: "opencode",
        api: "opencode",
        model: route.model,
        context_window: route.context_window,
        ...(compactAt !== undefined ? { compact_at: compactAt } : {}),
      };
    if (route.type !== "openai" && route.type !== "anthropic" && route.type !== "chatgpt")
      return undefined;
    return {
      name,
      provider: route.name,
      runtime: "opencode",
      api: route.type,
      base_url: route.base_url,
      model: route.model,
      api_key: route.api_key,
      context_window: route.context_window,
      ...(compactAt !== undefined ? { compact_at: compactAt } : {}),
    };
  }
  // The Codex CLI: OpenAI's Responses API only.
  if (route.harness === "codex") {
    if (route.type !== "openai" && route.type !== "chatgpt") return undefined;
    return {
      name,
      provider: route.name,
      runtime: "codex",
      api: route.type,
      base_url: route.base_url,
      model: route.model,
      api_key: route.api_key,
      reasoning: effort,
      context_window: route.context_window,
      ...(compactAt !== undefined ? { compact_at: compactAt } : {}),
    };
  }
  if (route.type !== "openai" && route.type !== "anthropic" && route.type !== "chatgpt")
    return undefined;
  return {
    name,
    provider: route.name,
    runtime: "openai",
    api: route.type,
    base_url: route.base_url,
    model: route.model,
    api_key: route.api_key,
    reasoning: effort,
    context_window: route.context_window || 200_000,
    ...(compactAt !== undefined ? { compact_at: compactAt } : {}),
    // The model's maximum output from the provider's list; none known: none sent (goal 079).
    ...(route.max_tokens ? { max_tokens: route.max_tokens } : {}),
    // No turn or time limit on a call (goal 079): the advisors file can set them.
    usd_per_mtok_in: 0,
    usd_per_mtok_out: 0,
  };
}

/**
 * Control's advisors' routes, from the rig's config on the message bus, as runtimes by role: each teacher's model (teacher-1 and teacher-2), the merged by model, the
 * auditor, the review panel three times (reviewer-1 to reviewer-3), the synthesizer and the final
 * writer.
 */
export function advisorsOf(r: AdvisorRoutesValue): ControlAdvisors {
  const many = (route: AdvisorRoute | null | undefined, base: string, n: number) => {
    if (!route) return undefined;
    const list = Array.from({ length: n }, (_, i) => runtimeOf(route, `${base}-${i + 1}`)).filter(
      (x): x is AdvisorRuntime => x !== undefined,
    );
    return list.length ? list : undefined;
  };
  const teachers = (r.teacher_models ?? [])
    .slice(0, TEACHERS_MAX)
    .map((route, i) => runtimeOf(route, `teacher-${i + 1}`))
    .filter((x): x is AdvisorRuntime => x !== undefined);
  return {
    teachers: teachers.length ? teachers : undefined,
    merged_by: r.merged_by ? runtimeOf(r.merged_by, "merged-by") : undefined,
    auditor: r.auditor ? runtimeOf(r.auditor, "auditor") : undefined,
    review_panel: many(r.review_panel, "reviewer", 3),
    synthesizer: r.synthesizer ? runtimeOf(r.synthesizer, "synthesizer") : undefined,
    final_writer: r.final_writer ? runtimeOf(r.final_writer, "final-writer") : undefined,
  };
}

/** The supervisor's configuration with control's roles over it; undefined when no role has an advisor. */
export function mergeAdvisors(
  file: AdvisorsConfig | undefined,
  control: ControlAdvisors,
): RunningAdvisors | undefined {
  const base = file ?? AdvisorsConfig.parse({});
  const merged: RunningAdvisors = {
    ...base,
    teachers: control.teachers ?? base.teachers,
    merged_by: control.merged_by ?? base.merged_by,
    auditor: control.auditor ?? base.auditor,
    review_panel: control.review_panel ?? base.review_panel,
    // Only from control: with none, each uses the first teacher's model.
    synthesizer: control.synthesizer,
    final_writer: control.final_writer,
  };
  return merged.teachers.length ||
    merged.merged_by ||
    merged.auditor ||
    merged.review_panel.length ||
    merged.synthesizer ||
    merged.final_writer
    ? merged
    : undefined;
}
