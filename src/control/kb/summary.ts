import { KB_RECORDS, KB_WRITES_DEFAULT, kindsForSlot } from "../../core/kb.ts";
import type { ControlStore, KbListAt } from "../store/index.ts";
import { campaignModes, type RigView } from "../views/index.ts";
import type { KbFolder } from "./list.ts";
import { slotWriter } from "./read.ts";

/**
 * A place's summary (goal 176), as kb_list gives it beside its folders and items, for the
 * Knowledge page's info pane: what it holds in all (records, blurbs, files, older versions and
 * the bytes stored), and by level what a file manager's info pane says of a folder. A collection:
 * its campaign, mode, runs, slots across its runs, and its grants both ways. A run: its state,
 * what its agents search, and its slots. A slot: its writer, the kinds the campaign lets it
 * write, what it holds by kind, and the writes control refused it.
 */

/** How many of a slot's refused writes a summary names, the newest: `total` says how many in all. */
export const KB_REFUSALS_SHOWN = 20;

export function placeSummary(
  store: ControlStore,
  vs: readonly RigView[],
  at: KbListAt,
  place: KbFolder,
) {
  const kb = store.kb();
  const t = kb.totals(at);
  const base = {
    records: t.types.record ?? 0,
    blurbs: t.types.blurb ?? 0,
    files: t.types.file ?? 0,
    older_versions: t.older_versions,
    stored_bytes: t.stored_bytes,
    updated_at: place.updated_at,
  };
  const { campaign, run, slot } = at;
  const slots = Object.entries(t.slots).map(([name, items]) => ({ name, items }));
  if (campaign === undefined) return { level: "knowledge_base" as const, ...base };
  if (run === undefined)
    return {
      level: "collection" as const,
      ...base,
      campaign,
      mode: campaignModes(store, [...vs]).get(campaign) ?? null,
      archived: place.archived === true,
      runs: kb.folders(at).length,
      slots,
      reads: kb.reads(campaign),
      read_by: kb.readBy(campaign),
    };
  if (slot === undefined) {
    const { scope } = kb.scopeWhere(campaign, run);
    const view = vs
      .flatMap((u) => u.runs.map((r) => ({ rig: u.id, r })))
      .find((x) => x.r.id === run);
    return {
      level: "run" as const,
      ...base,
      status: view?.r.status ?? null,
      rig: view?.rig ?? store.runRegistry.rigsOf(run)[0] ?? null,
      // What its agents search: its own run alone, or its collection, and the grants it includes.
      searches: { collection: campaign, own_run_only: scope.fresh, granted: scope.granted },
      slots,
    };
  }
  const rig = store.runRegistry.rigsOf(run)[0];
  const writer = slotWriter(store, { run, slot, ...(rig ? { rig } : {}) });
  // The kinds control's check of a write lets the slot write (events/knowledge.ts).
  const writes =
    slot === KB_RECORDS
      ? null
      : kindsForSlot(
          (rig ? store.commands.assignedKbWrites(rig, run) : undefined) ?? KB_WRITES_DEFAULT,
          slot,
        );
  return {
    level: "slot" as const,
    ...base,
    writer,
    writes,
    kinds: t.kinds,
    refused: store.auditLog.kbRefusals(run, slot, KB_REFUSALS_SHOWN),
  };
}
export type KbSummary = ReturnType<typeof placeSummary>;
