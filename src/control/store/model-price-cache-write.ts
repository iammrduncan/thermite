import type { DatabaseSync } from "node:sqlite";

/**
 * Cache writes in model usage (goal 195): the cache-write price the owner sets for a provider's
 * model, beside the input and output prices, and the input tokens each model call wrote to the
 * provider's cache. A price or a record from before this migration leaves both null.
 */

/** The columns, made by the store's migration to schema version 37. */
export function modelPriceCacheWrite(db: DatabaseSync): void {
  const cols = (table: string) =>
    (db.prepare(`pragma table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
  if (!cols("model_price").includes("cache_write"))
    db.exec("alter table model_price add column cache_write real");
  if (!cols("model_call").includes("cache_write_in"))
    db.exec("alter table model_call add column cache_write_in integer");
}
