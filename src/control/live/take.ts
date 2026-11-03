import { verifyJson } from "../../core/commands.ts";
import { type LiveBatchWire, liveBody } from "../../core/live.ts";
import type { ControlStore } from "../store/index.ts";

/** A batch of live lines as control reads it from the bus. */
export type LiveBatchRead = ReturnType<typeof LiveBatchWire.parse>;

/** Why a batch is not the harness's own, in the words the bus's counts use. */
export type HarnessRefusal =
  | "rig mismatch"
  | "the rig's report key is not accepted yet"
  | "live lines must be signed with the rig's pinned key"
  | "bad live signature";

/**
 * Whether a batch is the harness's own, for `rig`: the rig's, signed with the rig's pinned key.
 * The supervisor relays the harness's lines but cannot forge them. Undefined when it is; else the
 * status and words of the refusal.
 */
export function harnessRefusal(
  store: ControlStore,
  rig: string,
  b: LiveBatchRead,
): [403 | 409, HarnessRefusal] | undefined {
  if (b.rig !== rig) return [403, "rig mismatch"];
  const pinned = store.reportedRigs.key(rig).pubkey;
  if (!pinned) return [409, "the rig's report key is not accepted yet"];
  if (!b.signature || !b.rig_pubkey || b.rig_pubkey.trim() !== pinned.trim())
    return [409, "live lines must be signed with the rig's pinned key"];
  if (!verifyJson(liveBody(b), b.signature, pinned)) return [403, "bad live signature"];
  return undefined;
}
