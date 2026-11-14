import { jsonText, type Sql } from "../../../../common/postgres.ts";
import {
  indexEvent,
  KB_RECORDS,
  type KbFields,
  type KbKind,
  type KbStored,
  mergeItem,
  metaOf,
  sameItem,
  str,
} from "../../../../core/kb/index.ts";
import { eventKinds } from "../../../../core/names.ts";
import { ORIGIN_KINDS } from "../journal.ts";
import { scrubbedKept } from "../kept.ts";
import { READ_ANEW, READ_FOR_ORIGIN, READING, type Row } from "../reading.ts";
import { keepVersion } from "./items.ts";
import { originTarget } from "./journal.ts";
import { type KbIndexTargetLater, readLater } from "./replay.ts";

/**
 * Thermite's reading of a rig's events into the records slot of each run (core/kb/records.ts reads
 * each event), in the collection control files the run in, and the reading's upgrades: the
 * knowledge base's part that the apply of the events stream feeds (store/kb/index.ts holds it).
 */
export class KbReading {
  private readonly q: Sql;
  private readonly o: {
    nextSeq: () => Promise<number>;
    makeCollection: (campaign: string) => Promise<void>;
    /** A file's text, once control extracted it; "" until then. */
    fileText: (sha256: string) => Promise<string>;
  };

  constructor(q: Sql, o: KbReading["o"]) {
    this.q = q;
    this.o = o;
  }

  /**
   * One event of a rig's ledger into the records slot of its run, in its campaign's collection
   * (core/kb/records.ts reads it). The apply of the events stream hands each event here, in the
   * stream's order, so each ledger's events come while it is the rig's: a rig's report from a
   * ledger it has left is refused. `again`: an event read again after an upgrade
   * (kindsToReadAgain), whose run, filed already, stays in its collection.
   */
  async index(
    src: { rig: string; ledger: string },
    e: { at: string; actor: string; kind: string; subject: string | null; body: unknown },
    o: { again?: boolean } = {},
  ): Promise<void> {
    if (!e.body || typeof e.body !== "object") return;
    const { at, actor, kind } = e;
    const target =
      o.again && !this.readAnew(await this.reading()).includes(kind)
        ? originTarget(this.q, src)
        : this.target(src, { keepRuns: o.again === true });
    const event = { at, actor, kind, subject: e.subject ?? "", body: e.body as Row };
    // The reading answers at once, and this store does not: it runs as replay.ts says.
    await readLater((t) => indexEvent(t, event), target);
  }

  /**
   * The kinds of event the knowledge base reads again, once, after an upgrade of its reading: those
   * whose items a reading after the store's was the first to make, under every name each had (goal
   * 162), so the runs before the upgrade have them too. None once the store is at READING. Control
   * reads them from the events stream as it starts (control/events), indexes each `again`, and
   * then calls readAgainDone.
   */
  async kindsToReadAgain(): Promise<string[]> {
    const at = await this.reading();
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
  async readAgainDone(): Promise<void> {
    await this.q.run(
      "insert into kb_meta (key, value) values ('reading', ?) on conflict(key) do update set value = excluded.value",
      READING,
    );
  }

  /** The reading the store's items were made by; none before its first. */
  private async reading(): Promise<string | undefined> {
    return (
      (await this.q.get("select value from kb_meta where key = 'reading'")) as
        | { value: string }
        | undefined
    )?.value;
  }

  /** The campaign of the newest assign_campaign control issued for this run on this rig. */
  private async assigned(rig: string, run: string): Promise<string | undefined> {
    const r = (await this.q.get(
      `select ${jsonText("signed", "envelope", "payload", "contract", "campaign")} as c from command
         where rig = ? and kind = 'assign_campaign' and status not in ('failed', 'rejected', 'expired')
           and ${jsonText("signed", "envelope", "payload", "run")} = ?
         order by issued_at desc, rowid desc limit 1`,
      rig,
      run,
    )) as { c: unknown } | undefined;
    return typeof r?.c === "string" && r.c ? r.c : undefined;
  }

  /**
   * Whether control knows a campaign of this name: it assigned a run of it to any rig, saved a
   * version of it, or a grant names it.
   */
  private async knowsCampaign(campaign: string): Promise<boolean> {
    return (
      (await this.q.get(
        `select 1 from command where kind = 'assign_campaign'
             and ${jsonText("signed", "envelope", "payload", "contract", "campaign")} = ?
           union all select 1 from campaign_version where campaign = ?
           union all select 1 from kb_read where campaign = ? or reads = ?
           limit 1`,
        campaign,
        campaign,
        campaign,
        campaign,
      )) !== undefined
    );
  }

  /** Whether control assigned a run of this name to another rig, whatever became of it. */
  private async assignedElsewhere(rig: string, run: string): Promise<boolean> {
    return (
      (await this.q.get(
        `select 1 from command where kind = 'assign_campaign' and rig != ?
             and ${jsonText("signed", "envelope", "payload", "run")} = ? limit 1`,
        rig,
        run,
      )) !== undefined
    );
  }

  async campaignOf(rig: string, ledger: string, run: string): Promise<string | undefined> {
    return (
      (await this.q.get(
        "select campaign from kb_run where rig = ? and ledger = ? and run = ?",
        rig,
        ledger,
        run,
      )) as { campaign: string } | undefined
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
  ): KbIndexTargetLater {
    const { rig, ledger } = src;
    return {
      // Filed under the campaign control assigned this run on this rig. A run control did not
      // assign keeps the campaign its event names only when control knows no campaign of that
      // name (none assigned, saved or granted) and assigned no run of this name to another rig:
      // a rig cannot file items into a campaign it was not given.
      runCreated: async (run, named) => {
        if (o.keepRuns && (await this.campaignOf(rig, ledger, run))) return;
        const assigned = await this.assigned(rig, run);
        const own =
          named && !(await this.knowsCampaign(named)) && !(await this.assignedElsewhere(rig, run))
            ? named
            : "";
        const campaign = assigned ?? own;
        if (!campaign) return;
        await this.o.makeCollection(campaign);
        await this.q.run(
          "insert into kb_run (rig, ledger, run, campaign) values (?, ?, ?, ?) on conflict(rig, ledger, run) do update set campaign = excluded.campaign",
          rig,
          ledger,
          run,
          campaign,
        );
      },
      item: async (run, kind, ref) => {
        const r = await this.stored({ rig, ledger, run, kind, ref });
        return r && { body: r.body, meta: metaOf(r.meta) };
      },
      attempt: async (ref) => {
        const r = (await this.q.get(
          "select run, body, meta from kb_item where rig = ? and ledger = ? and slot = 'records' and kind = 'attempt' and ref = ?",
          rig,
          ledger,
          ref,
        )) as { run: string; body: string; meta: string } | undefined;
        return r && { run: r.run, body: r.body, meta: metaOf(r.meta) };
      },
      put: (run, kind, ref, f, at) => this.put(src, run, kind, ref, f, at),
    };
  }

  private async put(
    src: { rig: string; ledger: string },
    run: string,
    kind: KbKind,
    ref: string,
    f: KbFields,
    at: string,
  ): Promise<void> {
    const { rig, ledger } = src;
    const campaign = await this.campaignOf(rig, ledger, run);
    if (!campaign || !ref) return;
    const old = await this.stored({ rig, ledger, run, kind, ref });
    const place = { campaign, rig, ledger, run, slot: KB_RECORDS, kind, ref };
    // A kept conversation whose text the item holds is kept scrubbed by shape (kept.ts).
    const next = scrubbedKept(place, mergeItem(ref, old, f));
    // Nothing changed: the item keeps its seq.
    if (old && sameItem(old, next)) return;
    // A change is the item's next version: the one before stays. A file whose text control has
    // already gives it to the item's row for the words index.
    const fileText = next.file ? await this.o.fileText(next.file.sha256) : undefined;
    await keepVersion(this.q, await this.o.nextSeq(), place, { ...next, fileText }, { at });
  }

  /**
   * A records item's fields as the reading merges a change into them: its own words from its
   * newest version (a file item's row holds its file's text too), its fields and its file.
   */
  private async stored(p: {
    rig: string;
    ledger: string;
    run: string;
    kind: string;
    ref: string;
  }): Promise<KbStored | undefined> {
    const row = (await this.q.get(
      `select i.title, v.body as own, i.by, i.url, i.sub, i.meta, i.file_sha256, i.file_name,
           i.file_type, i.file_bytes
         from kb_item i join kb_version v on v.item = i.id and v.version = i.version
         where i.rig = ? and i.ledger = ? and i.run = ? and i.slot = 'records' and i.kind = ? and i.ref = ?`,
      p.rig,
      p.ledger,
      p.run,
      p.kind,
      p.ref,
    )) as Row | undefined;
    if (!row) return undefined;
    return {
      title: str(row.title),
      body: str(row.own),
      by: str(row.by),
      url: row.url ? str(row.url) : null,
      sub: row.sub ? str(row.sub) : null,
      meta: str(row.meta),
      file: row.file_sha256
        ? {
            sha256: str(row.file_sha256),
            name: str(row.file_name),
            type: str(row.file_type),
            bytes: Number(row.file_bytes ?? 0),
          }
        : null,
    };
  }
}
