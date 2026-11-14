import type { OwnSetting, OwnSettings } from "../own-settings.ts";
import { PgPart, type Row } from "./part.ts";

/** OwnSettings on PostgreSQL: the store behind the interface (store.ts). */
export class PostgresOwnSettings extends PgPart implements OwnSettings {
  /** A setting, if the owner set it. */
  async get(key: string): Promise<OwnSetting | undefined> {
    const r = (await this.q.get(
      "select value, set_by, set_at from control_setting where key = ?",
      key,
    )) as Row | undefined;
    return r
      ? { value: String(r.value), set_by: String(r.set_by), set_at: String(r.set_at) }
      : undefined;
  }

  /** A setting from now on; null takes its row out, so it takes its default again. */
  async set(key: string, value: string | null, by: string): Promise<void> {
    if (value === null) {
      await this.q.run("delete from control_setting where key = ?", key);
      return;
    }
    await this.q.run(
      `insert into control_setting (key, value, set_by, set_at) values (?, ?, ?, ?)
         on conflict (key) do update set value = excluded.value, set_by = excluded.set_by, set_at = excluded.set_at`,
      key,
      value,
      by,
      new Date().toISOString(),
    );
  }
}
