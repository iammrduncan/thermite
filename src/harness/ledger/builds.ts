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

  get(key: string): { ok: boolean; manifest: unknown } | undefined {
    const r = this.row<Row>("select ok, manifest from build where key = ?", key);
    return r ? { ok: Number(r.ok) === 1, manifest: JSON.parse(String(r.manifest)) } : undefined;
  }
}
