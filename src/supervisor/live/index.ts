import type { z } from "zod";
import { ApiError } from "../../common/api/call.ts";
import { controlClient } from "../../common/api/control.ts";
import { harnessClient } from "../../common/api/harness.ts";
import { log } from "../../common/env.ts";
import { LIVE as LIVE_TO_CONTROL } from "../../core/api/control/rigs.ts";
import { LIVE, LIVE_PAGE_DEFAULT } from "../../core/api/harness/supervisor.ts";
import type { AnswerOf } from "../../core/api/route.ts";
import { untoldKinds } from "../../core/kb.ts";
import { LiveLog } from "../../core/live.ts";

export { type LiveBusConfig, LiveCounts, publishLiveOnce } from "./bus.ts";
export { relayScreens, relayScreensOnce, type ScreensRelayConfig } from "./screens.ts";

/**
 * The live relay: every few seconds, the harness's newest live-log lines (signed by the harness)
 * go to control, with the supervisor's own lines (its advisors; unsigned, and labelled so). The
 * supervisor passes the harness's batch through untouched: it cannot sign for the harness. With
 * the message bus, they go there instead (bus.ts), and control takes them from the bus. The screens
 * of the trials someone watches go over HTTP either way (screens.ts).
 */
export interface LiveRelayConfig {
  rig: string;
  harnessUrl: string;
  harnessToken: string;
  controlUrl?: string | undefined;
  controlToken?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
}

export interface LiveRelayState {
  logId?: string | undefined;
  cursor: number;
  /** The supervisor's own lines already sent. */
  ownCursor: number;
}

/** The supervisor's own live lines (its advisors), relayed unsigned. */
export const supervisorLive = new LiveLog({ max: 1000 });

/** The supervisor's own lines one call carries, within the most control takes (OWN_LINES_MAX). */
export const OWN_LINES_PER_CALL = 200;

export async function relayLiveOnce(
  cfg: LiveRelayConfig,
  state: LiveRelayState,
): Promise<LiveRelayState> {
  if (!cfg.controlUrl || !cfg.controlToken) return state;
  const harness = harnessClient({
    url: cfg.harnessUrl,
    token: cfg.harnessToken,
    fetchImpl: cfg.fetchImpl,
  });
  const control = controlClient({
    url: cfg.controlUrl,
    token: cfg.controlToken,
    rig: cfg.rig,
    fetchImpl: cfg.fetchImpl,
  });
  let limit = LIVE_PAGE_DEFAULT;
  const get = (after: number) => harness.call(LIVE, { query: { after, limit } });
  let cursor = state.cursor;
  let batch = await get(cursor);
  if (state.logId !== undefined && batch.log_id !== state.logId && cursor !== 0) {
    // The controller restarted: its live log started again.
    cursor = 0;
    batch = await get(0);
  }
  let own = supervisorLive.since(state.ownCursor, OWN_LINES_PER_CALL);
  if (!batch.entries.length && !own.entries.length && batch.log_id === state.logId) return state;
  let answer: AnswerOf<typeof LIVE_TO_CONTROL>;
  for (;;) {
    try {
      answer = await control.call(LIVE_TO_CONTROL, {
        body: {
          // Passed through untouched: the supervisor cannot sign for the harness.
          batch: batch as z.input<typeof LIVE_TO_CONTROL.body>["batch"],
          supervisor: { log_id: supervisorLive.id, entries: own.entries },
        },
      });
      break;
    } catch (err) {
      // Long lines past the most control takes in one call (LIVE_TO_CONTROL.maxBytes): fewer of
      // them in a call, halved until they fit, as a page of reports is.
      if (!(err instanceof ApiError) || err.code !== "too_large" || limit <= 1) throw err;
      limit = Math.floor(limit / 2);
      log(
        "supervisor",
        "live lines too large for one call; halving them",
        { lines: limit },
        "warn",
      );
      batch = await get(cursor);
      own = supervisorLive.since(state.ownCursor, Math.min(OWN_LINES_PER_CALL, limit));
    }
  }
  // Lines this control does not know (a newer harness's) are left out there: said once each.
  for (const [what, n] of untoldKinds(toldLeftOut, answer.left_out ?? {}))
    log("supervisor", "control left out live lines it does not know", { what, lines: n }, "warn");
  return { logId: batch.log_id, cursor: batch.next, ownCursor: own.next };
}

/** What control left out of the live view and was logged already. */
const toldLeftOut = new Set<string>();
