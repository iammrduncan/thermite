import { sha256Hex } from "../core/canonical.ts";
import type { ControlStore } from "./store/index.ts";
import { findRunOn } from "./views/index.ts";

/**
 * Champions' patches as rigs send them: a rig's supervisor uploads each champion's patch once the
 * rig has published it, and control keeps it only if it is the one the rig published (the
 * supervisor transports it; it cannot change it). The rig's signed champion_published event says
 * which: its run's view on the rig has it, in the ledger the run was created in. The owner reads a
 * patch under its run, from the ledger the run's view gives.
 */

/**
 * Keeps a champion's patch that a rig sent for its run of this name, if it is the newest one the
 * run published as champion `seq`. "not_published": control has no champion_published event for
 * it yet; "mismatch": its SHA-256 is not the published one.
 */
export async function keepChampionPatch(
  store: ControlStore,
  rig: string,
  run: string,
  seq: number,
  patch: Buffer,
): Promise<"stored" | "not_published" | "mismatch"> {
  const x = await findRunOn(store, rig, run);
  const pub = x?.run.published_patches.findLast((p) => p.seq === seq);
  if (!x || !pub) return "not_published";
  if (sha256Hex(patch) !== pub.sha256) return "mismatch";
  store.championPatches.put(rig, x.rig.ledger_id ?? "", run, seq, pub, patch);
  return "stored";
}
