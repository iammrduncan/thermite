import { canonicalJson } from "../../../core/canonical.ts";
import type { CampaignSources, CampaignVersions, CopiedFrom } from "../campaigns.ts";
import { PgPart, type Row } from "./part.ts";

/** CampaignVersions on PostgreSQL: the store behind the interface (store.ts). */
export class PostgresCampaignVersions extends PgPart implements CampaignVersions {
  /** The campaigns whose latest version fetches its project or kit with this Git access. */
  async usingGitAccess(name: string): Promise<string[]> {
    const latest = new Map<string, CampaignSources>();
    const rows = (await this.q.all(
      "select campaign, sources from campaign_version order by version desc",
    )) as { campaign: string; sources: string }[];
    for (const r of rows) {
      if (latest.has(r.campaign)) continue;
      try {
        latest.set(r.campaign, JSON.parse(r.sources) as CampaignSources);
      } catch {
        latest.set(r.campaign, {});
      }
    }
    return [...latest]
      .filter(
        ([, s]) =>
          s.project?.access === name ||
          (s.kit !== undefined && "git" in s.kit && s.kit.access === name),
      )
      .map(([c]) => c)
      .sort();
  }

  /** The next version number for a campaign created on control (1 for a new one). */
  async nextVersion(campaign: string): Promise<number> {
    const r = (await this.q.get(
      "select max(version) as v from campaign_version where campaign = ?",
      campaign,
    )) as { v: number | null };
    return (r.v ?? 0) + 1;
  }

  /**
   * Stores a campaign version, approved by whoever created it, with where its runs fetch from
   * and, for a copy, where it was copied from. The campaign's collection in the knowledge base is
   * made with its first version.
   */
  async put(c: {
    campaign: string;
    version: number;
    contract: unknown;
    sha: string;
    sources?: CampaignSources | undefined;
    copiedFrom?: CopiedFrom | undefined;
    by: string;
  }): Promise<void> {
    await this.q.run(
      `insert into campaign_version (campaign, version, contract, sha, sources, created_at, created_by, approved_by, copied_from)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      c.campaign,
      c.version,
      canonicalJson(c.contract),
      c.sha,
      canonicalJson(c.sources ?? {}),
      new Date().toISOString(),
      c.by,
      c.by,
      c.copiedFrom ? canonicalJson(c.copiedFrom) : null,
    );
    await this.store.kb().makeCollection(c.campaign);
    await this.store.auditLog.add(c.by, "campaign_version_created", {
      campaign: c.campaign,
      version: c.version,
      sha: c.sha,
    });
  }

  /** Every campaign version created on control, newest first. */
  async versions(campaign?: string): Promise<
    {
      campaign: string;
      version: number;
      contract: unknown;
      sha: string;
      sources: CampaignSources;
      created_at: string;
      created_by: string;
      /** For a copy: where it was copied from; null otherwise. */
      copied_from: CopiedFrom | null;
    }[]
  > {
    const rows = (
      campaign
        ? await this.q.all(
            "select * from campaign_version where campaign = ? order by version desc",
            campaign,
          )
        : await this.q.all("select * from campaign_version order by created_at desc")
    ) as Row[];
    return rows.map((r) => ({
      campaign: String(r.campaign),
      version: Number(r.version),
      contract: JSON.parse(String(r.contract)),
      sha: String(r.sha),
      sources: JSON.parse(String(r.sources ?? "{}")) as CampaignSources,
      created_at: String(r.created_at),
      created_by: String(r.created_by),
      copied_from: r.copied_from ? (JSON.parse(String(r.copied_from)) as CopiedFrom) : null,
    }));
  }
}
