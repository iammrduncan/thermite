import { ApiError } from "../common/api/call.ts";
import { harnessClient } from "../common/api/harness.ts";
import { log } from "../common/env.ts";
import { MODEL_ROUTE_GET, MODEL_ROUTE_PUT } from "../core/api/harness/supervisor.ts";
import type { ControlRoute } from "../core/api/model-route.ts";
import type { AnswerOf } from "../core/api/route.ts";
import type { ConfigValue } from "../core/link/config.ts";

/**
 * The agents' model route comes from control: the owner sets it on the settings page, and control
 * keeps its key sealed. It comes in the rig's config on the message bus (config/), and the
 * supervisor hands it to its harness when it changed. It never logs or keeps the key. Only
 * control's explicit "no route" returns the agents to the rig's own settings.
 */
export interface RouteHand {
  harnessUrl: string;
  harnessToken: string;
  fetchImpl?: typeof fetch | undefined;
}

export type RouteSyncResult = "unchanged" | "set" | "cleared" | "no_agents";

/**
 * Hands the harness control's routes, the workers' and the planner's, when they differ from the
 * ones it holds.
 */
export async function handModelRoute(
  s: RouteHand,
  given: ConfigValue<"model-route">,
): Promise<RouteSyncResult> {
  const harness = harnessClient({
    url: s.harnessUrl,
    token: s.harnessToken,
    fetchImpl: s.fetchImpl,
  });
  // The planner's own route, when the owner gave the planner a model.
  const { route, planner = null } = given;
  let info: AnswerOf<typeof MODEL_ROUTE_GET>;
  try {
    info = await harness.call(MODEL_ROUTE_GET);
  } catch (err) {
    if (err instanceof ApiError && err.code === "not_found") return "no_agents";
    throw err;
  }
  const plannerSame = (info.planner_revision ?? null) === (planner?.revision ?? null);
  if (
    plannerSame &&
    (route
      ? info.source === "control" && info.revision === route.revision
      : info.source !== "control")
  )
    return "unchanged";
  // Control's routes, passed on untouched: the harness checks each whole.
  await harness.call(MODEL_ROUTE_PUT, {
    body: { route: route as ControlRoute | null, planner: planner as ControlRoute | null },
  });
  log("supervisor", route ? "model route handed to the harness" : "model route cleared", {
    name: route?.name ?? null,
    version: route?.version ?? null,
  });
  return route ? "set" : "cleared";
}
