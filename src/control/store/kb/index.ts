import type { DatabaseSync } from "node:sqlite";
import { transaction } from "../../../common/sqlite.ts";
import {
  KB_RECORDS,
  type KbItemBody,
  type KbItemWire,
  type KbKind,
  type KbSync,
  readKbAddress,
  writtenRef,
} from "../../../core/kb.ts";
import {
  indexEvent,
  type KbFields,
  type KbIndexTarget,
  type KbStored,
  mergeItem,
  metaOf,
  sameItem,
  str,
} from "../../../core/kb-index.ts";
import { eventKinds } from "../../../core/names.ts";
import {
  JOURNAL_KINDS,
  type KbCollection,
  type KbFound,
  type KbItem,
  SYNC_PAGE,
} from "../../kb/index.ts";
import { type KbVersion, keepVersion, versionRefusal, versionsOf, writtenFields } from "./items.ts";
import { knowledgeHierarchy } from "./schema.ts";
import { type KbScope, keepScope, scopeOf } from "./scope.ts";
import { findItems, type KbWhere } from "./search.ts";

export type { KbVersion } from "./items.ts";
export { knowledgeHierarchy } from "./schema.ts";
export type { KbScope } from "./scope.ts";
export { type KbWhere, searchTerms } from "./search.ts";

/**
 * The knowledge base's tables in control's store (goals 065, 125 and 175): one collection for each
 * campaign, its runs, each run's slots and their items with every version, the files the items
 * name, the grants to read other collections, a run's scope, the words index, and its cursors
 * (store/kb/schema.ts). The apply of the events stream feeds it (control/events): Thermite's
 * reading of each event into the records slot of its run, and each writer's `kb_item` event into
 * the writer's own slot. What the knowledge base is, and its items' shape, are in control/kb/.
 */

type Row = Record<string, unknown>;
/**
 * The reading's version, and the kinds each reading read anew: a store built by an earlier
 * reading reads those events once more, so the runs before an upgrade have them too. Reading 2
 * added runs, trials, documents and hypotheses; reading 3 keeps an experiment's result and an
 * attempt's verdict in fields, and an experiment's edits, says a cut, and gives the paper, each
 * answer card and the review panel's decisions items of their own (goal 162).
 */
const READING = "3";
const READ_ANEW: Record<string, string[]> = {
  "2": [
    "run_created",
    "run_status",
    "champion_promoted",
    "trial_started",
    "trial_finished",
    "research_doc",
    "hypothesis_added",
  ],
  "3": [
    "experiment_added",
    "experiment_edited",
    "experiment_finished",
    "experiment_dropped",
    "attempt_recorded",
    "verdict",
    "research_final",
    "research_digest",
    "research_paper_accepted",
    "card_written",
    "item_decided",
  ],
};

export class KnowledgeBase {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    // Store migration 14 runs it; a store that waits at an older version for the move of its
    // events table has its hierarchy here, before the apply writes its first item.
    transaction(db, () => knowledgeHierarchy(db));
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
   * (core/kb-index.ts reads it). The apply of the events stream hands each event here, in the
   * stream's order, so each ledger's events come while it is the rig's: a rig's report from a
   * ledger it has left is refused. `again`: an event read again after an upgrade
   * (kindsToReadAgain), whose run, filed already, stays in its collection.
   */
  index(
    src: { rig: string; ledger: string },
    e: { at: string; actor: string; kind: string; subject: string | null; body: unknown },
    o: { again?: boolean } = {},
  ): void {
    if (!e.body || typeof e.body !== "object") return;
    const { at, actor, kind } = e;
    indexEvent(this.target(src, { keepRuns: o.again === true }), {
      at,
      actor,
      kind,
      subject: e.subject ?? "",
      body: e.body as Row,
    });
  }

  /**
   * The kinds of event the knowledge base reads again, once, after an upgrade of its reading: those
   * whose items a reading after the store's was the first to make, under every name each had (goal
   * 162), so the runs before the upgrade have them too. None once the store is at READING. Control
   * reads them from the events stream as it starts (control/events), indexes each `again`, and
   * then calls readAgainDone.
   */
  kindsToReadAgain(): string[] {
    const at = this.reading();
    if (at === READING) return [];
    return Object.entries(READ_ANEW)
      .flatMap(([v, k]) => (v > (at ?? "1") ? k : []))
      .flatMap((k) => eventKinds(k));
  }

  /** The events of kindsToReadAgain read again: the store is at READING. */
  readAgainDone(): void {
    this.db
      .prepare(
        "insert into kb_meta (key, value) values ('reading', ?) on conflict(key) do update set value = excluded.value",
      )
      .run(READING);
  }

  /** The reading the store's items were made by; none before its first. */
  private reading(): string | undefined {
    return (
      this.db.prepare("select value from kb_meta where key = 'reading'").get() as
        | { value: string }
        | undefined
    )?.value;
  }

  /** The campaign of the newest assign_campaign control issued for this run on this rig. */
  private assigned(rig: string, run: string): string | undefined {
    const r = this.db
      .prepare(
        `select json_extract(signed, '$.envelope.payload.contract.campaign') as c from command
         where rig = ? and kind = 'assign_campaign' and status not in ('failed', 'rejected', 'expired')
           and json_extract(signed, '$.envelope.payload.run') = ?
         order by issued_at desc limit 1`,
      )
      .get(rig, run) as { c: unknown } | undefined;
    return typeof r?.c === "string" && r.c ? r.c : undefined;
  }

  /** Whether control assigned a run of this campaign to any rig. */
  private assignedAnywhere(campaign: string): boolean {
    return (
      this.db
        .prepare(
          `select 1 from command where kind = 'assign_campaign'
           and json_extract(signed, '$.envelope.payload.contract.campaign') = ? limit 1`,
        )
        .get(campaign) !== undefined
    );
  }

  private campaignOf(rig: string, ledger: string, run: string): string | undefined {
    return (
      this.db
        .prepare("select campaign from kb_run where rig = ? and ledger = ? and run = ?")
        .get(rig, ledger, run) as { campaign: string } | undefined
    )?.campaign;
  }

  /**
   * Where one rig ledger's events put their items: the records slot of each run, in the collection
   * control files the run in. `keepRuns`: a run filed already stays in its collection (reading old
   * events again).
   */
  private target(
    src: { rig: string; ledger: string },
    o: { keepRuns?: boolean } = {},
  ): KbIndexTarget {
    const { rig, ledger } = src;
    return {
      // Filed under the campaign control assigned this run on this rig. A run control did not
      // assign keeps the campaign its event names, unless control assigned that campaign
      // somewhere: a rig cannot file items into a campaign it was not given.
      runCreated: (run, named) => {
        if (o.keepRuns && this.campaignOf(rig, ledger, run)) return;
        const assigned = this.assigned(rig, run);
        const campaign = assigned ?? (named && !this.assignedAnywhere(named) ? named : "");
        if (!campaign) return;
        this.makeCollection(campaign);
        this.db
          .prepare(
            "insert into kb_run (rig, ledger, run, campaign) values (?, ?, ?, ?) on conflict(rig, ledger, run) do update set campaign = excluded.campaign",
          )
          .run(rig, ledger, run, campaign);
      },
      item: (run, kind, ref) => {
        const r = this.db
          .prepare(
            "select body, meta from kb_item where rig = ? and ledger = ? and run = ? and slot = 'records' and kind = ? and ref = ?",
          )
          .get(rig, ledger, run, kind, ref) as { body: string; meta: string } | undefined;
        return r && { body: r.body, meta: metaOf(r.meta) };
      },
      attempt: (ref) => {
        const r = this.db
          .prepare(
            "select run, body, meta from kb_item where rig = ? and ledger = ? and slot = 'records' and kind = 'attempt' and ref = ?",
          )
          .get(rig, ledger, ref) as { run: string; body: string; meta: string } | undefined;
        return r && { run: r.run, body: r.body, meta: metaOf(r.meta) };
      },
      put: (run, kind, ref, f, at) => this.put(src, run, kind, ref, f, at),
    };
  }

  private put(
    src: { rig: string; ledger: string },
    run: string,
    kind: KbKind,
    ref: string,
    f: KbFields,
    at: string,
  ): void {
    const { rig, ledger } = src;
    const campaign = this.campaignOf(rig, ledger, run);
    if (!campaign || !ref) return;
    const row = this.db
      .prepare(
        "select title, body, by, url, sub, meta from kb_item where rig = ? and ledger = ? and run = ? and slot = 'records' and kind = ? and ref = ?",
      )
      .get(rig, ledger, run, kind, ref) as Row | undefined;
    const old: KbStored | undefined = row
      ? {
          title: str(row.title),
          body: str(row.body),
          by: str(row.by),
          url: row.url ? str(row.url) : null,
          sub: row.sub ? str(row.sub) : null,
          meta: str(row.meta),
        }
      : undefined;
    const next = mergeItem(ref, old, f);
    // Nothing changed: the item keeps its seq, so no rig syncs it again.
    if (old && sameItem(old, next)) return;
    // A change is the item's next version: the one before stays.
    const place = { campaign, rig, ledger, run, slot: KB_RECORDS, kind, ref };
    keepVersion(this.db, this.nextSeq(), place, next, { at });
  }

  /**
   * One writer's `kb_item` event, in its writer's slot of the event's run, in the collection
   * control filed the run in: a new item, or the next version of the writer's own item. The
   * caller checked that the run is the rig's and that the slot is the event's writer's
   * (control/events/knowledge.ts). Undefined once stored; else why it is refused, in words. In
   * the caller's transaction.
   */
  write(
    src: { rig: string; ledger: string; run: string; event: number; at: string },
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
    keepVersion(this.db, this.nextSeq(), place, writtenFields(b), {
      at: src.at,
      event: src.event,
      links,
    });
    return undefined;
  }

  /** A campaign's collection, made with the campaign; nothing when it has one. */
  makeCollection(campaign: string, at = new Date().toISOString()): void {
    this.db
      .prepare("insert into kb_collection (campaign, made_at) values (?, ?) on conflict do nothing")
      .run(campaign, at);
  }

  /** Every version of an item, oldest first, each with its links. */
  versions(id: number): KbVersion[] {
    return versionsOf(this.db, id);
  }

  /** Whether control holds the file with this SHA-256 (control/kb/files.ts keeps it). */
  hasFile(sha256: string): boolean {
    return this.db.prepare("select 1 from kb_file where sha256 = ?").get(sha256) !== undefined;
  }

  /** A file control now holds, once: every item that names its SHA-256 has it from now on. */
  fileKept(sha256: string, bytes: number, at = new Date().toISOString()): void {
    this.db
      .prepare(
        "insert into kb_file (sha256, bytes, stored_at) values (?, ?, ?) on conflict do nothing",
      )
      .run(sha256, bytes, at);
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

  /** The collections a campaign reads besides its own: its grants. */
  reads(campaign: string): string[] {
    return (
      this.db
        .prepare("select reads from kb_read where campaign = ? order by granted_at, reads")
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
   * items of it. Best first by BM25, each with an excerpt and why it matched, with how many matched
   * in all; no words: the newest. `limit`: 50 when not given.
   */
  find(
    q: string,
    where: readonly KbWhere[],
    o: { kinds?: readonly string[]; sub?: readonly string[]; limit?: number } = {},
  ): { matched: number; hits: KbFound[] } {
    const r = findItems(this.db, q, where, { ...o, limit: o.limit ?? 50 });
    return {
      matched: r.matched,
      hits: r.found.map((f) => ({ ...itemOf(f.row), excerpt: f.excerpt, why: f.why })),
    };
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
  runCounts(
    rig: string,
    ledger: string,
    run: string,
  ): Partial<Record<KbKind, number>> & { journal: number } {
    const out: Partial<Record<KbKind, number>> & { journal: number } = { journal: 0 };
    for (const r of this.db
      .prepare(
        `select kind, count(*) as n,
           sum(case when kind = 'note' and sub in (${JOURNAL_KINDS.map(() => "?").join(", ")}) then 1 else 0 end) as journal
         from kb_item where rig = ? and ledger = ? and run = ? group by kind`,
      )
      .all(...JOURNAL_KINDS, rig, ledger, run) as Row[]) {
      out[str(r.kind) as KbKind] = Number(r.n);
      out.journal += Number(r.journal);
    }
    return out;
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
        body: x.body,
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

function itemOf(r: Row): KbItem {
  let meta: Record<string, string> = {};
  try {
    const m = JSON.parse(str(r.meta) || "{}") as Record<string, unknown>;
    meta = Object.fromEntries(Object.entries(m).map(([k, v]) => [k, str(v)] as const)) as Record<
      string,
      string
    >;
  } catch {
    // meta is written by this module as JSON; anything else reads as none
  }
  return {
    id: Number(r.id),
    seq: Number(r.seq),
    campaign: str(r.campaign),
    rig: str(r.rig),
    ledger: str(r.ledger),
    run: str(r.run),
    slot: str(r.slot) || KB_RECORDS,
    kind: str(r.kind) as KbKind,
    ref: str(r.ref),
    version: Number(r.version ?? 1),
    title: str(r.title),
    body: str(r.body),
    by: str(r.by),
    url: r.url ? str(r.url) : null,
    sub: r.sub ? str(r.sub) : null,
    meta,
    file: r.file_sha256
      ? {
          sha256: str(r.file_sha256),
          name: str(r.file_name),
          type: str(r.file_type),
          bytes: Number(r.file_bytes ?? 0),
        }
      : null,
    at: str(r.at),
    updated_at: str(r.updated_at),
  };
}
