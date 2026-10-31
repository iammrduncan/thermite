import { type Row, StorePart } from "./part.ts";

/**
 * The navigation's campaign folders (goal 077; goal 125, T6).
 */

export class CampaignFolders extends StorePart {
  /** The navigation's folders, by name, each with the campaigns in it (by name). */
  list(): {
    id: number;
    name: string;
    created_at: string;
    created_by: string;
    campaigns: string[];
  }[] {
    const inFolder = new Map<number, string[]>();
    for (const r of this.db
      .prepare("select campaign, folder from campaign_in_folder order by campaign")
      .all() as Row[]) {
      const list = inFolder.get(Number(r.folder)) ?? [];
      list.push(String(r.campaign));
      inFolder.set(Number(r.folder), list);
    }
    return (
      this.db.prepare("select * from campaign_folder order by name collate nocase").all() as Row[]
    ).map((r) => ({
      id: Number(r.id),
      name: String(r.name),
      created_at: String(r.created_at),
      created_by: String(r.created_by),
      campaigns: inFolder.get(Number(r.id)) ?? [],
    }));
  }

  /** A folder of the navigation by its name, whatever its case. */
  get(name: string): { id: number; name: string } | undefined {
    const r = this.db
      .prepare("select id, name from campaign_folder where name = ? collate nocase")
      .get(name) as Row | undefined;
    return r ? { id: Number(r.id), name: String(r.name) } : undefined;
  }

  add(name: string, by: string): number {
    const r = this.db
      .prepare("insert into campaign_folder (name, created_at, created_by) values (?, ?, ?)")
      .run(name, new Date().toISOString(), by);
    return Number(r.lastInsertRowid);
  }

  rename(id: number, name: string): void {
    this.db.prepare("update campaign_folder set name = ? where id = ?").run(name, id);
  }

  /** Deletes a folder (campaigns/folders.ts deletes only an empty one). */
  delete(id: number): void {
    this.db.prepare("delete from campaign_in_folder where folder = ?").run(id);
    this.db.prepare("delete from campaign_folder where id = ?").run(id);
  }

  /** Puts a campaign in a folder of the navigation, or (null) in none. */
  place(campaign: string, folder: number | null): void {
    if (folder === null)
      this.db.prepare("delete from campaign_in_folder where campaign = ?").run(campaign);
    else
      this.db
        .prepare(
          "insert into campaign_in_folder (campaign, folder) values (?, ?) on conflict (campaign) do update set folder = excluded.folder",
        )
        .run(campaign, folder);
  }

  /** The folder a campaign shows in, or undefined for none. */
  of(campaign: string): { id: number; name: string } | undefined {
    const r = this.db
      .prepare(
        "select f.id, f.name from campaign_in_folder c join campaign_folder f on f.id = c.folder where c.campaign = ?",
      )
      .get(campaign) as Row | undefined;
    return r ? { id: Number(r.id), name: String(r.name) } : undefined;
  }
}
