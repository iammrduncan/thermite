import type { DatabaseSync } from "node:sqlite";

/**
 * What a run reads in the knowledge base (goal 175): its campaign's whole collection, or its own
 * run alone when it starts fresh, and the granted collections it includes. Start a run sets it as
 * the run starts, and it stays so: nothing changes it later. A grant revoked since leaves it, as it
 * leaves the campaign; one given since does not join it. A run with none set (one started before
 * runs had a scope, or assigned another way) reads the whole collection and the grants its
 * campaign had when control assigned or saw the run, and still has (goal 176, question 2); a run
 * control has no record of, every grant its campaign has now.
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
  if (!r) {
    const started = (
      db
        .prepare(
          "select min(coalesce(assigned_at, created_at)) as at from run_registry where run = ?",
        )
        .get(run) as { at: string | null } | undefined
    )?.at;
    if (!started) return { fresh: false, granted: [...reads] };
    const before = new Set(
      (
        db
          .prepare("select reads from kb_read where campaign = ? and granted_at <= ?")
          .all(campaign, started) as { reads: string }[]
      ).map((g) => g.reads),
    );
    return { fresh: false, granted: reads.filter((c) => before.has(c)) };
  }
  const named = JSON.parse(r.granted) as string[];
  // A grant removed since stays out: a scope never reads past what the campaign may read.
  return { fresh: r.fresh === 1, granted: named.filter((c) => reads.includes(c)) };
}

/**
 * Keeps a run's scope as it starts, its granted collections among `reads`. Throws, in words, on a
 * collection its campaign may not read, and on a run whose scope is kept already.
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
  const kept = Number(
    db
      .prepare(
        `insert into kb_scope (campaign, run, fresh, granted, set_by, set_at) values (?, ?, ?, ?, ?, ?)
         on conflict (campaign, run) do nothing`,
      )
      .run(
        s.campaign,
        s.run,
        s.fresh ? 1 : 0,
        JSON.stringify([...new Set(s.granted)]),
        by,
        new Date().toISOString(),
      ).changes,
  );
  if (!kept) throw new Error(`run ${s.run}'s scope was set when it started, and stays so`);
}
