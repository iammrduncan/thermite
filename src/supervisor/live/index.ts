import { LiveLog } from "../../core/live.ts";

export { type LiveBusConfig, LiveCounts, publishLiveOnce } from "./bus.ts";
export { relayScreens, relayScreensOnce, type ScreensRelayConfig } from "./screens.ts";

/**
 * The live view: every few seconds, the harness's newest live-log lines (signed by the harness)
 * are published on the message bus, with the supervisor's own lines (its advisors; unsigned, and
 * labelled so), and control takes them from there (bus.ts). The supervisor passes the harness's
 * lines through untouched: it cannot sign for the harness. The screens of the trials someone
 * watches go on the bus too, only while watched (screens.ts).
 */

export interface LiveRelayState {
  logId?: string | undefined;
  cursor: number;
  /** The supervisor's own lines already sent. */
  ownCursor: number;
}

/** The supervisor's own live lines (its advisors), relayed unsigned. */
export const supervisorLive = new LiveLog({ max: 1000 });
