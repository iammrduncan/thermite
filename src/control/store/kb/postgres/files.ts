import type { Sql } from "../../../../common/postgres.ts";
import { KB_TEXT_TYPES } from "../../../../core/kb/index.ts";
import type {
  KbFileRow,
  KbFileRows,
  KbFileText,
  KbSettingKey,
  KbSettingRow,
  KbSettingRows,
  KbTextDue,
} from "../files.ts";
import { itemText } from "../items.ts";
import { indexItem, unindexItem } from "./words.ts";

/** The media types control reads text from, as SQL's list. */
const TEXT_TYPES_SQL = KB_TEXT_TYPES.map((t) => `'${t}'`).join(", ");

/** KbFileRows on PostgreSQL: the store behind the interface (store.ts). */
export class PostgresKbFileRows implements KbFileRows {
  private readonly q: Sql;

  constructor(q: Sql) {
    this.q = q;
  }

  /** Whether control holds the file with this SHA-256. */
  async has(sha256: string): Promise<boolean> {
    return (await this.q.get("select 1 from kb_file where sha256 = ?", sha256)) !== undefined;
  }

  /** Whether a version of an item control stored names the file with this SHA-256. */
  async named(sha256: string): Promise<boolean> {
    return (
      (await this.q.get("select 1 from kb_version where file_sha256 = ? limit 1", sha256)) !==
      undefined
    );
  }

  /** A file control now holds, once: every item that names its SHA-256 has it from now on. */
  async kept(sha256: string, bytes: number, at = new Date().toISOString()): Promise<void> {
    await this.q.run(
      "insert into kb_file (sha256, bytes, stored_at) values (?, ?, ?) on conflict do nothing",
      sha256,
      bytes,
      at,
    );
  }

  /**
   * The files kept before `before` that no version of any item names, the newest one included:
   * a file whose item never arrived, or was refused, or whose versions that named it a retention
   * policy removed (store/kb/older.ts). Oldest first, at most `limit`. An item's newest version
   * is never removed, so a file it names is never among them.
   */
  async orphans(before: string, limit: number): Promise<KbFileRow[]> {
    return (
      (await this.q.all(
        `select sha256, bytes, stored_at from kb_file f
           where stored_at < ?
             and not exists (select 1 from kb_version v where v.file_sha256 = f.sha256)
           order by stored_at limit ?`,
        before,
        limit,
      )) as { sha256: string; bytes: number; stored_at: string }[]
    ).map((r) => ({ sha256: r.sha256, bytes: Number(r.bytes), stored_at: r.stored_at }));
  }

  /**
   * Forgets a file control removed from its state, and its text; an item that names it later
   * waits for it again.
   */
  async removed(sha256: string): Promise<void> {
    await this.q.run("delete from kb_file where sha256 = ?", sha256);
    await this.q.run("delete from kb_file_text where sha256 = ?", sha256);
  }

  /**
   * The files whose text waits: held, named by a version of a type control reads, with no text
   * yet. Oldest kept first, at most `limit`, each with the type its newest naming version gives.
   */
  async textWaiting(limit: number): Promise<KbTextDue[]> {
    return (
      (await this.q.all(
        `select sha256, bytes, type from (
             select f.sha256, f.bytes, f.stored_at,
               (select v.file_type from kb_version v where v.file_sha256 = f.sha256
                and lower(v.file_type) in (${TEXT_TYPES_SQL}) order by v.at desc limit 1) as type
             from kb_file f
             where not exists (select 1 from kb_file_text t where t.sha256 = f.sha256)) due
           where type is not null
           order by stored_at, sha256 limit ?`,
        limit,
      )) as { sha256: string; bytes: number; type: string }[]
    ).map((r) => ({ sha256: r.sha256, type: r.type, bytes: Number(r.bytes) }));
  }

  /** What became of a file's text, without the text; undefined: not extracted yet. */
  async textState(sha256: string): Promise<KbFileText | undefined> {
    const r = (await this.q.get(
      "select state, why, chars, pages, extracted_at from kb_file_text where sha256 = ?",
      sha256,
    )) as Record<string, string | number | null> | undefined;
    return r
      ? {
          state: r.state === "searched" ? "searched" : "whole",
          why: r.why === null ? null : String(r.why),
          chars: Number(r.chars),
          pages: r.pages === null ? null : Number(r.pages),
          extracted_at: String(r.extracted_at),
        }
      : undefined;
  }

  /** A file's text as the words index holds it; "" when it has none (kept whole, or not yet). */
  async text(sha256: string): Promise<string> {
    const r = (await this.q.get(
      "select text from kb_file_text where sha256 = ? and state = 'searched'",
      sha256,
    )) as { text: string } | undefined;
    return r?.text ?? "";
  }
}

/**
 * A file's text, once: kept by its SHA-256, and, when searched, given to each item whose newest
 * version names the file, after the item's own words, as the text its row holds for the words
 * index (words.ts), which follows in the same transaction. The item's versions keep their own words. A file read again keeps
 * its first text. In the caller's transaction.
 */
export async function keepFileText(
  q: Sql,
  sha256: string,
  r: { state: "searched" | "whole"; text?: string; why: string | null; pages: number | null },
  at = new Date().toISOString(),
): Promise<void> {
  const text = r.state === "searched" ? (r.text ?? "") : "";
  const added = await q.run(
    `insert into kb_file_text (sha256, state, text, why, chars, pages, extracted_at)
       values (?, ?, ?, ?, ?, ?, ?) on conflict (sha256) do nothing`,
    sha256,
    r.state,
    text,
    r.why,
    text.length,
    r.pages,
    at,
  );
  if (Number(added.changes) === 0 || !text) return;
  // Each item's own words, from its newest version, before the file's text.
  const items = (await q.all(
    `select i.id, v.body from kb_item i join kb_version v on v.item = i.id and v.version = i.version
       where i.file_sha256 = ?`,
    sha256,
  )) as { id: number; body: string }[];
  for (const { id, body } of items) {
    const whole = itemText(body, text);
    await unindexItem(q, id);
    await q.run("update kb_item set body = ? where id = ?", whole, id);
    await indexItem(q, id, whole);
  }
}

/** KbSettingRows on PostgreSQL: the store behind the interface (store.ts). */
export class PostgresKbSettingRows implements KbSettingRows {
  private readonly q: Sql;

  constructor(q: Sql) {
    this.q = q;
  }

  /** The owner's value of a setting; undefined: its default. */
  async get(key: KbSettingKey): Promise<KbSettingRow | undefined> {
    const r = (await this.q.get(
      "select value, set_by, set_at from kb_setting where key = ?",
      key,
    )) as { value: number; set_by: string; set_at: string } | undefined;
    return r ? { value: Number(r.value), set_by: r.set_by, set_at: r.set_at } : undefined;
  }

  /** A setting set to a value, or back to its default (null). */
  async set(
    key: KbSettingKey,
    value: number | null,
    by: string,
    at = new Date().toISOString(),
  ): Promise<void> {
    if (value === null) await this.q.run("delete from kb_setting where key = ?", key);
    else
      await this.q.run(
        `insert into kb_setting (key, value, set_by, set_at) values (?, ?, ?, ?)
           on conflict (key) do update set value = excluded.value, set_by = excluded.set_by,
             set_at = excluded.set_at`,
        key,
        value,
        by,
        at,
      );
  }

  /** The largest file the knowledge base takes, in bytes; 0: no limit, the default. */
  async maxFileBytes(): Promise<number> {
    return Math.floor(((await this.get("max_file_mib"))?.value ?? 0) * 1024 ** 2);
  }
}
