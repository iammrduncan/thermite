import {
  type CampaignProposal,
  type CampaignProposals,
  type ProposedField,
  proposalOf,
} from "../proposals.ts";
import { PgPart, type Row } from "./part.ts";

/** CampaignProposals on PostgreSQL: the store behind the interface (store.ts). */
export class PostgresCampaignProposals extends PgPart implements CampaignProposals {
  /**
   * Keeps a proposal; one of the same setting of the campaign still waiting is replaced by it (a
   * grant: one of the same collection).
   */
  async propose(p: {
    campaign: string;
    field: ProposedField;
    value: unknown;
    by: string;
  }): Promise<number> {
    return await this.tx(async () => {
      const now = new Date().toISOString();
      const value = p.value === undefined ? null : JSON.stringify(p.value);
      await this.q.run(
        `update campaign_proposal set decision = 'replaced', decided_by = ?, decided_at = ?
           where campaign = ? and field = ? and decision is null
             and (field != 'kb_grant' or value = ?)`,
        p.by,
        now,
        p.campaign,
        p.field,
        value,
      );
      const r = await this.q.insert(
        `insert into campaign_proposal (campaign, field, value, proposed_by, proposed_at)
           values (?, ?, ?, ?, ?)`,
        p.campaign,
        p.field,
        value,
        p.by,
        now,
      );
      return r;
    });
  }

  async get(id: number): Promise<CampaignProposal | undefined> {
    const r = (await this.q.get("select * from campaign_proposal where id = ?", id)) as
      | Row
      | undefined;
    return r ? proposalOf(r) : undefined;
  }

  /** The proposals waiting for the owner, oldest first; of one campaign when it is given. */
  async waiting(campaign?: string): Promise<CampaignProposal[]> {
    const rows = (
      campaign === undefined
        ? await this.q.all("select * from campaign_proposal where decision is null order by id")
        : await this.q.all(
            "select * from campaign_proposal where decision is null and campaign = ? order by id",
            campaign,
          )
    ) as Row[];
    return rows.map(proposalOf);
  }

  /** Records the owner's decision; false when it no longer waits. */
  async decide(id: number, decision: "approved" | "declined", by: string): Promise<boolean> {
    const r = await this.q.run(
      `update campaign_proposal set decision = ?, decided_by = ?, decided_at = ?
         where id = ? and decision is null`,
      decision,
      by,
      new Date().toISOString(),
      id,
    );
    return Number(r.changes) > 0;
  }
}
