import type { KbItemBody, KbKind } from "../../../core/kb/index.ts";
import type { KbFileRows, KbSettingRows } from "./files.ts";
import type { KbCollection, KbFindAnswer, KbFound, KbItem } from "./index.ts";
import type { KbVersion } from "./items.ts";
import type { KbFolderRow, KbListAt, KbListed, KbListOptions, KbTotals } from "./list.ts";
import type { OlderVersion } from "./older.ts";
import type { KbScope } from "./scope.ts";
import type { KbFind, KbWhere } from "./search.ts";
import type { KbStoredFigures } from "./stored.ts";

/**
 * The knowledge base's calls, as its callers see them (goal 267): each gives a promise. The SQLite
 * class behind them is in index.ts.
 */

export interface KnowledgeBase {
  /** The files it holds, each once by its SHA-256 (files.ts; control/kb/files.ts keeps them). */
  readonly files: KbFileRows;
  /** Its settings on control: the largest file, and how long an orphan file stays (files.ts). */
  readonly settings: KbSettingRows;
  /**
   * Where the knowledge base was indexed from control's events table, before the apply of the
   * events stream fed it (goal 168): the table's seq of the last event indexed then. It no longer
   * moves. The apply indexes each event of the stream after it, by the seq its message carries, and
   * every event whose message carries none: so an event is indexed once, either way.
   */
  indexedFromTable(): Promise<number>;
  /**
   * One event of a rig's ledger into the records slot of its run, in its campaign's collection
   * (reading.ts). `again`: an event read again after an upgrade (kindsToReadAgain).
   */
  index(
    src: { rig: string; ledger: string },
    e: { at: string; actor: string; kind: string; subject: string | null; body: unknown },
    o?: { again?: boolean },
  ): Promise<void>;
  /** The kinds of event the knowledge base reads again, once, after an upgrade of its reading. */
  kindsToReadAgain(): Promise<string[]>;
  /** The events of kindsToReadAgain read again: the store is at its reading. */
  readAgainDone(): Promise<void>;
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
  ): Promise<string | undefined>;
  /** A campaign's collection, made with the campaign; nothing when it has one. */
  makeCollection(campaign: string, at?: string): Promise<void>;
  /** The items whose newest version links to this address, and how each links. */
  linksTo(address: string): Promise<{ rel: string; item: KbItem }[]>;
  /** The older versions a retention policy may remove (older.ts), oldest first. */
  olderVersions(): Promise<OlderVersion[]>;
  /** Removes older versions a policy covers, never an item's newest; how many went. */
  removeOlderVersions(versions: readonly { item: number; version: number }[]): Promise<number>;
  /** Every version of an item, oldest first, each with its links. */
  versions(id: number): Promise<KbVersion[]>;
  /** The oldest version of an item an agent may read (kept.ts): 1, unless Thermite's code scrubbed it. */
  agentsReadFrom(id: number): Promise<number>;
  /**
   * One page of the kept conversations stored before the scrubbing, after item `after` (kept.ts):
   * each gets its scrubbed new version, all in one transaction.
   */
  scrubKept(
    after: number,
    limit: number,
  ): Promise<{ looked: number; scrubbed: number; last: number }>;
  /** A version's text as a read gives it: its own words, then its file's text once extracted. */
  versionText(v: Pick<KbVersion, "body" | "file">): Promise<string>;
  /**
   * A file's text, extracted once (control/kb/text/): kept by its SHA-256 and, when searched, in
   * each item whose newest version names the file, which the words index follows (files.ts).
   */
  keepFileText(
    sha256: string,
    r: { state: "searched" | "whole"; text?: string; why: string | null; pages: number | null },
  ): Promise<void>;
  /** What a run reads: its scope (scope.ts), never past what its campaign may read. */
  scope(campaign: string, run: string): Promise<KbScope>;
  /** Sets what a run reads (scope.ts); throws, in words, on a collection not granted. */
  setScope(campaign: string, run: string, s: KbScope, by: string): Promise<void>;
  /** Every campaign's collection (also one with no runs or items yet), newest change first. */
  collections(): Promise<KbCollection[]>;
  /** One campaign's collection (empty when nothing of it is stored yet). */
  collection(campaign: string, all?: KbCollection[]): Promise<KbCollection>;
  /** The collections a campaign reads besides its own: its grants, by name. */
  reads(campaign: string): Promise<string[]>;
  /** The collections a campaign's agents may read: its own first, then those granted. */
  readable(campaign: string): Promise<string[]>;
  /** The campaigns granted to read this one's collection. */
  readBy(campaign: string): Promise<string[]>;
  /** Every campaign a grant names, on either side: names a copy of a campaign may not take. */
  grantNames(): Promise<string[]>;
  /**
   * Lets a campaign read another's collection, read only. False: nothing changed (already granted,
   * or its own collection).
   */
  grant(campaign: string, reads: string, by: string): Promise<boolean>;
  /** Ends a grant. False: there was none. */
  revoke(campaign: string, reads: string): Promise<boolean>;
  /**
   * Items by words within `where` (search.ts): each a campaign's whole collection, or one run's
   * items of it. One query or several, best first, a page of hits with their excerpts, why and
   * passages, how many matched, where the words land and how many items hold each; no words: the
   * newest. `like` and `seen` name items by address, found within `where`.
   */
  find(q: string | readonly string[], where: readonly KbWhere[], o?: KbFind): Promise<KbFindAnswer>;
  /** find() over whole collections: the Knowledge page's, a campaign's and the owner's search. */
  search(
    q: string,
    campaigns: string[],
    o?: { kinds?: KbKind[]; limit?: number; sub?: string[] },
  ): Promise<KbFound[]>;
  /** The collections, runs or slots a place holds (list.ts), each with its items and newest change. */
  folders(at: KbListAt): Promise<KbFolderRow[]>;
  /** A page of the items under a place (list.ts), with how many, and their counts by filter. */
  list(at: KbListAt, o: KbListOptions): Promise<KbListed>;
  /** What a place holds in all (list.ts): by type and kind, older versions, bytes stored. */
  totals(at: KbListAt): Promise<KbTotals>;
  /**
   * What a run of a campaign reads, as find() takes it: its own run alone when it started fresh,
   * else the campaign's whole collection; and the granted collections it includes.
   */
  scopeWhere(campaign: string, run: string): Promise<{ scope: KbScope; where: KbWhere[] }>;
  /**
   * The item at an address (core/kb/items.ts), the newest of that address if two rigs' runs share its
   * run's name; within `where` when given. Undefined when there is none there.
   */
  at(address: string, where?: readonly KbWhere[]): Promise<KbItem | undefined>;
  /** How many items of each kind one run put in its collection (field notes apart). */
  runCounts(
    rig: string,
    ledger: string,
    run: string,
  ): Promise<
    Partial<
      Record<
        | "run"
        | "trial"
        | "experiment"
        | "attempt"
        | "note"
        | "doc"
        | "source"
        | "claim"
        | "hypothesis"
        | "finding"
        | "report"
        | "decision"
        | "surprise"
        | "journal"
        | "review"
        | "reference"
        | "paper",
        number
      >
    > & { journal: number }
  >;
  /** The number the next item of a run's slot takes: one past its highest (the owner's notes). */
  nextItem(src: { rig: string; ledger: string; run: string }, slot: string): Promise<number>;
  /** What the knowledge base stores, from its own tables (stored.ts). */
  stored(): Promise<KbStoredFigures>;
  /** A run's field notes, newest first: at most `limit`, with how many it has (journal.ts). */
  fieldNotes(
    rig: string,
    ledger: string,
    run: string,
    limit: number,
  ): Promise<{ total: number; items: KbItem[] }>;
  item(id: number): Promise<KbItem | undefined>;
  /**
   * The item a briefing names by where it came from (campaign, run, kind, ref). Undefined when
   * control has none, or more than one.
   */
  byOrigin(o: {
    campaign: string;
    rig?: string;
    run: string;
    kind: string;
    ref: string;
  }): Promise<KbItem | undefined>;
  /** An experiment's result in words, with its attempt's verdict when the collection has it. */
  resultOf(x: KbItem): Promise<string | null>;
  /** The campaign of a rig's run in its current ledger, if control has seen the run start. */
  runCampaign(rig: string, run: string): Promise<string | undefined>;
}
