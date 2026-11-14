import type { Sql } from "../../../../common/postgres.ts";
import {
  type KbItemBody,
  type KbKind,
  readKbAddress,
  str,
  writtenRef,
} from "../../../../core/kb/index.ts";
import type { KbCollection, KbFindAnswer, KbFound, KbItem, Row } from "../index.ts";
import type { KnowledgeBase } from "../interface.ts";
import { itemOf, itemText, type KbVersion, writtenFields } from "../items.ts";
import { journalCount } from "../journal.ts";
import type { KbFolderRow, KbListAt, KbListed, KbListOptions, KbTotals } from "../list.ts";
import type { OlderVersion } from "../older.ts";
import type { KbScope } from "../scope.ts";
import type { KbFind, KbWhere } from "../search.ts";
import type { KbStoredFigures } from "../stored.ts";
import { keepFileText, PostgresKbFileRows, PostgresKbSettingRows } from "./files.ts";
import { keepVersion, linksTo, versionRefusal, versionsOf } from "./items.ts";
import { fieldNotesOf, runCountsOf } from "./journal.ts";
import { agentsReadFrom, scrubKeptPage } from "./kept.ts";
import { listItems, placeFolders, placeTotals } from "./list.ts";
import { olderVersions, removeOlderVersions } from "./older.ts";
import { KbReading } from "./reading.ts";
import { keepScope, scopeOf } from "./scope.ts";
import { findItems } from "./search.ts";
import { storedFigures } from "./stored.ts";

export { PostgresKbFileRows, PostgresKbSettingRows } from "./files.ts";

/** KnowledgeBase on PostgreSQL: the store behind the interface (store.ts). */
export class PostgresKnowledgeBase implements KnowledgeBase {
  private readonly q: Sql;
  /** The files it holds, each once by its SHA-256 (files.ts; control/kb/files.ts keeps them). */
  readonly files: PostgresKbFileRows;
  /** Its settings on control: the largest file, and how long an orphan file stays (files.ts). */
  readonly settings: PostgresKbSettingRows;

  /** Thermite's reading of the rigs' events into the records slots (reading.ts). */
  private readonly reader: KbReading;

  constructor(q: Sql) {
    this.q = q;
    this.files = new PostgresKbFileRows(q);
    this.settings = new PostgresKbSettingRows(q);
    this.reader = new KbReading(q, {
      nextSeq: async () => await this.nextSeq(),
      makeCollection: async (campaign) => await this.makeCollection(campaign),
      fileText: async (sha256) => await this.files.text(sha256),
    });
  }

  /** Runs fn in one transaction: all of it is kept, or none of it. */
  private tx<T>(fn: () => Promise<T>): Promise<T> {
    return this.q.tx(fn);
  }

  /** The next item seq. */
  private async nextSeq(): Promise<number> {
    const r = (await this.q.get(
      "update kb_cursor set item_seq = item_seq + 1 where id = 1 returning item_seq",
    )) as { item_seq: number };
    return Number(r.item_seq);
  }

  /**
   * Where the knowledge base was indexed from control's events table, before the apply of the
   * events stream fed it (goal 168): the table's seq of the last event indexed then. It no longer
   * moves. The apply indexes each event of the stream after it, by the seq its message carries, and
   * every event whose message carries none: so an event is indexed once, either way.
   */
  async indexedFromTable(): Promise<number> {
    return Number(
      ((await this.q.get("select seq from kb_cursor where id = 1")) as { seq: number }).seq,
    );
  }

  /**
   * One event of a rig's ledger into the records slot of its run, in its campaign's collection
   * (reading.ts). `again`: an event read again after an upgrade (kindsToReadAgain).
   */
  async index(
    src: { rig: string; ledger: string },
    e: { at: string; actor: string; kind: string; subject: string | null; body: unknown },
    o: { again?: boolean } = {},
  ): Promise<void> {
    await this.reader.index(src, e, o);
  }

  /** The kinds of event the knowledge base reads again, once, after an upgrade of its reading. */
  async kindsToReadAgain(): Promise<string[]> {
    return await this.reader.kindsToReadAgain();
  }

  /** The events of kindsToReadAgain read again: the store is at its reading. */
  async readAgainDone(): Promise<void> {
    await this.reader.readAgainDone();
  }

  private async campaignOf(rig: string, ledger: string, run: string): Promise<string | undefined> {
    return await this.reader.campaignOf(rig, ledger, run);
  }

  /**
   * One writer's `kb_item` event, in its writer's slot of the event's run, in the collection
   * control filed the run in: a new item, or the next version of the writer's own item. The
   * caller checked that the run is the rig's and that the slot is the event's writer's
   * (control/events/knowledge.ts). Undefined once stored; else why it is refused, in words. In
   * the caller's transaction.
   */
  async write(
    src: { rig: string; ledger: string; run: string; event?: number | undefined; at: string },
    b: KbItemBody,
  ): Promise<string | undefined> {
    const { rig, ledger, run } = src;
    const campaign = await this.campaignOf(rig, ledger, run);
    if (!campaign)
      return `run ${run} has no collection: control filed it under no campaign of its own`;
    const refused = await versionRefusal(this.q, src, b);
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
    const fileText = b.file ? await this.files.text(b.file.sha256) : undefined;
    await keepVersion(
      this.q,
      await this.nextSeq(),
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
  async makeCollection(campaign: string, at = new Date().toISOString()): Promise<void> {
    await this.q.run(
      "insert into kb_collection (campaign, made_at) values (?, ?) on conflict do nothing",
      campaign,
      at,
    );
  }

  /** The items whose newest version links to this address, and how each links. */
  async linksTo(address: string): Promise<{ rel: string; item: KbItem }[]> {
    return await linksTo(this.q, address);
  }

  /** The older versions a retention policy may remove (older.ts), oldest first. */
  async olderVersions(): Promise<OlderVersion[]> {
    return await olderVersions(this.q);
  }

  /** Removes older versions a policy covers, never an item's newest; how many went. */
  async removeOlderVersions(
    versions: readonly { item: number; version: number }[],
  ): Promise<number> {
    return await removeOlderVersions(this.q, versions);
  }

  /** Every version of an item, oldest first, each with its links. */
  async versions(id: number): Promise<KbVersion[]> {
    return await versionsOf(this.q, id);
  }

  /** The oldest version of an item an agent may read (kept.ts): 1, unless Thermite's code scrubbed it. */
  async agentsReadFrom(id: number): Promise<number> {
    return await agentsReadFrom(this.q, id);
  }

  /**
   * One page of the kept conversations stored before the scrubbing, after item `after` (kept.ts):
   * each gets its scrubbed new version, all in one transaction.
   */
  async scrubKept(after: number, limit: number) {
    const at = new Date().toISOString();
    return await this.tx(
      async () =>
        await scrubKeptPage(this.q, async () => await this.nextSeq(), { after, limit, at }),
    );
  }

  /** A version's text as a read gives it: its own words, then its file's text once extracted. */
  async versionText(v: Pick<KbVersion, "body" | "file">): Promise<string> {
    return v.file ? itemText(v.body, await this.files.text(v.file.sha256)) : v.body;
  }

  /**
   * A file's text, extracted once (control/kb/text/): kept by its SHA-256 and, when searched, in
   * each item whose newest version names the file, which the words index follows (files.ts).
   */
  async keepFileText(
    sha256: string,
    r: { state: "searched" | "whole"; text?: string; why: string | null; pages: number | null },
  ): Promise<void> {
    await this.tx(async () => await keepFileText(this.q, sha256, r));
  }

  /** What a run reads: its scope (scope.ts), never past what its campaign may read. */
  async scope(campaign: string, run: string): Promise<KbScope> {
    return await scopeOf(this.q, await this.reads(campaign), campaign, run);
  }

  /** Sets what a run reads (scope.ts); throws, in words, on a collection not granted. */
  async setScope(campaign: string, run: string, s: KbScope, by: string): Promise<void> {
    await keepScope(this.q, await this.reads(campaign), { campaign, run, ...s }, by);
  }

  /** Every campaign's collection (also one with no runs or items yet), newest change first. */
  async collections(): Promise<KbCollection[]> {
    const rows = (await this.q.all(
      `select campaign, kind, count(*) as n, max(updated_at) as at,
           ${journalCount().sql} as journal
         from kb_item group by campaign, kind`,
      ...journalCount().args,
    )) as Row[];
    type Sum = Pick<KbCollection, "counts" | "items" | "journal" | "updated_at">;
    const by = new Map<string, Sum>();
    const empty = (): Sum => ({ counts: {}, items: 0, journal: 0, updated_at: "" });
    for (const r of (await this.q.all("select campaign from kb_collection")) as Row[])
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
    for (const r of (await this.q.all(
      "select campaign, count(*) as n from kb_run group by campaign",
    )) as Row[]) {
      runs.set(str(r.campaign), Number(r.n));
      if (!by.has(str(r.campaign))) by.set(str(r.campaign), empty());
    }
    const out: KbCollection[] = [];
    for (const [campaign, f] of by)
      out.push({
        campaign,
        ...f,
        runs: runs.get(campaign) ?? 0,
        read_by: await this.readBy(campaign),
        reads: await this.reads(campaign),
      });
    return out.sort(
      (a, b) => b.updated_at.localeCompare(a.updated_at) || a.campaign.localeCompare(b.campaign),
    );
  }

  /** One campaign's collection (empty when nothing of it is stored yet). */
  async collection(campaign: string, all?: KbCollection[]): Promise<KbCollection> {
    return (
      (all ?? (await this.collections())).find((f) => f.campaign === campaign) ?? {
        campaign,
        counts: {},
        journal: 0,
        items: 0,
        runs: 0,
        updated_at: "",
        read_by: await this.readBy(campaign),
        reads: await this.reads(campaign),
      }
    );
  }

  /** The collections a campaign reads besides its own: its grants, by name. */
  async reads(campaign: string): Promise<string[]> {
    return (
      (await this.q.all(
        "select reads from kb_read where campaign = ? order by reads",
        campaign,
      )) as Row[]
    ).map((r) => str(r.reads));
  }

  /** The collections a campaign's agents may read: its own first, then those granted. */
  async readable(campaign: string): Promise<string[]> {
    return [campaign, ...(await this.reads(campaign)).filter((f) => f !== campaign)];
  }

  /** The campaigns granted to read this one's collection. */
  async readBy(campaign: string): Promise<string[]> {
    return (
      (await this.q.all(
        "select campaign from kb_read where reads = ? order by campaign",
        campaign,
      )) as Row[]
    ).map((r) => str(r.campaign));
  }

  /** Every campaign a grant names, on either side: names a copy of a campaign may not take. */
  async grantNames(): Promise<string[]> {
    return (
      (await this.q.all(
        "select campaign as name from kb_read union select reads from kb_read order by 1",
      )) as Row[]
    ).map((r) => str(r.name));
  }

  /**
   * Lets a campaign read another's collection, read only. False: nothing changed (already granted,
   * or its own collection).
   */
  async grant(campaign: string, reads: string, by: string): Promise<boolean> {
    if (!campaign || !reads || campaign === reads) return false;
    return (
      Number(
        (
          await this.q.run(
            "insert into kb_read (campaign, reads, granted_by, granted_at) values (?, ?, ?, ?) on conflict do nothing",
            campaign,
            reads,
            by,
            new Date().toISOString(),
          )
        ).changes,
      ) > 0
    );
  }

  /** Ends a grant. False: there was none. */
  async revoke(campaign: string, reads: string): Promise<boolean> {
    return (
      Number(
        (await this.q.run("delete from kb_read where campaign = ? and reads = ?", campaign, reads))
          .changes,
      ) > 0
    );
  }

  /**
   * Items by words within `where` (search.ts): each a campaign's whole collection, or one run's
   * items of it. One query or several, best first, a page of hits with their excerpts, why and
   * passages, how many matched, where the words land and how many items hold each; no words: the
   * newest. `like` and `seen` name items by address, found within `where`.
   */
  async find(
    q: string | readonly string[],
    where: readonly KbWhere[],
    o: KbFind = {},
  ): Promise<KbFindAnswer> {
    const like = o.like ? await this.at(o.like, where) : undefined;
    const lost = o.like !== undefined && !like;
    const seen: number[] = [];
    for (const a of o.seen ?? []) {
      const id = (await this.at(a, where))?.id;
      if (id !== undefined) seen.push(id);
    }
    const { found, ...r } = await findItems(this.q, lost ? [] : where, {
      ...o,
      queries: typeof q === "string" ? [q] : q,
      like: like && { id: like.id, title: like.title, body: like.body },
      seen,
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
  async search(
    q: string,
    campaigns: string[],
    o: { kinds?: KbKind[]; limit?: number; sub?: string[] } = {},
  ): Promise<KbFound[]> {
    const where = campaigns.map((campaign) => ({ campaign }));
    return (await this.find(q, where, o)).hits;
  }

  /** The collections, runs or slots a place holds (list.ts), each with its items and newest change. */
  async folders(at: KbListAt): Promise<KbFolderRow[]> {
    return await placeFolders(this.q, at);
  }

  /** A page of the items under a place (list.ts), with how many, and their counts by filter. */
  async list(at: KbListAt, o: KbListOptions): Promise<KbListed> {
    return await listItems(this.q, at, o);
  }

  /** What a place holds in all (list.ts): by type and kind, older versions, bytes stored. */
  async totals(at: KbListAt): Promise<KbTotals> {
    return await placeTotals(this.q, at);
  }

  /**
   * What a run of a campaign reads, as find() takes it: its own run alone when it started fresh,
   * else the campaign's whole collection; and the granted collections it includes.
   */
  async scopeWhere(campaign: string, run: string): Promise<{ scope: KbScope; where: KbWhere[] }> {
    const scope = await this.scope(campaign, run);
    const own: KbWhere = scope.fresh ? { campaign, run } : { campaign };
    return { scope, where: [own, ...scope.granted.map((c) => ({ campaign: c }))] };
  }

  /**
   * The item at an address (core/kb/items.ts), the newest of that address if two rigs' runs share its
   * run's name; within `where` when given. Undefined when there is none there.
   */
  async at(address: string, where?: readonly KbWhere[]): Promise<KbItem | undefined> {
    const a = readKbAddress(address);
    if (!a) return undefined;
    if (where && !where.some((w) => w.campaign === a.campaign && (!w.run || w.run === a.run)))
      return undefined;
    const r = (await this.q.get(
      "select * from kb_item where campaign = ? and run = ? and slot = ? and kind = ? and ref = ? order by updated_at desc limit 1",
      a.campaign,
      a.run,
      a.slot,
      a.kind,
      a.ref,
    )) as Row | undefined;
    return r ? itemOf(r) : undefined;
  }

  /** How many items of each kind one run put in its collection (field notes apart). */
  async runCounts(rig: string, ledger: string, run: string) {
    return await runCountsOf(this.q, rig, ledger, run);
  }

  /** The number the next item of a run's slot takes: one past its highest (the owner's notes). */
  async nextItem(src: { rig: string; ledger: string; run: string }, slot: string): Promise<number> {
    const r = (await this.q.get(
      // A ref's number is the digits it starts with, and 0 when it starts with none, as SQLite casts it.
      "select coalesce(max(coalesce(substring(ref from '^[0-9]+'), '0')::bigint), 0) + 1 as n from kb_item where rig = ? and ledger = ? and run = ? and slot = ?",
      src.rig,
      src.ledger,
      src.run,
      slot,
    )) as { n: number };
    return Number(r.n);
  }

  /** What the knowledge base stores, from its own tables (stored.ts). */
  async stored(): Promise<KbStoredFigures> {
    return await storedFigures(this.q);
  }

  /** A run's field notes, newest first: at most `limit`, with how many it has (journal.ts). */
  async fieldNotes(rig: string, ledger: string, run: string, limit: number) {
    return await fieldNotesOf(this.q, { rig, ledger, run }, limit);
  }

  async item(id: number): Promise<KbItem | undefined> {
    const r = (await this.q.get("select * from kb_item where id = ?", id)) as Row | undefined;
    return r ? itemOf(r) : undefined;
  }

  /**
   * The item a briefing names by where it came from (campaign, run, kind, ref). Undefined when
   * control has none, or more than one.
   */
  async byOrigin(o: {
    campaign: string;
    rig?: string;
    run: string;
    kind: string;
    ref: string;
  }): Promise<KbItem | undefined> {
    const rows = (await this.q.all(
      `select * from kb_item where campaign = ? and run = ? and slot = 'records' and kind = ? and ref = ?${o.rig ? " and rig = ?" : ""} limit 2`,
      o.campaign,
      o.run,
      o.kind,
      o.ref,
      ...(o.rig ? [o.rig] : []),
    )) as Row[];
    // Two rigs may each have run a run of this name: without its rig, which one is not known.
    return rows.length === 1 && rows[0] ? itemOf(rows[0]) : undefined;
  }

  /** An experiment's result in words, with its attempt's verdict when the collection has it. */
  async resultOf(x: KbItem): Promise<string | null> {
    if (x.kind !== "experiment") return null;
    const m = /(?:^|\n)(Result|Dropped): (.*)$/s.exec(x.body);
    if (!m) return null;
    const attempt = /^attempt (\S+)/.exec(m[2] ?? "")?.[1];
    const verdict = attempt
      ? /(?:^|\n)Verdict: (.*)$/.exec(
          str(
            (
              (await this.q.get(
                "select body from kb_item where rig = ? and ledger = ? and slot = 'records' and kind = 'attempt' and ref = ?",
                x.rig,
                x.ledger,
                attempt,
              )) as { body?: string } | undefined
            )?.body,
          ),
        )?.[1]
      : undefined;
    return `${m[1] === "Dropped" ? "dropped" : "tried"}: ${m[2]}${verdict ? `, ${verdict.replace(/_/g, " ")}` : ""}`;
  }

  /** The campaign of a rig's run in its current ledger, if control has seen the run start. */
  async runCampaign(rig: string, run: string): Promise<string | undefined> {
    const ledger = (
      (await this.q.get("select ledger_id from rig where id = ?", rig)) as
        | { ledger_id: string | null }
        | undefined
    )?.ledger_id;
    return ledger ? await this.campaignOf(rig, ledger, run) : undefined;
  }
}
