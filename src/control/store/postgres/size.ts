import type { DbFigures, StoreSize } from "../size.ts";
import { PgPart } from "./part.ts";

/**
 * The store's own size on PostgreSQL, as the server counts it, for Metrics' Storage tab (../
 * size.ts): the database's bytes, its pages, the server's shared cache, the schema's version, and
 * each table's and index's bytes with each table's rows. The server's write-ahead log is the
 * whole server's, not this database's, so none is counted; PostgreSQL keeps no list of free
 * pages.
 */
export class PostgresStoreSize extends PgPart implements StoreSize {
  async measure(now = Date.now()): Promise<DbFigures> {
    const one = async (sql: string) => Object.values((await this.q.get(sql)) ?? {})[0];
    const pageSize = Number(await one("select current_setting('block_size')"));
    const bytes = Number(await one("select pg_database_size(current_database())"));
    const relations = await this.q.all(
      `select c.relname as name, c.relkind as kind, t.relname as of,
         (case when c.relkind = 'r' then pg_table_size(c.oid) else pg_relation_size(c.oid) end) as bytes
       from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
         left join pg_index i on i.indexrelid = c.oid
         left join pg_class t on t.oid = i.indrelid
       where n.nspname = current_schema() and c.relkind in ('r', 'i')`,
    );
    const tables: DbFigures["tables"] = [];
    for (const r of relations) {
      const name = String(r.name);
      const index = r.kind === "i";
      tables.push({
        name,
        kind: index ? "index" : "table",
        of: index ? String(r.of) : null,
        bytes: Number(r.bytes),
        rows: index
          ? null
          : Number(await one(`select count(*) from "${name.replaceAll('"', '""')}"`)),
      });
    }
    tables.sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name));
    return {
      at: new Date(now).toISOString(),
      file_bytes: bytes,
      wal_bytes: 0,
      page_size: pageSize,
      pages: Math.ceil(bytes / pageSize),
      free_pages: 0,
      cache_bytes: Number(await one("select pg_size_bytes(current_setting('shared_buffers'))")),
      schema_version: Number(await one("select max(version) from schema_migrations")) || null,
      tables,
    };
  }
}
