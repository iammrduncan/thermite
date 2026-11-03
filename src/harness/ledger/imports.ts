import { LedgerPart, type Row } from "./part.ts";

/** The `import` table: the bundles and patches imported, by digest. */
export class LedgerImports extends LedgerPart {
  record(i: {
    kind: string;
    name?: string | undefined;
    sha256?: string | undefined;
    commitSha?: string | undefined;
    sourcePath: string;
    storedPath: string;
    actor: string;
  }): number {
    return this.tx(() => {
      const id = this.execute(
        "insert into import (kind, name, sha256, commit_sha, source_path, stored_path, verified_at) values (?, ?, ?, ?, ?, ?, ?)",
        i.kind,
        i.name ?? null,
        i.sha256 ?? null,
        i.commitSha ?? null,
        i.sourcePath,
        i.storedPath,
        this.now(),
      ).id;
      this.ledger.appendEvent(i.actor, "import_verified", i.kind, {
        name: i.name ?? null,
        sha256: i.sha256 ?? null,
        commit: i.commitSha ?? null,
      });
      return id;
    });
  }

  find(kind: string, key: { sha256?: string; commitSha?: string }): string | undefined {
    const r = key.sha256
      ? this.row<Row>(
          "select stored_path from import where kind = ? and sha256 = ? order by id desc",
          kind,
          key.sha256,
        )
      : this.row<Row>(
          "select stored_path from import where kind = ? and commit_sha = ? order by id desc",
          kind,
          key.commitSha ?? "",
        );
    return r ? String(r.stored_path) : undefined;
  }
}
