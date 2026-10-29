/**
 * Control's live view as it comes in (goal 168): a rig's lines posted over HTTP (take.ts), or
 * folded from the message bus's live stream (bus.ts). Both check a batch the same way and keep
 * its lines in the store's live view, which the dashboard's Live pages read. The screens of the
 * trials the owner watches are held in memory beside it (screens.ts, goal 169).
 */

export {
  foldLive,
  followLive,
  LIVE_REFUSALS,
  type LiveFolded,
  type LiveIntake,
  type LiveRefusal,
  LiveTaken,
} from "./bus.ts";
export { type HeldFrame, Screens } from "./screens.ts";
export { takeLive } from "./take.ts";
