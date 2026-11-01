import { canonicalJson } from "../../core/canonical.ts";
import { LedgerPart, type Row } from "./part.ts";

/** The `build` table: the judge's builds, by key. */
export class LedgerBuilds extends LedgerPart {
  record(b: {
    key: string;
    repo: string;
    commit: string;
    kitCommit: string;
    ok: boolean;
    manifest: unknown;
    actor: string;
  }): void {
    this.tx(() => {
      this.execute(
        `insert into build (key, repo, commit_sha, kit_commit, ok, manifest, created_at) values (?, ?, ?, ?, ?, ?, ?)
           on conflict (key) do update set ok = excluded.ok, manifest = excluded.manifest`,
        b.key,
        b.repo,
        b.commit,
        b.kitCommit,
        b.ok ? 1 : 0,
        canonicalJson(b.manifest),
        this.now(),
      );
      this.ledger.appendEvent(b.actor, "build_recorded", b.key, {
        commit: b.commit,
        kit_commit: b.kitCommit,
        ok: b.ok,
      });
    });
  }

  /**
   * What a retention policy reads of each build the judge stored (harness/retention.ts): when it
   * was made, the newest run whose candidate or champion it built, whether a run it built for is
   * still open, whether it is a run's champion now or a lane's best, and whether a judge's job of
   * its commit is queued or under way (such a build is never removed).
   */
  retentionFacts(): {
    key: string;
    at: string;
    run: string | null;
    open: boolean;
    champion: boolean;
    busy: boolean;
  }[] {
    return this.rows<Row>(
      `select b.key, b.created_at,
         coalesce(
           (select a.run from attempt a where a.commit_sha = b.commit_sha order by a.created_at desc limit 1),
           (select c.run from champion c where c.commit_sha = b.commit_sha order by c.promoted_at desc limit 1)
         ) as run,
         (exists (select 1 from attempt a join run r on r.id = a.run
                  where a.commit_sha = b.commit_sha and r.status != 'closed')
          or exists (select 1 from champion c join run r on r.id = c.run
                  where c.commit_sha = b.commit_sha and r.status != 'closed')) as open,
         (exists (select 1 from champion c where c.commit_sha = b.commit_sha
                  and c.seq = (select max(c2.seq) from champion c2 where c2.run = c.run))
          or exists (select 1 from lane l join attempt a on a.id = l.lane_best_attempt
                  where a.commit_sha = b.commit_sha)) as champion,
         exists (select 1 from job j join attempt a on a.id = j.attempt
                 where a.commit_sha = b.commit_sha and j.state in ('queued', 'leased')) as busy
       from build b where b.ok = 1`,
    ).map((r) => ({
      key: String(r.key),
      at: String(r.created_at),
      run: r.run === null ? null : String(r.run),
      open: Number(r.open) === 1,
      champion: Number(r.champion) === 1,
      busy: Number(r.busy) === 1,
    }));
  }

  get(key: string): { ok: boolean; manifest: unknown } | undefined {
    const r = this.row<Row>("select ok, manifest from build where key = ?", key);
    return r ? { ok: Number(r.ok) === 1, manifest: JSON.parse(String(r.manifest)) } : undefined;
  }
}
