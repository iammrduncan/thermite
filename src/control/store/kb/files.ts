import type { DatabaseSync } from "node:sqlite";
import { KB_TEXT_TYPES } from "../../../core/kb.ts";
import { indexItem, unindexItem } from "./words.ts";

/**
 * The files the knowledge base holds, each once by its SHA-256 (the kb_file table; control's
 * kb/files.ts keeps the bytes in its state): which it holds, a file kept, the orphans, files no
 * version of any item names, which control removes only when the owner sets a time for them; each
 * file's text, extracted once (control/kb/text/); and the knowledge base's settings on control.
 */

/** A file control holds, as its row records it. */
export interface KbFileRow {
  sha256: string;
  bytes: number;
  stored_at: string;
}

/**
 * What became of a file's text: searched, its text in the words index (`why` says where it was
 * cut, or is null), or kept whole (`why` says why). Kept once by its SHA-256.
 */
export interface KbFileText {
  state: "searched" | "whole";
  why: string | null;
  chars: number;
  pages: number | null;
  extracted_at: string;
}

/** A file whose text waits to be extracted: held, of a type control reads, named by a version. */
export interface KbTextDue {
  sha256: string;
  type: string;
  bytes: number;
}

/**
 * Store migration 23 (goal 175, step 7): each file's text, the knowledge base's settings, and an
 * index of the versions by the file they name. The knowledge base also runs it as it opens, as it
 * runs migrations 14 and 17.
 */
export function knowledgeFiles(db: DatabaseSync): void {
  db.exec(`
create table if not exists kb_file_text (
  sha256 text primary key,
  -- searched: its text is in the words index, in each item whose newest version names the file;
  -- whole: only its bytes are kept.
  state text not null check (state in ('searched', 'whole')),
  text text not null default '',
  -- Where its text was cut, or why it is kept whole, in words; null for a text read whole.
  why text,
  chars integer not null default 0,
  pages integer,
  extracted_at text not null
);
create index if not exists kb_version_file on kb_version (file_sha256) where file_sha256 is not null;
-- The knowledge base's settings on control, as the owner sets them; no row: its default.
create table if not exists kb_setting (
  key text primary key,
  value real not null,
  set_by text not null,
  set_at text not null
);`);
}

/** The media types control reads text from, as SQL's list. */
const TEXT_TYPES_SQL = KB_TEXT_TYPES.map((t) => `'${t}'`).join(", ");

export class KbFileRows {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  /** Whether control holds the file with this SHA-256. */
  has(sha256: string): boolean {
    return this.db.prepare("select 1 from kb_file where sha256 = ?").get(sha256) !== undefined;
  }

  /** Whether a version of an item control stored names the file with this SHA-256. */
  named(sha256: string): boolean {
    return (
      this.db.prepare("select 1 from kb_version where file_sha256 = ? limit 1").get(sha256) !==
      undefined
    );
  }

  /** A file control now holds, once: every item that names its SHA-256 has it from now on. */
  kept(sha256: string, bytes: number, at = new Date().toISOString()): void {
    this.db
      .prepare(
        "insert into kb_file (sha256, bytes, stored_at) values (?, ?, ?) on conflict do nothing",
      )
      .run(sha256, bytes, at);
  }

  /**
   * The files kept before `before` that no version of any item names, the newest one included:
   * a file whose item never arrived, or was refused. Oldest first, at most `limit`. Versions are
   * never removed, so a file an item named once is never among them.
   */
  orphans(before: string, limit: number): KbFileRow[] {
    return (
      this.db
        .prepare(
          `select sha256, bytes, stored_at from kb_file f
           where stored_at < ?
             and not exists (select 1 from kb_version v where v.file_sha256 = f.sha256)
           order by stored_at limit ?`,
        )
        .all(before, limit) as { sha256: string; bytes: number; stored_at: string }[]
    ).map((r) => ({ sha256: r.sha256, bytes: Number(r.bytes), stored_at: r.stored_at }));
  }

  /**
   * Forgets a file control removed from its state, and its text; an item that names it later
   * waits for it again.
   */
  removed(sha256: string): void {
    this.db.prepare("delete from kb_file where sha256 = ?").run(sha256);
    this.db.prepare("delete from kb_file_text where sha256 = ?").run(sha256);
  }

  /**
   * The files whose text waits: held, named by a version of a type control reads, with no text
   * yet. Oldest kept first, at most `limit`, each with the type its newest naming version gives.
   */
  textWaiting(limit: number): KbTextDue[] {
    return (
      this.db
        .prepare(
          `select f.sha256, f.bytes,
             (select v.file_type from kb_version v where v.file_sha256 = f.sha256
              and lower(v.file_type) in (${TEXT_TYPES_SQL}) order by v.at desc limit 1) as type
           from kb_file f
           where not exists (select 1 from kb_file_text t where t.sha256 = f.sha256)
             and type is not null
           order by f.stored_at, f.sha256 limit ?`,
        )
        .all(limit) as { sha256: string; bytes: number; type: string }[]
    ).map((r) => ({ sha256: r.sha256, type: r.type, bytes: Number(r.bytes) }));
  }

  /** What became of a file's text, without the text; undefined: not extracted yet. */
  textState(sha256: string): KbFileText | undefined {
    const r = this.db
      .prepare("select state, why, chars, pages, extracted_at from kb_file_text where sha256 = ?")
      .get(sha256) as Record<string, string | number | null> | undefined;
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
  text(sha256: string): string {
    const r = this.db
      .prepare("select text from kb_file_text where sha256 = ? and state = 'searched'")
      .get(sha256) as { text: string } | undefined;
    return r?.text ?? "";
  }
}

/**
 * A file's text, once: kept by its SHA-256, and, when searched, given to each item whose newest
 * version names the file, as the text its row holds for the words index (words.ts), which follows
 * in the same transaction. The item's versions keep their writer's words. A file read again keeps
 * its first text. In the caller's transaction.
 */
export function keepFileText(
  db: DatabaseSync,
  sha256: string,
  r: { state: "searched" | "whole"; text?: string; why: string | null; pages: number | null },
  at = new Date().toISOString(),
): void {
  const text = r.state === "searched" ? (r.text ?? "") : "";
  const added = db
    .prepare(
      `insert into kb_file_text (sha256, state, text, why, chars, pages, extracted_at)
       values (?, ?, ?, ?, ?, ?, ?) on conflict (sha256) do nothing`,
    )
    .run(sha256, r.state, text, r.why, text.length, r.pages, at);
  if (Number(added.changes) === 0 || !text) return;
  const items = db.prepare("select id from kb_item where file_sha256 = ?").all(sha256) as {
    id: number;
  }[];
  for (const { id } of items) {
    unindexItem(db, id);
    db.prepare("update kb_item set body = ? where id = ?").run(text, id);
    indexItem(db, id, text);
  }
}

/** The knowledge base's settings on control: each a number the owner sets, or its default. */
export type KbSettingKey = "max_file_mib" | "orphan_hours";

/** One setting as the owner set it. */
export interface KbSettingRow {
  value: number;
  set_by: string;
  set_at: string;
}

export class KbSettingRows {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  /** The owner's value of a setting; undefined: its default. */
  get(key: KbSettingKey): KbSettingRow | undefined {
    const r = this.db
      .prepare("select value, set_by, set_at from kb_setting where key = ?")
      .get(key) as { value: number; set_by: string; set_at: string } | undefined;
    return r ? { value: Number(r.value), set_by: r.set_by, set_at: r.set_at } : undefined;
  }

  /** A setting set to a value, or back to its default (null). */
  set(key: KbSettingKey, value: number | null, by: string, at = new Date().toISOString()): void {
    if (value === null) this.db.prepare("delete from kb_setting where key = ?").run(key);
    else
      this.db
        .prepare(
          `insert into kb_setting (key, value, set_by, set_at) values (?, ?, ?, ?)
           on conflict (key) do update set value = excluded.value, set_by = excluded.set_by,
             set_at = excluded.set_at`,
        )
        .run(key, value, by, at);
  }

  /** The largest file the knowledge base takes, in bytes; 0: no limit, the default. */
  maxFileBytes(): number {
    return Math.floor((this.get("max_file_mib")?.value ?? 0) * 1024 ** 2);
  }
}
