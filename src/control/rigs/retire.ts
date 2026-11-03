import type { ControlStore } from "../store/index.ts";
import { keepFolds } from "../views/index.ts";

/**
 * A retired rig brought back, as the owner asks on the dashboard, over REST or MCP. Its view's
 * fold is made ready first, from the folds control keeps or read from the message bus's events
 * stream, so its first view after is whole. False when the rig is not retired.
 */
export async function bringBackRig(store: ControlStore, rig: string, by: string): Promise<boolean> {
  if (!store.retired.get(rig)) return false;
  await keepFolds(store).restore(rig);
  return store.retired.bringBack(rig, by);
}
