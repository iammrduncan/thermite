import { StorePart } from "./part.ts";

/**
 * Champions' patches (goal 125, T6), by the rig and ledger of the run that published them. The
 * caller (control/champions.ts) keeps one only when it is the one the rig published.
 */

export class ChampionPatches extends StorePart {
  /**
   * A champion's patch, which the caller found to be the one the run published in this ledger
   * as champion `seq`, with its SHA-256 and base commit. One kept already stays.
   */
  put(
    rig: string,
    ledgerId: string,
    run: string,
    seq: number,
    published: { sha256: string; base_commit: string },
    patch: Buffer,
  ): void {
    this.db
      .prepare(
        `insert or ignore into champion_patch
           (rig, ledger_id, run, seq, sha256, base_commit, patch, received_at)
           values (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
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
  get(
    rig: string,
    ledgerId: string | null,
    run: string,
    seq: number,
  ): { patch: Buffer; sha256: string; base_commit: string } | undefined {
    const r = this.db
      .prepare(
        `select patch, sha256, base_commit from champion_patch
           where rig = ? and ledger_id = ? and run = ? and seq = ?`,
      )
      .get(rig, ledgerId ?? "", run, seq) as
      | { patch: Uint8Array; sha256: string; base_commit: string }
      | undefined;
    return r
      ? { patch: Buffer.from(r.patch), sha256: r.sha256, base_commit: r.base_commit }
      : undefined;
  }
}
