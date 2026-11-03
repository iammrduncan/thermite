import type { DatabaseSync } from "node:sqlite";
import { KbOutcome } from "../../../core/kb/index.ts";
import { bodyKeys, currentNoteKind } from "../../../core/names.ts";
import { campaignAbout, contextOf, indexItem, unindexItem } from "./words.ts";

/** A source note's ref in a run's records slot (core/kb/records.ts). */
const SOURCE_NOTE_REF = "rn-%";

/** An item's or a version's sub-kind and fields under the public names. */
function current(
  ref: string,
  kind: string,
  sub: string | null,
  meta: string,
): { sub: string | null; meta: string } {
  let s = sub;
  if (kind === "note" && sub !== null) s = /^rn-/.test(ref) ? "source_note" : currentNoteKind(sub);
  const m = JSON.parse(meta) as Record<string, unknown>;
  const old = bodyKeys("direction").filter((k) => k !== "direction" && k in m);
  if (!old.length) return { sub: s, meta };
  const fields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(m)) fields[old.includes(k) ? "direction" : k] = v;
  return { sub: s, meta: JSON.stringify(fields) };
}

/**
 * Store migration 28: the public names in the knowledge base (the guide's questions 11 and 23,
 * owner, 2026-10-26). A field note's kind `note` is `other`; a research note is a source note
 * (its sub-kind `source_note`); an experiment's direction is kept as `direction`, not `family`.
 * Each item's context in the words index follows its sub-kind. The trigger that keeps versions
 * unchanged steps aside for these names only, as for migration 26's slots: no version's text,
 * file or link changes. The rigs' events keep their words; core/names.ts reads them under these.
 */
export function knowledgePublicNames(db: DatabaseSync): void {
  type Row = {
    id: number;
    campaign: string;
    run: string;
    slot: string;
    kind: string;
    ref: string;
    sub: string | null;
    meta: string;
    outcome: string | null;
    body: string;
  };
  const items = db
    .prepare(
      `select id, campaign, run, slot, kind, ref, sub, meta, outcome, body from kb_item
       where (kind = 'note' and (sub = 'note' or ref like ?)) or meta like '%"family"%'`,
    )
    .all(SOURCE_NOTE_REF) as unknown as Row[];
  const set = db.prepare("update kb_item set sub = ?, meta = ?, context = ? where id = ?");
  const about = new Map<string, string>();
  for (const x of items) {
    const now = current(x.ref, x.kind, x.sub, x.meta);
    if (now.sub === x.sub && now.meta === x.meta) continue;
    if (!about.has(x.campaign)) about.set(x.campaign, campaignAbout(db, x.campaign));
    const context = contextOf(x, {
      outcome: KbOutcome.safeParse(x.outcome).data ?? null,
      sub: now.sub,
      about: about.get(x.campaign) ?? "",
    });
    unindexItem(db, x.id);
    set.run(now.sub, now.meta, context, x.id);
    indexItem(db, x.id, x.body);
  }
  const versions = db
    .prepare(
      `select v.item, v.version, i.kind, i.ref, v.sub, v.meta from kb_version v
       join kb_item i on i.id = v.item
       where (i.kind = 'note' and (v.sub = 'note' or i.ref like ?)) or v.meta like '%"family"%'`,
    )
    .all(SOURCE_NOTE_REF) as {
    item: number;
    version: number;
    kind: string;
    ref: string;
    sub: string | null;
    meta: string;
  }[];
  const setVersion = db.prepare(
    "update kb_version set sub = ?, meta = ? where item = ? and version = ?",
  );
  db.exec("drop trigger if exists kb_version_never_changed");
  for (const v of versions) {
    const now = current(v.ref, v.kind, v.sub, v.meta);
    if (now.sub !== v.sub || now.meta !== v.meta)
      setVersion.run(now.sub, now.meta, v.item, v.version);
  }
  db.exec(
    "create trigger kb_version_never_changed before update on kb_version begin select raise(abort, 'a version of an item is never changed'); end",
  );
}
