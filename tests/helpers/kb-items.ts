import type { KbItem } from "../../src/control/kb/index.ts";
import { sqliteBehind } from "../../src/control/store/behind.ts";
import type { ControlStore } from "../../src/control/store/index.ts";
import { itemOf } from "../../src/control/store/kb/items.ts";

/** Every item of the given collections, in the order of their seqs, as the store reads each. */
export function itemsBySeq(store: ControlStore, campaigns: string[]): KbItem[] {
  const marks = campaigns.map(() => "?").join(", ");
  return (
    sqliteBehind(store)
      .db.prepare(`select * from kb_item where campaign in (${marks}) order by seq`)
      .all(...campaigns) as Record<string, unknown>[]
  ).map(itemOf);
}
