import type { DatabaseSync } from "node:sqlite";
import { type Row, StorePart } from "./part.ts";

/**
 * Control's own settings that the owner sets on control and control keeps across its restarts
 * (store migration 27), each a text by its key, with who set it and when: its log level
 * (control/log-level.ts). A setting with no row takes its default from control's environment.
 */

/** A setting as the store keeps it. */
interface OwnSetting {
  value: string;
  set_by: string;
  set_at: string;
}

/** The settings' table (store migration 27). */
export function ownSettingsTable(db: DatabaseSync): void {
  db.exec(`create table if not exists control_setting (
  key text primary key,
  value text not null,
  set_by text not null,
  set_at text not null
)`);
}

export interface OwnSettings {
  /** A setting, if the owner set it. */
  get(key: string): Promise<OwnSetting | undefined>;
  /** A setting from now on; null takes its row out, so it takes its default again. */
  set(key: string, value: string | null, by: string): Promise<void>;
}

/** OwnSettings on SQLite: each call answers at once (the store behind the interface, sqlite.ts). */
export class SqliteOwnSettings extends StorePart {
  /** A setting, if the owner set it. */
  get(key: string): OwnSetting | undefined {
    const r = this.db
      .prepare("select value, set_by, set_at from control_setting where key = ?")
      .get(key) as Row | undefined;
    return r
      ? { value: String(r.value), set_by: String(r.set_by), set_at: String(r.set_at) }
      : undefined;
  }

  /** A setting from now on; null takes its row out, so it takes its default again. */
  set(key: string, value: string | null, by: string): void {
    if (value === null) {
      this.db.prepare("delete from control_setting where key = ?").run(key);
      return;
    }
    this.db
      .prepare(
        `insert into control_setting (key, value, set_by, set_at) values (?, ?, ?, ?)
         on conflict (key) do update set value = excluded.value, set_by = excluded.set_by, set_at = excluded.set_at`,
      )
      .run(key, value, by, new Date().toISOString());
  }
}
