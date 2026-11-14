import type { CampaignArchive } from "../archive.ts";
import { PgPart, type Row } from "./part.ts";

/** CampaignArchive on PostgreSQL: the store behind the interface (store.ts). */
export class PostgresCampaignArchive extends PgPart implements CampaignArchive {
  /** Every archived campaign, the newest first. */
  async list(): Promise<{ campaign: string; at: string; by: string }[]> {
    return (
      (await this.q.all(
        "select * from campaign_archived order by archived_at desc, campaign",
      )) as Row[]
    ).map((r) => ({
      campaign: String(r.campaign),
      at: String(r.archived_at),
      by: String(r.archived_by),
    }));
  }

  /** When and by whom a campaign was archived, or undefined when it is not. */
  async get(campaign: string): Promise<{ at: string; by: string } | undefined> {
    const r = (await this.q.get(
      "select archived_at, archived_by from campaign_archived where campaign = ?",
      campaign,
    )) as Row | undefined;
    return r ? { at: String(r.archived_at), by: String(r.archived_by) } : undefined;
  }

  /**
   * Archives a campaign. It keeps its folder (the owner, 2026-10-21): the navigation leaves it out
   * while it is archived, and unarchiving brings it back into the same folder.
   */
  async add(campaign: string, by: string): Promise<{ at: string; by: string }> {
    const at = new Date().toISOString();
    await this.q.run(
      "insert into campaign_archived (campaign, archived_at, archived_by) values (?, ?, ?) on conflict (campaign) do nothing",
      campaign,
      at,
      by,
    );
    return (await this.get(campaign)) ?? { at, by };
  }

  async remove(campaign: string): Promise<boolean> {
    return (
      Number(
        (await this.q.run("delete from campaign_archived where campaign = ?", campaign)).changes,
      ) > 0
    );
  }
}
