import type { ChampionPatches } from "../champions.ts";
import { PgPart } from "./part.ts";

/** ChampionPatches on PostgreSQL: the store behind the interface (store.ts). */
export class PostgresChampionPatches extends PgPart implements ChampionPatches {
  /**
   * A champion's patch, which the caller found to be the one the run published in this ledger
   * as champion `seq`, with its SHA-256 and base commit. One kept already stays.
   */
  async put(
    rig: string,
    ledgerId: string,
    run: string,
    seq: number,
    published: { sha256: string; base_commit: string },
    patch: Buffer,
  ): Promise<void> {
    await this.q.run(
      `insert into champion_patch
           (rig, ledger_id, run, seq, sha256, base_commit, patch, received_at)
           values (?, ?, ?, ?, ?, ?, ?, ?) on conflict do nothing`,
      rig,
      ledgerId,
      run,
      seq,
      published.sha256,
      published.base_commit,
      patch,
      new Date().toISOString(),
    );
  }

  /**
   * The patch of champion `seq` of a run, in the ledger its view gives (RigView.ledger_id): none
   * until it arrives.
   */
  async get(
    rig: string,
    ledgerId: string | null,
    run: string,
    seq: number,
  ): Promise<{ patch: Buffer; sha256: string; base_commit: string } | undefined> {
    const r = (await this.q.get(
      `select patch, sha256, base_commit from champion_patch
           where rig = ? and ledger_id = ? and run = ? and seq = ?`,
      rig,
      ledgerId ?? "",
      run,
      seq,
    )) as { patch: Uint8Array; sha256: string; base_commit: string } | undefined;
    return r
      ? { patch: Buffer.from(r.patch), sha256: r.sha256, base_commit: r.base_commit }
      : undefined;
  }
}
