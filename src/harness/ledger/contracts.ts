import { canonicalJson } from "../../core/canonical.ts";
import type { Contract } from "../../core/contract.ts";
import { LedgerError, LedgerPart, type Row } from "./part.ts";

/** The `contract` table: the campaigns' contracts, by version. */
export class LedgerContracts extends LedgerPart {
  /**
   * Stores a contract version. Re-storing the same content is a no-op. A different content for an
   * existing version is a conflict, and a new version must be greater than every stored version.
   */
  store(contract: Contract, sha: string, actor: string): "created" | "exists" {
    return this.tx(() => {
      const same = this.row<Row>(
        "select sha from contract where campaign = ? and version = ?",
        contract.campaign,
        contract.version,
      );
      if (same) {
        if (same.sha === sha) return "exists";
        throw new LedgerError(
          "conflict",
          `contract ${contract.campaign} v${contract.version} already exists with different content; bump the version`,
        );
      }
      const latest = this.row<Row>(
        "select max(version) as v from contract where campaign = ?",
        contract.campaign,
      );
      const latestVersion = latest?.v === null || latest?.v === undefined ? 0 : Number(latest.v);
      if (contract.version <= latestVersion) {
        throw new LedgerError(
          "conflict",
          `contract ${contract.campaign} v${contract.version} is not newer than v${latestVersion}`,
        );
      }
      this.execute(
        "insert into contract (campaign, version, sha, mode, body, created_at) values (?, ?, ?, ?, ?, ?)",
        contract.campaign,
        contract.version,
        sha,
        contract.mode,
        canonicalJson(contract),
        this.now(),
      );
      this.ledger.appendEvent(actor, "contract_stored", contract.campaign, {
        version: contract.version,
        sha,
        mode: contract.mode,
      });
      return "created";
    });
  }

  versions(campaign: string): { version: number; sha: string; mode: string }[] {
    return this.rows<Row>(
      "select version, sha, mode from contract where campaign = ? order by version",
      campaign,
    ).map((r) => ({ version: Number(r.version), sha: String(r.sha), mode: String(r.mode) }));
  }

  get(campaign: string, version: number): Contract | undefined {
    const r = this.row<Row>(
      "select body from contract where campaign = ? and version = ?",
      campaign,
      version,
    );
    return r ? (JSON.parse(String(r.body)) as Contract) : undefined;
  }
}
