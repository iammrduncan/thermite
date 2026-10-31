import { canonicalJson } from "../../core/canonical.ts";
import { type Row, StorePart } from "./part.ts";

/**
 * Campaign versions created on control (goal 125, T6), each with where its runs fetch from.
 */

/** Where a campaign version's runs fetch from: no secrets, only addresses and access names. */
export interface CampaignSources {
  project?: { url: string; access?: string | undefined; repo: string; commit: string } | undefined;
  kit?: { control: string } | { git: string; access?: string | undefined } | undefined;
  /**
   * The MCP servers the campaign's kit names (goal 068), with the agents that get each one: as
   * control wrote or read them into a kit it keeps, or as the page read them from a kit in a
   * repository (the rig's harness checks them against the kit's kit.json).
   */
  mcp_servers?: unknown;
  /**
   * A copy of a campaign control knew only by an assignment (goal 069): that assignment's
   * starting point, imports and MCP servers, without its run, contract and run options. The
   * copy's runs take them as they are, as Start a run assigns such a campaign again.
   */
  assignment?: Record<string, unknown> | undefined;
}

/**
 * Where a copied campaign came from (goal 069): the campaign, and the version copied, or the
 * assignment copied (its rig and run) for a campaign control knew only by an assignment.
 */
export interface CopiedFrom {
  campaign: string;
  version?: number | undefined;
  rig?: string | undefined;
  run?: string | undefined;
  /** True when the copy's contract names other MCP servers than its source's (a research copy). */
  other_mcp_servers?: true | undefined;
}

export class CampaignVersions extends StorePart {
  /** The campaigns whose latest version fetches its project or kit with this Git access. */
  usingGitAccess(name: string): string[] {
    const latest = new Map<string, CampaignSources>();
    const rows = this.db
      .prepare("select campaign, sources from campaign_version order by version desc")
      .all() as { campaign: string; sources: string }[];
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
  nextVersion(campaign: string): number {
    const r = this.db
      .prepare("select max(version) as v from campaign_version where campaign = ?")
      .get(campaign) as { v: number | null };
    return (r.v ?? 0) + 1;
  }

  /**
   * Stores a campaign version, approved by whoever created it, with where its runs fetch from
   * and, for a copy, where it was copied from. The campaign's collection in the knowledge base is
   * made with its first version.
   */
  put(c: {
    campaign: string;
    version: number;
    contract: unknown;
    sha: string;
    sources?: CampaignSources | undefined;
    copiedFrom?: CopiedFrom | undefined;
    by: string;
  }): void {
    this.db
      .prepare(
        `insert into campaign_version (campaign, version, contract, sha, sources, created_at, created_by, approved_by, copied_from)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
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
    this.store.kb().makeCollection(c.campaign);
    this.store.auditLog.add(c.by, "campaign_version_created", {
      campaign: c.campaign,
      version: c.version,
      sha: c.sha,
    });
  }

  /** Every campaign version created on control, newest first. */
  versions(campaign?: string): {
    campaign: string;
    version: number;
    contract: unknown;
    sha: string;
    sources: CampaignSources;
    created_at: string;
    created_by: string;
    /** For a copy: where it was copied from; null otherwise. */
    copied_from: CopiedFrom | null;
  }[] {
    const rows = (
      campaign
        ? this.db
            .prepare("select * from campaign_version where campaign = ? order by version desc")
            .all(campaign)
        : this.db.prepare("select * from campaign_version order by created_at desc").all()
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
