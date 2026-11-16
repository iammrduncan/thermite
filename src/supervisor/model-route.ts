import { ApiError } from "../common/api/call.ts";
import { harnessClient } from "../common/api/harness.ts";
import { log } from "../common/env.ts";
import { MODEL_ROUTE_GET, MODEL_ROUTE_PUT } from "../core/api/harness/supervisor.ts";
import type { ControlRoute } from "../core/api/model-route.ts";
import type { AnswerOf } from "../core/api/route.ts";
import { sha256Hex } from "../core/canonical.ts";
import { rebaseGoogleRoute } from "../core/google-gemini.ts";
import type { ConfigValue } from "../core/link/config.ts";

/**
 * The agents' model route comes from control: the owner sets it on the settings page, and control
 * keeps its key sealed. It comes in the rig's config on the message bus (config/), and the
 * supervisor hands it to its harness when it changed, and again after the harness restarted: the
 * harness keeps it in memory only. It never logs or keeps the key. Only control's explicit "no
 * route" returns the agents to the rig's own settings.
 */
export interface RouteHand {
  harnessUrl: string;
  harnessToken: string;
  fetchImpl?: typeof fetch | undefined;
  /**
   * Control's address as the harness reaches it (harnessControl in settings.ts): a Gemini
   * account route goes to its bridge there. None: the address control gave.
   */
  harnessControl?: string | undefined;
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
  // The planner's own route, when the owner gave the planner a model. A Gemini API route
  // goes to control's bridge at the harness's own address for control (core/google-gemini.ts).
  const resolved = (raw: ConfigValue<"model-route">["route"]) => {
    if (!raw) return null;
    const moved = rebaseGoogleRoute(raw, s.harnessControl);
    // The control revision names its advertised route. Include the resolved destination so
    // a retained harness takes an address change after a supervisor upgrade or restart too.
    return moved.type === "google-gemini-api" && s.harnessControl !== undefined
      ? { ...moved, revision: sha256Hex(`${moved.revision}\n${moved.base_url}`).slice(0, 16) }
      : moved;
  };
  const route = resolved(given.route);
  const planner = resolved(given.planner ?? null);
  let info: AnswerOf<typeof MODEL_ROUTE_GET>;
  try {
    info = await harness.call(MODEL_ROUTE_GET);
  } catch (err) {
    if (err instanceof ApiError && err.code === "not_found") return "no_agents";
    throw err;
  }
  // A harness that restarted awaits its routes: they go again, though the bus's are the same.
  const plannerSame = (info.planner_revision ?? null) === (planner?.revision ?? null);
  if (
    !info.awaiting &&
    plannerSame &&
    (route
      ? info.source === "control" && info.revision === route.revision
      : info.source !== "control")
  )
    return "unchanged";
  // The harness checks each resolved route as a whole.
  await harness.call(MODEL_ROUTE_PUT, {
    body: { route: route as ControlRoute | null, planner: planner as ControlRoute | null },
  });
  log("supervisor", route ? "model route handed to the harness" : "model route cleared", {
    name: route?.name ?? null,
    version: route?.version ?? null,
  });
  return route ? "set" : "cleared";
}
