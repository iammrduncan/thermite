import type { CampaignFolders } from "../folders.ts";
import { PgPart, type Row } from "./part.ts";

/** CampaignFolders on PostgreSQL: the store behind the interface (store.ts). */
export class PostgresCampaignFolders extends PgPart implements CampaignFolders {
  /** The navigation's folders, by name, each with the campaigns in it (by name). */
  async list(): Promise<
    {
      id: number;
      name: string;
      created_at: string;
      created_by: string;
      campaigns: string[];
    }[]
  > {
    const inFolder = new Map<number, string[]>();
    for (const r of (await this.q.all(
      "select campaign, folder from campaign_in_folder order by campaign",
    )) as Row[]) {
      const list = inFolder.get(Number(r.folder)) ?? [];
      list.push(String(r.campaign));
      inFolder.set(Number(r.folder), list);
    }
    return (
      (await this.q.all("select * from campaign_folder order by lower(name), name")) as Row[]
    ).map((r) => ({
      id: Number(r.id),
      name: String(r.name),
      created_at: String(r.created_at),
      created_by: String(r.created_by),
      campaigns: inFolder.get(Number(r.id)) ?? [],
    }));
  }

  /** A folder of the navigation by its name, whatever its case. */
  async get(name: string): Promise<{ id: number; name: string } | undefined> {
    const r = (await this.q.get(
      "select id, name from campaign_folder where lower(name) = lower(?)",
      name,
    )) as Row | undefined;
    return r ? { id: Number(r.id), name: String(r.name) } : undefined;
  }

  async add(name: string, by: string): Promise<number> {
    const r = await this.q.insert(
      "insert into campaign_folder (name, created_at, created_by) values (?, ?, ?)",
      name,
      new Date().toISOString(),
      by,
    );
    return r;
  }

  async rename(id: number, name: string): Promise<void> {
    await this.q.run("update campaign_folder set name = ? where id = ?", name, id);
  }

  /** Deletes a folder (campaigns/folders.ts deletes only an empty one). */
  async delete(id: number): Promise<void> {
    await this.q.run("delete from campaign_in_folder where folder = ?", id);
    await this.q.run("delete from campaign_folder where id = ?", id);
  }

  /** Puts a campaign in a folder of the navigation, or (null) in none. */
  async place(campaign: string, folder: number | null): Promise<void> {
    if (folder === null)
      await this.q.run("delete from campaign_in_folder where campaign = ?", campaign);
    else
      await this.q.run(
        "insert into campaign_in_folder (campaign, folder) values (?, ?) on conflict (campaign) do update set folder = excluded.folder",
        campaign,
        folder,
      );
  }

  /** The folder a campaign shows in, or undefined for none. */
  async of(campaign: string): Promise<{ id: number; name: string } | undefined> {
    const r = (await this.q.get(
      "select f.id, f.name from campaign_in_folder c join campaign_folder f on f.id = c.folder where c.campaign = ?",
      campaign,
    )) as Row | undefined;
    return r ? { id: Number(r.id), name: String(r.name) } : undefined;
  }
}
