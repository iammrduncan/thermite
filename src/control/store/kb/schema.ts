import type { DatabaseSync } from "node:sqlite";
import { currentAddress, KB_SLOTS_BEFORE, KbOutcome } from "../../../core/kb.ts";
import { campaignAbout, contextOf, indexItem, unindexItem } from "./words.ts";

/**
 * The tables of control's knowledge base (store/kb/index.ts), and its hierarchy (goal 175): the
 * store's migration 14, which the knowledge base also runs as it opens its tables, so a store
 * that waits at an older version for the move of its events table (store/schema.ts) has the
 * hierarchy before the apply of the events stream writes its first item. It runs once: a store
 * with collections has it.
 */

/** The trigger that keeps every version of an item as it was written. */
const NEVER_CHANGED = `
create trigger kb_version_never_changed before update on kb_version
begin select raise(abort, 'a version of an item is never changed'); end;`;

/**
 * The tables as goals 065 and 162 left them: made empty in a store that never had them. The table
 * of a grant's copies, `kb_grant_item`, which v0.1.0 made, is no longer made: knowledgeSlotNames
 * removes it from a store that has it.
 */
const BEFORE = `
create table if not exists kb_item (
  id integer primary key autoincrement,
  seq integer not null,
  campaign text not null,
  rig text not null,
  ledger text not null,
  run text not null,
  kind text not null,
  ref text not null,
  title text not null,
  body text not null,
  by text not null,
  url text,
  sub text,
  meta text not null default '{}',
  at text not null,
  updated_at text not null,
  unique (rig, ledger, run, kind, ref)
);
create table if not exists kb_run (
  rig text not null,
  ledger text not null,
  run text not null,
  campaign text not null,
  primary key (rig, ledger, run)
);
-- seq: the seq in control's events table of the last event indexed from it, before the apply of
-- the events stream fed the knowledge base (it no longer moves); item_seq: the last seq given to
-- an item's version.
create table if not exists kb_cursor (
  id integer primary key check (id = 1),
  seq integer not null,
  item_seq integer not null
);
insert or ignore into kb_cursor (id, seq, item_seq) values (1, 0, 0);
-- The grants: each campaign that may read another's collection, read only.
create table if not exists kb_read (
  campaign text not null,
  reads text not null,
  granted_by text not null,
  granted_at text not null,
  primary key (campaign, reads)
);
-- What the items were read with: the reading's version (see READING).
create table if not exists kb_meta (key text primary key, value text not null);
`;

/**
 * The items, each in its run's slot, with its newest version's words; seq and id as they were, so
 * the rigs' cursors keep their meaning. Every item before the hierarchy is Thermite's code's: the
 * records slot of its run, as version 1.
 */
const ITEMS = `
create table kb_item_175 (
  id integer primary key autoincrement,
  -- Given anew with each version: what a rig's sync reads after (kb_cursor.item_seq).
  seq integer not null,
  campaign text not null,
  rig text not null,
  -- The rig's ledger: after a reset, its new runs' items never mix with the old ones.
  ledger text not null,
  run text not null,
  -- Where its writer writes in the run: records (Thermite's code), or an agent's role and lane.
  slot text not null,
  kind text not null,
  -- Its id in its slot: a record's id in the run, or an agent's item's number.
  ref text not null,
  -- Its newest version; the older ones are in kb_version.
  version integer not null,
  title text not null,
  body text not null,
  by text not null,
  url text,
  sub text,
  meta text not null default '{}',
  -- A file item's file, kept once by its SHA-256 (kb_file once control has it).
  file_sha256 text,
  file_name text,
  file_type text,
  file_bytes integer,
  at text not null,
  updated_at text not null,
  unique (rig, ledger, run, slot, kind, ref)
);
insert into kb_item_175 (id, seq, campaign, rig, ledger, run, slot, kind, ref, version, title,
  body, by, url, sub, meta, at, updated_at)
select id, seq, campaign, rig, ledger, run, 'records', kind, ref, 1, title, body, by, url, sub,
  meta, at, updated_at from kb_item;
drop table kb_item;
alter table kb_item_175 rename to kb_item;
create index kb_item_campaign on kb_item (campaign, kind);
create index kb_item_seq on kb_item (campaign, seq);
create index kb_item_file on kb_item (file_sha256) where file_sha256 is not null;

-- Every version of every item, the newest too. None is ever changed or removed.
create table kb_version (
  item integer not null,
  version integer not null,
  title text not null,
  body text not null,
  by text not null,
  url text,
  sub text,
  meta text not null default '{}',
  file_sha256 text,
  file_name text,
  file_type text,
  file_bytes integer,
  -- The kb_item event of the rig's ledger that wrote it; null for a record, which the run's
  -- events make.
  event integer,
  at text not null,
  primary key (item, version)
);
${NEVER_CHANGED}
create trigger kb_version_never_removed before delete on kb_version
begin select raise(abort, 'a version of an item is never removed'); end;
insert into kb_version (item, version, title, body, by, url, sub, meta, at)
select id, 1, title, body, by, url, sub, meta, updated_at from kb_item;

-- A version's links to other items, by their addresses (core/kb.ts): supports, contradicts,
-- follows. A link names an address as its writer gave it, found or not.
create table kb_link (
  item integer not null,
  version integer not null,
  rel text not null,
  target text not null,
  primary key (item, version, rel, target)
);
create index kb_link_target on kb_link (target);

-- The files control holds, each once by its SHA-256, in its state (control/kb/files.ts).
create table kb_file (
  sha256 text primary key,
  bytes integer not null,
  stored_at text not null
);

-- One collection for each campaign, made with the campaign.
create table kb_collection (
  campaign text primary key,
  made_at text not null
);

-- What a run reads (goal 175, step 4): its campaign's whole collection, or its own run alone when
-- it starts fresh, and the granted collections it includes (JSON). No row: the whole collection
-- and every grant.
create table kb_scope (
  campaign text not null,
  run text not null,
  fresh integer not null check (fresh in (0, 1)),
  granted text not null default '[]',
  set_by text not null,
  set_at text not null,
  primary key (campaign, run)
);

-- The words index of the items' newest versions, written with each item in its transaction.
create virtual table kb_words using fts5(
  title, body, content = 'kb_item', content_rowid = 'id',
  tokenize = 'porter unicode61 remove_diacritics 2'
);
create trigger kb_item_words_added after insert on kb_item begin
  insert into kb_words (rowid, title, body) values (new.id, new.title, new.body);
end;
create trigger kb_item_words_changed after update of title, body on kb_item begin
  insert into kb_words (kb_words, rowid, title, body) values ('delete', old.id, old.title, old.body);
  insert into kb_words (rowid, title, body) values (new.id, new.title, new.body);
end;
create trigger kb_item_words_removed after delete on kb_item begin
  insert into kb_words (kb_words, rowid, title, body) values ('delete', old.id, old.title, old.body);
end;
insert into kb_words (kb_words) values ('rebuild');
`;

const hasTable = (db: DatabaseSync, name: string) =>
  db.prepare("select 1 from sqlite_master where type = 'table' and name = ?").get(name) !==
  undefined;

/**
 * The knowledge base's hierarchy (goal 175): collections, runs, slots, items, versions, links,
 * files by SHA-256, grants (kb_read), a run's scope and the words index. Today's items move into
 * the records slot of their run, as version 1, with their ids and seqs, so a rig's cursor reads on
 * where it was; each campaign control knows gets its collection. Runs in the caller's transaction.
 */
export function knowledgeHierarchy(db: DatabaseSync): void {
  if (hasTable(db, "kb_collection")) return;
  db.exec(BEFORE);
  // An id once given is never given again, as autoincrement promised before the table was made anew.
  const ids = hasTable(db, "sqlite_sequence")
    ? (db.prepare("select seq from sqlite_sequence where name = 'kb_item'").get() as
        | { seq: number }
        | undefined)
    : undefined;
  db.exec(ITEMS);
  if (ids) {
    db.prepare("delete from sqlite_sequence where name = 'kb_item' and seq < ?").run(ids.seq);
    db.prepare(
      "insert into sqlite_sequence (name, seq) select 'kb_item', ? where not exists (select 1 from sqlite_sequence where name = 'kb_item')",
    ).run(ids.seq);
  }
  const now = new Date().toISOString();
  const made = db.prepare(
    "insert into kb_collection (campaign, made_at) values (?, ?) on conflict (campaign) do nothing",
  );
  const campaigns = (sql: string) =>
    db.prepare(sql).all() as { campaign: string; at: string | null }[];
  const known = [
    ...(hasTable(db, "campaign_version")
      ? campaigns("select campaign, min(created_at) as at from campaign_version group by campaign")
      : []),
    ...(hasTable(db, "run_registry")
      ? campaigns(
          `select campaign, min(coalesce(created_at, assigned_at)) as at from run_registry
           where campaign is not null group by campaign`,
        )
      : []),
    ...campaigns("select campaign, min(at) as at from kb_item group by campaign"),
    ...campaigns("select campaign, null as at from kb_run group by campaign"),
  ];
  for (const c of known) if (c.campaign) made.run(c.campaign, c.at ?? now);
}

/**
 * Store migration 26 (goal 175): the agents' slots take the agents' names (KB_SLOTS_BEFORE:
 * `teacher` is `teachers`, `merged-by` `merged_by`, `review-panel` `review_panel` and
 * `final-writer` `final_writer`), in every place the store keeps a slot: each item's slot, its
 * writer (`by`) and its context in the words index, the writer of each of its versions, and the
 * links that name its address. The trigger that keeps versions unchanged steps aside for that
 * one rename of their writer's spelling: no text, file or link of a version changes. And the table of a grant's copies
 * of another collection's items, which nothing has written since the rigs' copies of past research
 * went, goes. Runs in the migration's transaction.
 */
export function knowledgeSlotNames(db: DatabaseSync): void {
  db.exec("drop index if exists kb_grant_item_seq; drop table if exists kb_grant_item;");
  type Row = {
    id: number;
    campaign: string;
    run: string;
    kind: string;
    sub: string | null;
    outcome: string | null;
    body: string;
  };
  const items = db.prepare(
    "select id, campaign, run, kind, sub, outcome, body from kb_item where slot = ?",
  );
  const renamed = db.prepare(
    `update kb_item set slot = ?, by = case when by = ? then ? else by end, context = ?
     where id = ?`,
  );
  const about = new Map<string, string>();
  db.exec("drop trigger if exists kb_version_never_changed");
  for (const [before, now] of KB_SLOTS_BEFORE) {
    for (const x of items.all(before) as unknown as Row[]) {
      if (!about.has(x.campaign)) about.set(x.campaign, campaignAbout(db, x.campaign));
      const outcome = KbOutcome.safeParse(x.outcome).data ?? null;
      const context = contextOf(
        { campaign: x.campaign, run: x.run, slot: now, kind: x.kind },
        { outcome, sub: x.sub, about: about.get(x.campaign) ?? "" },
      );
      unindexItem(db, x.id);
      renamed.run(now, before, now, context, x.id);
      indexItem(db, x.id, x.body);
    }
    db.prepare(
      "update kb_version set by = ? where by = ? and item in (select id from kb_item where slot = ?)",
    ).run(now, before, now);
  }
  db.exec(NEVER_CHANGED);
  // A link names an address as its writer gave it: one through a renamed slot names it anew.
  const links = db
    .prepare("select item, version, rel, target from kb_link where target like '%/%/%/%'")
    .all() as { item: number; version: number; rel: string; target: string }[];
  const relinked = db.prepare(
    "update or replace kb_link set target = ? where item = ? and version = ? and rel = ? and target = ?",
  );
  for (const l of links) {
    const target = currentAddress(l.target);
    if (target !== l.target) relinked.run(target, l.item, l.version, l.rel, l.target);
  }
}
