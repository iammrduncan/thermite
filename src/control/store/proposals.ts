import type { DatabaseSync } from "node:sqlite";
import { type Row, StorePart } from "./part.ts";

/**
 * Changes the operator proposes to a campaign's own settings that the owner approves first: the
 * additions to its roles, which roles write in its collection, and another campaign's collection
 * its agents read (a grant). Each waits until the owner approves or declines it on the campaign's
 * page; a newer proposal of the same setting replaces one still waiting (of a grant: of the same
 * collection). Nothing is deleted: each keeps who proposed it and who decided.
 */

/**
 * The settings a proposal may change: a field of the campaign's contract, or a grant of another
 * campaign's collection (its value is that campaign's name).
 */
export const PROPOSED_FIELDS = ["role_additions", "kb_writes", "kb_grant"] as const;
export type ProposedField = (typeof PROPOSED_FIELDS)[number];

/** A proposal as the store keeps it. */
export interface CampaignProposal {
  id: number;
  campaign: string;
  field: ProposedField;
  /** The setting proposed, as its request gives it; null: none (removed, or the default). */
  value: unknown;
  proposed_by: string;
  proposed_at: string;
  /** Null while it waits for the owner. */
  decision: "approved" | "declined" | "replaced" | null;
  decided_by: string | null;
  decided_at: string | null;
}

/** The proposals' table (store migration 16). */
export function campaignProposalTable(db: DatabaseSync): void {
  db.exec(`create table if not exists campaign_proposal (
  id integer primary key autoincrement,
  campaign text not null,
  field text not null check (field in ('role_additions', 'kb_writes')),
  value text,
  proposed_by text not null,
  proposed_at text not null,
  decision text check (decision in ('approved', 'declined', 'replaced')),
  decided_by text,
  decided_at text
)`);
}

/**
 * Store migration 18: proposals may grant another campaign's collection too. SQLite can't change a
 * table's check, so the table is made again with its rows.
 */
export function campaignProposalGrants(db: DatabaseSync): void {
  db.exec(`create table campaign_proposal_18 (
  id integer primary key autoincrement,
  campaign text not null,
  field text not null check (field in ('role_additions', 'kb_writes', 'kb_grant')),
  value text,
  proposed_by text not null,
  proposed_at text not null,
  decision text check (decision in ('approved', 'declined', 'replaced')),
  decided_by text,
  decided_at text
)`);
  db.exec("insert into campaign_proposal_18 select * from campaign_proposal");
  db.exec("drop table campaign_proposal");
  db.exec("alter table campaign_proposal_18 rename to campaign_proposal");
}

const proposalOf = (r: Row): CampaignProposal => ({
  id: Number(r.id),
  campaign: String(r.campaign),
  field: PROPOSED_FIELDS.find((f) => f === r.field) ?? "role_additions",
  value: r.value === null ? null : (JSON.parse(String(r.value)) as unknown),
  proposed_by: String(r.proposed_by),
  proposed_at: String(r.proposed_at),
  decision: r.decision === null ? null : (String(r.decision) as CampaignProposal["decision"]),
  decided_by: r.decided_by === null ? null : String(r.decided_by),
  decided_at: r.decided_at === null ? null : String(r.decided_at),
});

export class CampaignProposals extends StorePart {
  /**
   * Keeps a proposal; one of the same setting of the campaign still waiting is replaced by it (a
   * grant: one of the same collection).
   */
  propose(p: { campaign: string; field: ProposedField; value: unknown; by: string }): number {
    return this.tx(() => {
      const now = new Date().toISOString();
      const value = p.value === undefined ? null : JSON.stringify(p.value);
      this.db
        .prepare(
          `update campaign_proposal set decision = 'replaced', decided_by = ?, decided_at = ?
           where campaign = ? and field = ? and decision is null
             and (field != 'kb_grant' or value = ?)`,
        )
        .run(p.by, now, p.campaign, p.field, value);
      const r = this.db
        .prepare(
          `insert into campaign_proposal (campaign, field, value, proposed_by, proposed_at)
           values (?, ?, ?, ?, ?)`,
        )
        .run(p.campaign, p.field, value, p.by, now);
      return Number(r.lastInsertRowid);
    });
  }

  get(id: number): CampaignProposal | undefined {
    const r = this.db.prepare("select * from campaign_proposal where id = ?").get(id) as
      | Row
      | undefined;
    return r ? proposalOf(r) : undefined;
  }

  /** The proposals waiting for the owner, oldest first; of one campaign when it is given. */
  waiting(campaign?: string): CampaignProposal[] {
    const rows = (
      campaign === undefined
        ? this.db
            .prepare("select * from campaign_proposal where decision is null order by id")
            .all()
        : this.db
            .prepare(
              "select * from campaign_proposal where decision is null and campaign = ? order by id",
            )
            .all(campaign)
    ) as Row[];
    return rows.map(proposalOf);
  }

  /** Records the owner's decision; false when it no longer waits. */
  decide(id: number, decision: "approved" | "declined", by: string): boolean {
    const r = this.db
      .prepare(
        `update campaign_proposal set decision = ?, decided_by = ?, decided_at = ?
         where id = ? and decision is null`,
      )
      .run(decision, by, new Date().toISOString(), id);
    return Number(r.changes) > 0;
  }
}
