import type { Sql } from "../../../../common/postgres.ts";
import type { KbScope } from "../scope.ts";

/** A run's scope, within `reads`, the collections its campaign is granted now. */
export async function scopeOf(
  q: Sql,
  reads: readonly string[],
  campaign: string,
  run: string,
): Promise<KbScope> {
  const r = (await q.get(
    "select fresh, granted, set_at from kb_scope where campaign = ? and run = ?",
    campaign,
    run,
  )) as { fresh: number; granted: string; set_at: string } | undefined;
  if (!r) return { fresh: false, granted: [...reads] };
  const since = (
    (await q.all(
      "select reads from kb_read where campaign = ? and granted_at > ?",
      campaign,
      r.set_at,
    )) as { reads: string }[]
  ).map((g) => g.reads);
  const named = [...(JSON.parse(r.granted) as string[]), ...since];
  // A grant removed since stays out: a scope never reads past what the campaign may read.
  return { fresh: r.fresh === 1, granted: [...new Set(named)].filter((c) => reads.includes(c)) };
}

/**
 * Keeps a run's scope as it starts, its granted collections among `reads`. Throws, in words, on a
 * collection its campaign may not read, and on a run whose scope is kept already.
 */
export async function keepScope(
  q: Sql,
  reads: readonly string[],
  s: { campaign: string; run: string } & KbScope,
  by: string,
): Promise<void> {
  const not = s.granted.filter((c) => !reads.includes(c));
  if (not.length)
    throw new Error(
      `${s.campaign} may not read ${not.join(", ")}: the owner grants a collection first`,
    );
  const kept = Number(
    (
      await q.run(
        `insert into kb_scope (campaign, run, fresh, granted, set_by, set_at) values (?, ?, ?, ?, ?, ?)
         on conflict (campaign, run) do nothing`,
        s.campaign,
        s.run,
        s.fresh ? 1 : 0,
        JSON.stringify([...new Set(s.granted)]),
        by,
        new Date().toISOString(),
      )
    ).changes,
  );
  if (!kept) throw new Error(`run ${s.run}'s scope was set when it started, and stays so`);
}
