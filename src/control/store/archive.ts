import { type Row, StorePart } from "./part.ts";

/**
 * Archived campaigns (goal 077; goal 125, T6).
 */

export class CampaignArchive extends StorePart {
  /** Every archived campaign, the newest first. */
  list(): { campaign: string; at: string; by: string }[] {
    return (
      this.db
        .prepare("select * from campaign_archived order by archived_at desc, campaign")
        .all() as Row[]
    ).map((r) => ({
      campaign: String(r.campaign),
      at: String(r.archived_at),
      by: String(r.archived_by),
    }));
  }

  /** When and by whom a campaign was archived, or undefined when it is not. */
  get(campaign: string): { at: string; by: string } | undefined {
    const r = this.db
      .prepare("select archived_at, archived_by from campaign_archived where campaign = ?")
      .get(campaign) as Row | undefined;
    return r ? { at: String(r.archived_at), by: String(r.archived_by) } : undefined;
  }

  /**
   * Archives a campaign. It keeps its folder (the owner, 2026-10-21): the navigation leaves it out
   * while it is archived, and unarchiving brings it back into the same folder.
   */
  add(campaign: string, by: string): { at: string; by: string } {
    const at = new Date().toISOString();
    this.db
      .prepare(
        "insert into campaign_archived (campaign, archived_at, archived_by) values (?, ?, ?) on conflict (campaign) do nothing",
      )
      .run(campaign, at, by);
    return this.get(campaign) ?? { at, by };
  }

  remove(campaign: string): boolean {
    return (
      Number(
        this.db.prepare("delete from campaign_archived where campaign = ?").run(campaign).changes,
      ) > 0
    );
  }
}
