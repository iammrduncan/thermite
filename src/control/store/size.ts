import { statSync } from "node:fs";
import { StorePart } from "./part.ts";

/**
 * control.db's own size, as SQLite counts it (goal 179), for Metrics' Storage tab: its file and
 * write-ahead log, its pages and free pages, its cache, its schema's version, and each table's and
 * index's bytes, from SQLite's dbstat, with each table's rows. Reading dbstat reads every page, so
 * the tab measures once every few minutes (control/system/local.ts).
 */

interface DbTable {
  name: string;
  kind: "table" | "index";
  /** The table an index is of. */
  of: string | null;
  bytes: number;
  /** Its rows; null for an index, and for a virtual table's own name. */
  rows: number | null;
}

export interface DbFigures {
  at: string;
  file_bytes: number;
  wal_bytes: number;
  page_size: number;
  pages: number;
  free_pages: number;
  /** The most SQLite keeps of the file in control's memory (its cache_size). */
  cache_bytes: number;
  schema_version: number | null;
  tables: DbTable[];
}

const fileBytes = (path: string) => {
  try {
    return statSync(path).size;
  } catch {
    // No such file: a write-ahead log SQLite has checkpointed and removed takes nothing.
    return 0;
  }
};

export interface StoreSize {
  /** control.db's figures now. */
  measure(now?: number): Promise<DbFigures>;
}

/** StoreSize on SQLite: each call answers at once (the store behind the interface, sqlite.ts). */
export class SqliteStoreSize extends StorePart {
  /** control.db's figures now. */
  measure(now = Date.now()): DbFigures {
    const db = this.db;
    const one = (sql: string) => Object.values(db.prepare(sql).get() ?? {})[0];
    const pageSize = Number(one("pragma page_size"));
    const cache = Number(one("pragma cache_size"));
    const schema = db
      .prepare("select type, name, tbl_name, sql from sqlite_schema where name not like 'sqlite_%'")
      .all() as { type: string; name: string; tbl_name: string; sql: string | null }[];
    const byName = new Map(schema.map((x) => [x.name, x]));
    const bytes = db
      .prepare("select name, sum(pgsize) as bytes from dbstat group by name")
      .all() as {
      name: string;
      bytes: number;
    }[];
    const tables: DbTable[] = bytes.map((b) => {
      const x = byName.get(b.name);
      const index = x?.type === "index";
      const plain = x?.type === "table" && !/^\s*create\s+virtual/i.test(x.sql ?? "");
      return {
        name: b.name,
        kind: index ? "index" : "table",
        of: index ? (x?.tbl_name ?? null) : null,
        bytes: Number(b.bytes),
        rows: plain ? Number(one(`select count(*) from "${b.name.replaceAll('"', '""')}"`)) : null,
      };
    });
    tables.sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name));
    let schemaVersion: number | null = null;
    try {
      schemaVersion = Number(one("select max(version) from schema_migrations")) || null;
    } catch {
      // A store with no migrations table yet: no version to say.
    }
    const path = this.store.path;
    const onDisk = path !== ":memory:";
    const pages = Number(one("pragma page_count"));
    return {
      at: new Date(now).toISOString(),
      file_bytes: onDisk ? fileBytes(path) : pages * pageSize,
      wal_bytes: onDisk ? fileBytes(`${path}-wal`) : 0,
      page_size: pageSize,
      pages,
      free_pages: Number(one("pragma freelist_count")),
      // A negative cache_size is in KiB, a positive one in pages.
      cache_bytes: cache < 0 ? -cache * 1024 : cache * pageSize,
      schema_version: schemaVersion,
      tables,
    };
  }
}
