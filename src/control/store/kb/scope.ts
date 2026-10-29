import type { DatabaseSync } from "node:sqlite";

/**
 * What a run reads in the knowledge base (goal 175): its campaign's whole collection, or its own
 * run alone when it starts fresh, and the granted collections it includes. The data only: a search
 * reads it in a later step, and Start a run sets it then. A run with none set reads the whole
 * collection and every grant.
 */
export interface KbScope {
  /** True: its own run's items alone, of its campaign's collection. */
  fresh: boolean;
  /** The granted collections it includes: never one its campaign may not read now. */
  granted: string[];
}

/** A run's scope, within `reads`, the collections its campaign is granted now. */
export function scopeOf(
  db: DatabaseSync,
  reads: readonly string[],
  campaign: string,
  run: string,
): KbScope {
  const r = db
    .prepare("select fresh, granted from kb_scope where campaign = ? and run = ?")
    .get(campaign, run) as { fresh: number; granted: string } | undefined;
  if (!r) return { fresh: false, granted: [...reads] };
  const named = JSON.parse(r.granted) as string[];
  // A grant removed since stays out: a scope never reads past what the campaign may read.
  return { fresh: r.fresh === 1, granted: named.filter((c) => reads.includes(c)) };
}

/**
 * Keeps a run's scope, its granted collections among `reads`. Throws, in words, on a collection
 * its campaign may not read.
 */
export function keepScope(
  db: DatabaseSync,
  reads: readonly string[],
  s: { campaign: string; run: string } & KbScope,
  by: string,
): void {
  const not = s.granted.filter((c) => !reads.includes(c));
  if (not.length)
    throw new Error(
      `${s.campaign} may not read ${not.join(", ")}: the owner grants a collection first`,
    );
  db.prepare(
    `insert into kb_scope (campaign, run, fresh, granted, set_by, set_at) values (?, ?, ?, ?, ?, ?)
     on conflict (campaign, run) do update set fresh = excluded.fresh, granted = excluded.granted,
       set_by = excluded.set_by, set_at = excluded.set_at`,
  ).run(
    s.campaign,
    s.run,
    s.fresh ? 1 : 0,
    JSON.stringify([...new Set(s.granted)]),
    by,
    new Date().toISOString(),
  );
}
