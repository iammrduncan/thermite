import type { DatabaseSync } from "node:sqlite";
import { transaction } from "../../../common/sqlite.ts";
import {
  type KbItemBody,
  type KbItemWire,
  type KbKind,
  type KbSync,
  readKbAddress,
  writtenRef,
} from "../../../core/kb.ts";
import { clip, KB_BODY_MAX, str } from "../../../core/kb-index.ts";
import {
  JOURNAL_KINDS,
  type KbCollection,
  type KbFound,
  type KbItem,
  SYNC_PAGE,
} from "../../kb/index.ts";
import { KbFileRows, KbSettingRows, keepFileText, knowledgeFiles } from "./files.ts";
import {
  itemOf,
  type KbVersion,
  keepVersion,
  linksTo,
  versionRefusal,
  versionsOf,
  writtenFields,
} from "./items.ts";
import { fieldNotesOf, runCountsOf } from "./journal.ts";
import {
  type KbFolderRow,
  type KbListAt,
  type KbListed,
  type KbListOptions,
  type KbTotals,
  listItems,
  placeFolders,
  placeTotals,
} from "./list.ts";
import { KbReading } from "./reading.ts";
import { knowledgeHierarchy } from "./schema.ts";
import { type KbScope, keepScope, scopeOf } from "./scope.ts";
import { findItems, type KbFind, type KbFindResult, type KbWhere } from "./search.ts";
import { type KbStoredFigures, storedFigures } from "./stored.ts";
import { knowledgeSearch } from "./words.ts";

export type {
  KbFileRow,
  KbFileText,
  KbSettingKey,
  KbSettingRow,
  KbTextDue,
} from "./files.ts";
export { knowledgeFiles } from "./files.ts";
export type { KbVersion } from "./items.ts";
export type {
  KbFolderRow,
  KbListAt,
  KbListCounts,
  KbListed,
  KbListOptions,
  KbTotals,
} from "./list.ts";
export { type KbSearchMode, OUTCOME_WORDS, searchTerms } from "./query.ts";
export { knowledgeHierarchy } from "./schema.ts";
export type { KbScope } from "./scope.ts";
export type { KbCounts, KbFind, KbPassage, KbWhere } from "./search.ts";
export type { KbStoredCollection, KbStoredFigures, KbStoredFile, KbTextState } from "./stored.ts";
export { KB_STORED_FILES } from "./stored.ts";
export { knowledgeSearch, passagesOf } from "./words.ts";
/** A search's answer: its page of hits, each a found item, and what search.ts says beside them. */
export type KbFindAnswer = Omit<KbFindResult, "found"> & { hits: KbFound[] };

/**
 * The knowledge base's tables in control's store (goals 065, 125 and 175): one collection for each
 * campaign, its runs, each run's slots and their items with every version, the files the items
 * name, the grants to read other collections, a run's scope, the words index, and its cursors
 * (store/kb/schema.ts). The apply of the events stream feeds it (control/events): Thermite's
 * reading of each event into the records slot of its run, and each writer's `kb_item` event into
 * the writer's own slot. What the knowledge base is, and its items' shape, are in control/kb/.
 */

type Row = Record<string, unknown>;

export class KnowledgeBase {
  private readonly db: DatabaseSync;
  /** The files it holds, each once by its SHA-256 (files.ts; control/kb/files.ts keeps them). */
  readonly files: KbFileRows;
  /** Its settings on control: the largest file, and how long an orphan file stays (files.ts). */
  readonly settings: KbSettingRows;

  /** Thermite's reading of the rigs' events into the records slots (reading.ts). */
  private readonly reader: KbReading;

  constructor(db: DatabaseSync) {
    this.db = db;
    this.files = new KbFileRows(db);
    this.settings = new KbSettingRows(db);
    this.reader = new KbReading(db, {
      nextSeq: () => this.nextSeq(),
      makeCollection: (campaign) => this.makeCollection(campaign),
    });
    // Store migrations 14, 17 and 23 run them; a store that waits at an older version for the move
    // of its events table has its hierarchy, words index and files' text here, before the apply
    // writes an item.
    transaction(db, () => {
      knowledgeHierarchy(db);
      knowledgeSearch(db);
      knowledgeFiles(db);
    });
  }

  /** Runs fn in one transaction: all of it is kept, or none of it. */
  private tx<T>(fn: () => T): T {
    return transaction(this.db, fn);
  }

  /** The next n item seqs (returns the last of them). */
  private nextSeq(n = 1): number {
    const r = this.db
      .prepare("update kb_cursor set item_seq = item_seq + ? where id = 1 returning item_seq")
      .get(n) as { item_seq: number };
    return Number(r.item_seq);
  }

  /**
   * Where the knowledge base was indexed from control's events table, before the apply of the
   * events stream fed it (goal 168): the table's seq of the last event indexed then. It no longer
   * moves. The apply indexes each event of the stream after it, by the seq its message carries, and
   * every event whose message carries none: so an event is indexed once, either way.
   */
  indexedFromTable(): number {
    return Number(
      (this.db.prepare("select seq from kb_cursor where id = 1").get() as { seq: number }).seq,
    );
  }

  /**
   * One event of a rig's ledger into the records slot of its run, in its campaign's collection
   * (reading.ts). `again`: an event read again after an upgrade (kindsToReadAgain).
   */
  index(
    src: { rig: string; ledger: string },
    e: { at: string; actor: string; kind: string; subject: string | null; body: unknown },
    o: { again?: boolean } = {},
  ): void {
    this.reader.index(src, e, o);
  }

  /** The kinds of event the knowledge base reads again, once, after an upgrade of its reading. */
  kindsToReadAgain(): string[] {
    return this.reader.kindsToReadAgain();
  }

  /** The events of kindsToReadAgain read again: the store is at its reading. */
  readAgainDone(): void {
    this.reader.readAgainDone();
  }

  private campaignOf(rig: string, ledger: string, run: string): string | undefined {
    return this.reader.campaignOf(rig, ledger, run);
  }

  /**
   * One writer's `kb_item` event, in its writer's slot of the event's run, in the collection
   * control filed the run in: a new item, or the next version of the writer's own item. The
   * caller checked that the run is the rig's and that the slot is the event's writer's
   * (control/events/knowledge.ts). Undefined once stored; else why it is refused, in words. In
   * the caller's transaction.
   */
  write(
    src: { rig: string; ledger: string; run: string; event?: number | undefined; at: string },
    b: KbItemBody,
  ): string | undefined {
    const { rig, ledger, run } = src;
    const campaign = this.campaignOf(rig, ledger, run);
    if (!campaign)
      return `run ${run} has no collection: control filed it under no campaign of its own`;
    const refused = versionRefusal(this.db, src, b);
    if (refused) return refused;
    const place = {
      campaign,
      rig,
      ledger,
      run,
      slot: b.slot,
      kind: b.kind,
      ref: writtenRef(b.slot, b.item),
    };
    const links = b.links.map((l) => ({ rel: l.rel, to: l.to }));
    // A file whose text control has already gives it to the item's row for the words index.
    const fileText = b.file ? this.files.text(b.file.sha256) : undefined;
    keepVersion(
      this.db,
      this.nextSeq(),
      place,
      { ...writtenFields(b), fileText },
      {
        at: src.at,
        event: src.event,
        links,
      },
    );
    return undefined;
  }

  /** A campaign's collection, made with the campaign; nothing when it has one. */
  makeCollection(campaign: string, at = new Date().toISOString()): void {
    this.db
      .prepare("insert into kb_collection (campaign, made_at) values (?, ?) on conflict do nothing")
      .run(campaign, at);
  }

  /** The items whose newest version links to this address, and how each links. */
  linksTo(address: string): { rel: string; item: KbItem }[] {
    return linksTo(this.db, address);
  }

  /** Every version of an item, oldest first, each with its links. */
  versions(id: number): KbVersion[] {
    return versionsOf(this.db, id);
  }

  /** A version's text as a read gives it: its writer's words, or its file's text once extracted. */
  versionText(v: Pick<KbVersion, "body" | "file">): string {
    return v.file ? this.files.text(v.file.sha256) : v.body;
  }

  /**
   * A file's text, extracted once (control/kb/text/): kept by its SHA-256 and, when searched, in
   * each item whose newest version names the file, which the words index follows (files.ts).
   */
  keepFileText(
    sha256: string,
    r: { state: "searched" | "whole"; text?: string; why: string | null; pages: number | null },
  ): void {
    this.tx(() => keepFileText(this.db, sha256, r));
  }

  /** What a run reads: its scope (scope.ts), never past what its campaign may read. */
  scope(campaign: string, run: string): KbScope {
    return scopeOf(this.db, this.reads(campaign), campaign, run);
  }

  /** Sets what a run reads (scope.ts); throws, in words, on a collection not granted. */
  setScope(campaign: string, run: string, s: KbScope, by: string): void {
    keepScope(this.db, this.reads(campaign), { campaign, run, ...s }, by);
  }

  /** Every campaign's collection (also one with no runs or items yet), newest change first. */
  collections(): KbCollection[] {
    const rows = this.db
      .prepare(
        `select campaign, kind, count(*) as n, max(updated_at) as at,
           sum(case when kind = 'note' and sub in (${JOURNAL_KINDS.map(() => "?").join(", ")}) then 1 else 0 end) as journal
         from kb_item group by campaign, kind`,
      )
      .all(...JOURNAL_KINDS) as Row[];
    type Sum = Pick<KbCollection, "counts" | "items" | "journal" | "updated_at">;
    const by = new Map<string, Sum>();
    const empty = (): Sum => ({ counts: {}, items: 0, journal: 0, updated_at: "" });
    for (const r of this.db.prepare("select campaign from kb_collection").all() as Row[])
      by.set(str(r.campaign), empty());
    for (const r of rows) {
      const c = str(r.campaign);
      const f = by.get(c) ?? empty();
      f.counts[str(r.kind) as KbKind] = Number(r.n);
      f.items += Number(r.n);
      f.journal += Number(r.journal);
      if (str(r.at) > f.updated_at) f.updated_at = str(r.at);
      by.set(c, f);
    }
    const runs = new Map<string, number>();
    for (const r of this.db
      .prepare("select campaign, count(*) as n from kb_run group by campaign")
      .all() as Row[]) {
      runs.set(str(r.campaign), Number(r.n));
      if (!by.has(str(r.campaign))) by.set(str(r.campaign), empty());
    }
    return [...by.entries()]
      .map(([campaign, f]) => ({
        campaign,
        ...f,
        runs: runs.get(campaign) ?? 0,
        read_by: this.readBy(campaign),
        reads: this.reads(campaign),
      }))
      .sort(
        (a, b) => b.updated_at.localeCompare(a.updated_at) || a.campaign.localeCompare(b.campaign),
      );
  }

  /** One campaign's collection (empty when nothing of it is stored yet). */
  collection(campaign: string, all = this.collections()): KbCollection {
    return (
      all.find((f) => f.campaign === campaign) ?? {
        campaign,
        counts: {},
        journal: 0,
        items: 0,
        runs: 0,
        updated_at: "",
        read_by: this.readBy(campaign),
        reads: this.reads(campaign),
      }
    );
  }

  /** The collections a campaign reads besides its own: its grants, by name. */
  reads(campaign: string): string[] {
    return (
      this.db
        .prepare("select reads from kb_read where campaign = ? order by reads")
        .all(campaign) as Row[]
    ).map((r) => str(r.reads));
  }

  /** The collections a campaign's agents may read: its own first, then those granted. */
  readable(campaign: string): string[] {
    return [campaign, ...this.reads(campaign).filter((f) => f !== campaign)];
  }

  /** The campaigns granted to read this one's collection. */
  readBy(campaign: string): string[] {
    return (
      this.db
        .prepare("select campaign from kb_read where reads = ? order by campaign")
        .all(campaign) as Row[]
    ).map((r) => str(r.campaign));
  }

  /** Every campaign a grant names, on either side: names a copy of a campaign may not take. */
  grantNames(): string[] {
    return (
      this.db
        .prepare("select campaign as name from kb_read union select reads from kb_read order by 1")
        .all() as Row[]
    ).map((r) => str(r.name));
  }

  /**
   * Lets a campaign read another's collection, read only. Its runs at work receive the collection's
   * items at their next sync, with seqs given now. False: nothing changed (already granted, or its
   * own collection).
   */
  grant(campaign: string, reads: string, by: string): boolean {
    if (!campaign || !reads || campaign === reads) return false;
    return this.tx(() => {
      const added =
        Number(
          this.db
            .prepare(
              "insert or ignore into kb_read (campaign, reads, granted_by, granted_at) values (?, ?, ?, ?)",
            )
            .run(campaign, reads, by, new Date().toISOString()).changes,
        ) > 0;
      if (!added) return added;
      const n = Number(
        (
          this.db.prepare("select count(*) as n from kb_item where campaign = ?").get(reads) as {
            n: number;
          }
        ).n,
      );
      if (n) {
        const base = this.nextSeq(n) - n;
        this.db
          .prepare(
            `insert into kb_grant_item (campaign, reads, item, seq)
             select ?, ?, id, ? + row_number() over (order by seq) from kb_item where campaign = ?`,
          )
          .run(campaign, reads, base, reads);
      }
      return true;
    });
  }

  /** Ends a grant. False: there was none. */
  revoke(campaign: string, reads: string): boolean {
    return this.tx(() => {
      this.db
        .prepare("delete from kb_grant_item where campaign = ? and reads = ?")
        .run(campaign, reads);
      return (
        Number(
          this.db
            .prepare("delete from kb_read where campaign = ? and reads = ?")
            .run(campaign, reads).changes,
        ) > 0
      );
    });
  }

  /**
   * Items by words within `where` (search.ts): each a campaign's whole collection, or one run's
   * items of it. One query or several, best first, a page of hits with their excerpts, why and
   * passages, how many matched, where the words land and how many items hold each; no words: the
   * newest. `like` and `seen` name items by address, found within `where`.
   */
  find(q: string | readonly string[], where: readonly KbWhere[], o: KbFind = {}): KbFindAnswer {
    const like = o.like ? this.at(o.like, where) : undefined;
    const lost = o.like !== undefined && !like;
    const { found, ...r } = findItems(this.db, lost ? [] : where, {
      ...o,
      queries: typeof q === "string" ? [q] : q,
      like: like && { id: like.id, title: like.title, body: like.body },
      seen: (o.seen ?? []).flatMap((a) => this.at(a, where)?.id ?? []),
      limit: o.limit ?? 50,
    });
    if (lost)
      r.refused = `no item ${o.like} in what this search reads: like takes an address a search gave`;
    const hits = found.map((f) => ({
      ...itemOf(f.row),
      excerpt: f.excerpt,
      why: f.why,
      passage: f.passage,
    }));
    return { ...r, hits };
  }

  /** find() over whole collections: the Knowledge page's, a campaign's and the owner's search. */
  search(
    q: string,
    campaigns: string[],
    o: { kinds?: KbKind[]; limit?: number; sub?: string[] } = {},
  ): KbFound[] {
    const where = campaigns.map((campaign) => ({ campaign }));
    return this.find(q, where, o).hits;
  }

  /** The collections, runs or slots a place holds (list.ts), each with its items and newest change. */
  folders(at: KbListAt): KbFolderRow[] {
    return placeFolders(this.db, at);
  }

  /** A page of the items under a place (list.ts), with how many, and their counts by filter. */
  list(at: KbListAt, o: KbListOptions): KbListed {
    return listItems(this.db, at, o);
  }

  /** What a place holds in all (list.ts): by type and kind, older versions, bytes stored. */
  totals(at: KbListAt): KbTotals {
    return placeTotals(this.db, at);
  }

  /**
   * What a run of a campaign reads, as find() takes it: its own run alone when it started fresh,
   * else the campaign's whole collection; and the granted collections it includes.
   */
  scopeWhere(campaign: string, run: string): { scope: KbScope; where: KbWhere[] } {
    const scope = this.scope(campaign, run);
    const own: KbWhere = scope.fresh ? { campaign, run } : { campaign };
    return { scope, where: [own, ...scope.granted.map((c) => ({ campaign: c }))] };
  }

  /**
   * The item at an address (core/kb.ts), the newest of that address if two rigs' runs share its
   * run's name; within `where` when given. Undefined when there is none there.
   */
  at(address: string, where?: readonly KbWhere[]): KbItem | undefined {
    const a = readKbAddress(address);
    if (!a) return undefined;
    if (where && !where.some((w) => w.campaign === a.campaign && (!w.run || w.run === a.run)))
      return undefined;
    const r = this.db
      .prepare(
        "select * from kb_item where campaign = ? and run = ? and slot = ? and kind = ? and ref = ? order by updated_at desc limit 1",
      )
      .get(a.campaign, a.run, a.slot, a.kind, a.ref) as Row | undefined;
    return r ? itemOf(r) : undefined;
  }

  /** How many items of each kind one run put in its collection (field notes apart). */
  runCounts(rig: string, ledger: string, run: string) {
    return runCountsOf(this.db, rig, ledger, run);
  }

  /** The number the next item of a run's slot takes: one past its highest (the owner's notes). */
  nextItem(src: { rig: string; ledger: string; run: string }, slot: string): number {
    const r = this.db
      .prepare(
        "select coalesce(max(cast(ref as integer)), 0) + 1 as n from kb_item where rig = ? and ledger = ? and run = ? and slot = ?",
      )
      .get(src.rig, src.ledger, src.run, slot) as { n: number };
    return Number(r.n);
  }

  /** What the knowledge base stores, from its own tables (stored.ts). */
  stored(): KbStoredFigures {
    return storedFigures(this.db);
  }

  /** A run's field notes, newest first: at most `limit`, with how many it has (journal.ts). */
  fieldNotes(rig: string, ledger: string, run: string, limit: number) {
    return fieldNotesOf(this.db, { rig, ledger, run }, limit);
  }

  item(id: number): KbItem | undefined {
    const r = this.db.prepare("select * from kb_item where id = ?").get(id) as Row | undefined;
    return r ? itemOf(r) : undefined;
  }

  /**
   * The item a briefing names by where it came from (campaign, run, kind, ref). Undefined when
   * control has none, or more than one (run names are unique per rig only).
   */
  byOrigin(o: {
    campaign: string;
    rig?: string;
    run: string;
    kind: string;
    ref: string;
  }): KbItem | undefined {
    const rows = this.db
      .prepare(
        `select * from kb_item where campaign = ? and run = ? and slot = 'records' and kind = ? and ref = ?${o.rig ? " and rig = ?" : ""} limit 2`,
      )
      .all(o.campaign, o.run, o.kind, o.ref, ...(o.rig ? [o.rig] : [])) as Row[];
    // Two rigs may each have run a run of this name: without its rig, which one is not known.
    return rows.length === 1 && rows[0] ? itemOf(rows[0]) : undefined;
  }

  /** An experiment's result in words, with its attempt's verdict when the collection has it. */
  resultOf(x: KbItem): string | null {
    if (x.kind !== "experiment") return null;
    const m = /(?:^|\n)(Result|Dropped): (.*)$/s.exec(x.body);
    if (!m) return null;
    const attempt = /^attempt (\S+)/.exec(m[2] ?? "")?.[1];
    const verdict = attempt
      ? /(?:^|\n)Verdict: (.*)$/.exec(
          str(
            (
              this.db
                .prepare(
                  "select body from kb_item where rig = ? and ledger = ? and slot = 'records' and kind = 'attempt' and ref = ?",
                )
                .get(x.rig, x.ledger, attempt) as { body?: string } | undefined
            )?.body,
          ),
        )?.[1]
      : undefined;
    return `${m[1] === "Dropped" ? "dropped" : "tried"}: ${m[2]}${verdict ? `, ${verdict.replace(/_/g, " ")}` : ""}`;
  }

  /** Items of the given collections changed after a seq, in seq order. */
  changedAfter(campaigns: string[], after: number, limit = SYNC_PAGE): KbItem[] {
    if (!campaigns.length) return [];
    return (
      this.db
        .prepare(
          `select * from kb_item where campaign in (${campaigns.map(() => "?").join(", ")}) and seq > ? order by seq limit ?`,
        )
        .all(...campaigns, after, limit) as Row[]
    ).map(itemOf);
  }

  /** The campaign of a rig's run in its current ledger, if control has seen the run start. */
  runCampaign(rig: string, run: string): string | undefined {
    const ledger = (
      this.db.prepare("select ledger_id from rig where id = ?").get(rig) as
        | { ledger_id: string | null }
        | undefined
    )?.ledger_id;
    return ledger ? this.campaignOf(rig, ledger, run) : undefined;
  }

  /**
   * What a run's supervisor syncs into the run's knowledge/ folder: the items of the collections
   * its campaign may read, changed after `after`, in seq order, at most SYNC_PAGE at once, without
   * the run's own items (it has them). Undefined: the rig has no such run in its current ledger.
   * A grant's copy of an item comes only to a cursor already past the item's own seq; a run that
   * pages through both may still get an item twice, and keeps the newer.
   */
  sync(rig: string, run: string, after: number, limit = SYNC_PAGE): KbSync | undefined {
    const ledger = (
      this.db.prepare("select ledger_id from rig where id = ?").get(rig) as
        | { ledger_id: string | null }
        | undefined
    )?.ledger_id;
    const campaign = ledger ? this.campaignOf(rig, ledger, run) : undefined;
    if (!ledger || !campaign) return undefined;
    const collections = this.readable(campaign);
    const granted = collections.slice(1);
    const marks = (xs: string[]) => xs.map(() => "?").join(", ");
    const notOwn = "not (i.rig = ? and i.ledger = ? and i.run = ?)";
    const own = [rig, ledger, run];
    const rows = this.db
      .prepare(
        `select i.*, i.seq as s from kb_item i
         where i.campaign in (${marks(collections)}) and i.seq > ? and ${notOwn}
         ${
           granted.length
             ? `union all
         select i.*, g.seq as s from kb_grant_item g join kb_item i on i.id = g.item
         where g.campaign = ? and g.reads in (${marks(granted)}) and g.seq > ? and i.seq <= ?
           and ${notOwn}`
             : ""
         }
         order by s limit ?`,
      )
      .all(
        ...collections,
        after,
        ...own,
        ...(granted.length ? [campaign, ...granted, after, after, ...own] : []),
        limit + 1,
      ) as Row[];
    const page = rows.slice(0, limit);
    const items: KbItemWire[] = page.map((r) => {
      const x = itemOf(r);
      return {
        seq: Number(r.s),
        campaign: x.campaign,
        rig: x.rig,
        run: x.run,
        kind: x.kind,
        ref: x.ref,
        title: x.title,
        // A file's text may be long: a rig's copy holds as much of it as a blurb's.
        body: clip(x.body, KB_BODY_MAX),
        by: x.by,
        url: x.url,
        sub: x.sub,
        at: x.at,
        updated_at: x.updated_at,
      };
    });
    return {
      campaign,
      collections,
      items,
      next: items.at(-1)?.seq ?? after,
      more: rows.length > limit,
    };
  }
}
