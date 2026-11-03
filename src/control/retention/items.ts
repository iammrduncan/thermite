import { copiesOf } from "../../common/db-copy.ts";
import { folderBytes } from "../../common/fs.ts";
import {
  onRigs,
  perRig,
  type RetentionItem,
  type RetentionKind,
  type RetentionSpec,
  unpackItems,
} from "../../core/retention/index.ts";
import { eventDaysOf } from "../events/index.ts";
import type { ControlStore } from "../store/index.ts";

/**
 * What a policy acts on: the rigs it covers, and the items of its kind there, as wouldRemove
 * (core/retention/) reads them. Control reads its own kinds now; a rig's kinds come from what
 * the rig last said it keeps (its `space` ask, store/retention.ts).
 */

/** Where a policy acts: its kind, and which rigs. */
type PolicyWhere = Pick<RetentionSpec, "kind" | "where" | "rigs" | "campaigns">;

/** Whether control knows a rig: one that reported, or one it enrolled. */
export const knownRig = (store: ControlStore, rig: string): boolean =>
  store.reportedRigs.listed(rig) || store.enrollments.knownRig(rig);

/**
 * The rigs a policy covers, sorted: every rig control knows that is not retired, the rigs it
 * names, or every rig that ran one of its campaigns. A kind kept on control covers none.
 */
export function rigsOf(store: ControlStore, p: PolicyWhere): string[] {
  if (!perRig(p.kind)) return [];
  const retired = (rig: string) => store.retired.get(rig) !== undefined;
  let rigs: string[];
  if (p.where === "all") rigs = store.reportedRigs.list().map((r) => r.id);
  else if (p.where === "rigs") rigs = [...p.rigs];
  else rigs = p.campaigns.flatMap((c) => store.runRegistry.ofCampaign(c).map((r) => r.rig));
  return [...new Set(rigs)].filter((r) => !retired(r)).sort();
}

/** A store copy's time from its name ("2026-10-31T10-00-00-000Z") as ISO 8601. */
const stampAt = (stamp: string) =>
  stamp.replace(/T(\d\d)-(\d\d)-(\d\d)-(\d{3})Z$/, "T$1:$2:$3.$4Z");

/** The items of a kind kept on control, read now. */
export function controlItems(store: ControlStore, kind: RetentionKind): RetentionItem[] {
  if (kind === "kb_versions")
    return store
      .kb()
      .olderVersions()
      .map((v) => ({
        id: `${v.item}:${v.version}`,
        rig: null,
        run: v.run,
        at: v.at,
        bytes: v.bytes,
        count: 1,
      }));
  if (kind === "store_copies")
    return store.path === ":memory:"
      ? []
      : copiesOf(store.path).map((c) => ({
          id: c.path,
          rig: null,
          run: null,
          at: stampAt(c.stamp),
          bytes: folderBytes(c.path),
          count: 1,
        }));
  if (kind === "audit")
    return store.auditLog
      .retentionItems()
      .map((e) => ({ id: String(e.id), rig: null, run: null, at: e.at, bytes: e.bytes, count: 1 }));
  return [];
}

/** A policy's items: on control, or on its rigs as they last said, with the rigs that never did. */
interface PolicyItems {
  items: RetentionItem[];
  rigs: string[];
  /** Rigs it covers that have not said what they keep: their items are not counted. */
  unreported: string[];
  /** When the oldest of its rigs' words was read; null on control. */
  read_at: string | null;
}

export function itemsOf(store: ControlStore, p: PolicyWhere): PolicyItems {
  if (p.kind === "events") {
    // Control's copy of its rigs' events, by subject, rig and day, as its apply holds it.
    const rigs = rigsOf(store, p);
    const days = eventDaysOf(store);
    if (!days) return { items: [], rigs, unreported: rigs, read_at: null };
    return { items: days.items(new Set(rigs)), rigs, unreported: [], read_at: null };
  }
  if (!onRigs(p.kind))
    return { items: controlItems(store, p.kind), rigs: [], unreported: [], read_at: null };
  const rigs = rigsOf(store, p);
  const spaces = store.retention.spaces();
  const items: RetentionItem[] = [];
  const unreported: string[] = [];
  let readAt: string | null = null;
  for (const rig of rigs) {
    const s = spaces.get(rig);
    const inv = s?.kinds[p.kind];
    if (!s || !inv) {
      unreported.push(rig);
      continue;
    }
    if (!readAt || s.read_at < readAt) readAt = s.read_at;
    items.push(...unpackItems(rig, inv));
  }
  return { items, rigs, unreported, read_at: readAt };
}
