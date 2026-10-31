import type { DatabaseSync } from "node:sqlite";
import { KB_RECORDS, type KbKind } from "../../../core/kb.ts";
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
import { keepVersion } from "./items.ts";
import { ORIGIN_KINDS, originTarget } from "./journal.ts";

type Row = Record<string, unknown>;

/**
 * The reading's version, and the kinds each reading read anew: a store built by an earlier
 * reading reads those events once more, so the runs before an upgrade have them too. Reading 2
 * added runs, trials, documents and hypotheses; reading 3 keeps an experiment's result and an
 * attempt's verdict in fields, and an experiment's edits, says a cut, and gives the paper, each
 * answer card and the review panel's decisions items of their own (goal 162). Reading 4 gives each
 * item the lane and the trial its events name, as fields (goal 176): the events of ORIGIN_KINDS
 * that no earlier reading reads anew are read again for that alone (journal.ts, originTarget).
 */
const READING = "4";
const READ_FOR_ORIGIN = "4";
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

/**
 * Thermite's reading of a rig's events into the records slot of each run (core/kb-index.ts reads
 * each event), in the collection control files the run in, and the reading's upgrades: the
 * knowledge base's part that the apply of the events stream feeds (store/kb/index.ts holds it).
 */
export class KbReading {
  private readonly db: DatabaseSync;
  private readonly o: { nextSeq: () => number; makeCollection: (campaign: string) => void };

  constructor(db: DatabaseSync, o: KbReading["o"]) {
    this.db = db;
    this.o = o;
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
    const target =
      o.again && !this.readAnew(this.reading()).includes(kind)
        ? originTarget(this.db, src)
        : this.target(src, { keepRuns: o.again === true });
    indexEvent(target, {
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
    const origin = READ_FOR_ORIGIN > (at ?? "1") ? ORIGIN_KINDS.flatMap((k) => eventKinds(k)) : [];
    return [...new Set([...this.readAnew(at), ...origin])];
  }

  /** The kinds of event a store at reading `at` reads anew in full, under every name each had. */
  private readAnew(at: string | undefined): string[] {
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

  /**
   * Whether control knows a campaign of this name: it assigned a run of it to any rig, saved a
   * version of it, or a grant names it.
   */
  private knowsCampaign(campaign: string): boolean {
    return (
      this.db
        .prepare(
          `select 1 from command where kind = 'assign_campaign'
             and json_extract(signed, '$.envelope.payload.contract.campaign') = ?1
           union all select 1 from campaign_version where campaign = ?1
           union all select 1 from kb_read where campaign = ?1 or reads = ?1
           limit 1`,
        )
        .get(campaign) !== undefined
    );
  }

  /** Whether control assigned a run of this name to another rig, whatever became of it. */
  private assignedElsewhere(rig: string, run: string): boolean {
    return (
      this.db
        .prepare(
          `select 1 from command where kind = 'assign_campaign' and rig != ?
             and json_extract(signed, '$.envelope.payload.run') = ? limit 1`,
        )
        .get(rig, run) !== undefined
    );
  }

  campaignOf(rig: string, ledger: string, run: string): string | undefined {
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
      // assign keeps the campaign its event names only when control knows no campaign of that
      // name (none assigned, saved or granted) and assigned no run of this name to another rig:
      // a rig cannot file items into a campaign it was not given.
      runCreated: (run, named) => {
        if (o.keepRuns && this.campaignOf(rig, ledger, run)) return;
        const assigned = this.assigned(rig, run);
        const own =
          named && !this.knowsCampaign(named) && !this.assignedElsewhere(rig, run) ? named : "";
        const campaign = assigned ?? own;
        if (!campaign) return;
        this.o.makeCollection(campaign);
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
    keepVersion(this.db, this.o.nextSeq(), place, next, { at });
  }
}
