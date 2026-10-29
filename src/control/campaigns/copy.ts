import { z } from "zod";
import { BRIEF_PARTS, briefChange } from "../../core/brief.ts";
import { type AgentsContext, agentsContextRefusal } from "../../core/compaction.ts";
import { IdSchema, parseContract } from "../../core/contract.ts";
import { isRigCheck, NAME_WORDS } from "../../core/ids.ts";
import { type McpUse, McpUses, sameUses, usesWords } from "../../core/mcp.ts";
import { researchMcpRefusal } from "../mcp-servers/index.ts";
import type { ControlParts } from "../parts.ts";
import type { CampaignSources, ControlStore, CopiedFrom } from "../store/index.ts";
import { campaignModes } from "../views/index.ts";

/**
 * Copy a campaign (goal 069): a new campaign with another name, the same contract and the same
 * kit as the source's newest saved version or, for a campaign control knows only by an
 * assignment, as that assignment. Control saves the copy as its first version, with the new name
 * in its contract, so its contract hash is its own. The copy has no runs: Start a run starts one.
 * Its collection in Thermite's knowledge base is its own and empty, and no grant names it, so its
 * runs read nothing that the source's runs recorded. That is what two runs of one campaign can't
 * do: they share the campaign's collection.
 *
 * A research campaign keeps its agents' MCP servers in its contract (it has no kit), so a copy may
 * name others (`mcp_servers`), with the New campaign page's checks: the copy's contract then
 * names those, and its hash changes with them. A hill-climb or goal campaign keeps them in its
 * kit's kit.json, which a copy does not change.
 *
 * A copy may set its own context settings for its runs' agents (`agents_context`, goal 070), in
 * place of its source's: its contract then holds them, and its hash changes with them.
 *
 * A copy keeps its source's brief (goal 078): the additional information, the starting links,
 * the ideas to try and the hypotheses, in its contract. It may give its own (`notes`, `links`,
 * `ideas`, `hypotheses`), each in place of its source's: its hash then changes with them.
 *
 * REST's POST /v1/campaigns/<name>/copy, MCP's copy_campaign and `thermite campaign copy` call it
 * through copyACampaign, with the campaigns control knows from its rigs' reports too.
 */

export interface CopyCampaignRequest {
  /** The campaign to copy. */
  from: string;
  /** The copy's name. */
  name: string;
  /**
   * A research campaign's MCP servers for the copy, in place of its source's; [] names none.
   * Left out: the source's, as they are.
   */
  mcp_servers?: McpUse[] | undefined;
  /**
   * The copy's own context settings for its runs' agents, in place of its source's; null or {}:
   * none. Left out: the source's, as they are.
   */
  agents_context?: { context_window?: number | undefined; compact_at?: number | undefined } | null;
  /** The copy's own additional information (Markdown), in place of its source's; "" or null: none. */
  notes?: string | null | undefined;
  /** The copy's own starting links (a research campaign's seeds), in place of its source's; []: none. */
  links?: string[] | undefined;
  /** The copy's own ideas to try (hill climb and goal), in place of its source's; []: none. */
  ideas?: string[] | undefined;
  /** The copy's own hypotheses, in place of its source's; []: none. */
  hypotheses?: string[] | undefined;
}

export type CopyCampaignOutcome =
  | {
      state: "copied";
      campaign: string;
      version: number;
      sha: string;
      from: CopiedFrom;
      /** The copy's own context settings for its runs' agents, when it has any. */
      context?: AgentsContext | undefined;
    }
  | { state: "refused"; error: string; status: 400 | 404 | 409 };

/** The request's field over REST and MCP, besides the campaign to copy. */
export const copyCampaignFields = {
  name: z
    .string()
    .describe(
      `The copy's name, as on the New campaign page: ${NAME_WORDS}. No campaign may have it yet`,
    ),
  mcp_servers: McpUses.optional().describe(
    'Research campaigns only: the MCP servers the copy\'s agents use, in place of the source\'s, as the New campaign page names them. Each is {name, agents, tools?}: a server\'s name in Settings; the kinds of agent that get it ("workers", "advisors": a research run has no planner); and, only to narrow it, the tools each kind may call, such as {"workers": ["search"]}. [] names none. Left out: the source\'s servers',
  ),
  // Any numbers: values out of range are refused in words.
  agents_context: z
    .strictObject({
      context_window: z.number().int().optional(),
      compact_at: z.number().optional(),
    })
    .nullable()
    .optional()
    .describe(
      "The copy's own context settings for its runs' agents, in place of the source's, as set_campaign_context takes them: {context_window, compact_at}. Each agent's window is the lower of context_window and its own model's; compact_at replaces the rig's point. null or {}: none. Left out: the source's",
    ),
  notes: z
    .string()
    .nullable()
    .optional()
    .describe(
      "The copy's own additional information for its agents, in Markdown, in place of the source's: background, links, what was tried, limits, what good looks like. No length limit of its own. \"\" or null: none. Left out: the source's",
    ),
  links: z
    .array(z.string())
    .optional()
    .describe(
      "The copy's own starting links, one address each, in place of the source's: pages its agents get with the brief. For a research campaign they are its seeds, which the harness fetches and archives when a run starts. []: none. Left out: the source's",
    ),
  ideas: z
    .array(z.string())
    .optional()
    .describe(
      "Hill-climb and goal campaigns: the copy's own ideas to try, one entry each, in place of the source's. The planner and the workers get them as starting points, not rules. []: none. Left out: the source's",
    ),
  hypotheses: z
    .array(z.string())
    .optional()
    .describe(
      "The copy's own hypotheses, one entry each, in place of the source's: what the author thinks is true, for the agents to test. A research run starts with them as its hypotheses. []: none. Left out: the source's",
    ),
};

/** The REST body: the copy's name, its MCP servers (research) and its context settings. */
export const CopyCampaignBody = z.strictObject(copyCampaignFields);

/**
 * The fields of an assignment that belong to one run, not to the campaign: a copy leaves them
 * out, as does a new version saved for a campaign's own context settings (campaigns/context.ts).
 */
export const RUN_FIELDS = new Set([
  "run",
  "contract",
  "contract_sha",
  "agents",
  "promotion",
  "ask_owner",
  "queue",
  "briefing",
]);

/**
 * Copies a campaign, or says in words why not. `known`: every campaign name control knows (from
 * rigs' reports, saved versions, assignments and the knowledge base's collections), none of which a
 * copy may take.
 */
export function copyCampaign(
  store: ControlStore,
  req: CopyCampaignRequest,
  by: string,
  known: ReadonlyMap<string, unknown> | ReadonlySet<string>,
): CopyCampaignOutcome {
  const refuse = (error: string, status: 400 | 404 | 409 = 409): CopyCampaignOutcome => ({
    state: "refused",
    error,
    status,
  });
  const { from, name } = req;
  if (isRigCheck(from))
    return refuse(`${from} is a rig check's campaign. A rig check cannot be copied.`, 400);
  const saved = store.campaigns.versions(from)[0];
  const assigned = saved ? undefined : store.commands.latestAssignments().get(from);
  if (!saved && !assigned)
    return refuse(
      `Control has no saved version or earlier assignment of ${from}. There is nothing to copy.`,
      404,
    );
  if (!IdSchema.safeParse(name).success) return refuse(`A campaign's name is ${NAME_WORDS}.`, 400);
  if (isRigCheck(name))
    return refuse(
      "A name that starts with rig-check- is for rig checks. Choose another name.",
      400,
    );
  const kb = store.kb();
  if (known.has(name) || kb.reads(name).length || kb.readBy(name).length)
    return refuse(`There is a campaign named ${name} already. Choose another name.`, 409);
  const version = store.campaigns.nextVersion(name);
  const source = (saved?.contract ?? assigned?.payload.contract) as Record<string, unknown>;
  // The contract names its campaign once: the copy's name, and its first version, there.
  let contract: Record<string, unknown> = { ...source, campaign: name, version };
  let otherMcp = false;
  const uses = req.mcp_servers;
  if (uses !== undefined) {
    if (source.mode !== "research")
      return refuse(
        "This campaign's MCP servers are in its kit's kit.json: change them on the New campaign page.",
        400,
      );
    const why = researchMcpRefusal(store, uses);
    if (why) return refuse(why, 400);
    const { mcp_servers: before, ...rest } = contract;
    contract = uses.length ? { ...rest, mcp_servers: uses } : rest;
    otherMcp = !sameUses(McpUses.safeParse(before ?? []).data ?? [], uses);
  }
  // The copy's own context settings for its runs' agents (goal 070), in place of the source's.
  const ctx = req.agents_context;
  if (ctx !== undefined) {
    const why = agentsContextRefusal(ctx ?? {});
    if (why) return refuse(why, 400);
    const { agents_context: _source, ...rest } = contract;
    const own = ctx
      ? {
          ...(ctx.context_window !== undefined ? { context_window: ctx.context_window } : {}),
          ...(ctx.compact_at !== undefined ? { compact_at: ctx.compact_at } : {}),
        }
      : {};
    contract = Object.keys(own).length ? { ...rest, agents_context: own } : rest;
  }
  // The copy's own brief (goal 078): each part given replaces the source's.
  const before = contract;
  const brief = briefChange(contract, req);
  if (typeof brief === "string") return refuse(brief, 400);
  contract = brief;
  const parsed = parseContract(contract);
  if (!parsed.ok)
    // The copy's own brief can be what is wrong, not the source: say whose it is.
    return refuse(
      brief !== before && parseContract(before).ok
        ? `The copy's own brief is not valid: ${parsed.errors.join("; ")}`
        : `The contract of ${from} is not valid, so control cannot copy it: ${parsed.errors.join("; ")}`,
    );
  let sources: CampaignSources;
  let copiedFrom: CopiedFrom;
  if (saved) {
    sources = saved.sources;
    copiedFrom = { campaign: from, version: saved.version };
  } else {
    const a = assigned as NonNullable<typeof assigned>;
    sources = {
      assignment: Object.fromEntries(
        Object.entries(a.payload).filter(
          // A research copy's own servers: control fills them in from its contract.
          ([k]) => !RUN_FIELDS.has(k) && !(uses !== undefined && k === "mcp_servers"),
        ),
      ),
    };
    copiedFrom = { campaign: from, rig: a.rig, run: a.run };
  }
  if (otherMcp) copiedFrom.other_mcp_servers = true;
  store.campaigns.put({
    campaign: name,
    version,
    contract: parsed.contract,
    sha: parsed.sha,
    sources,
    copiedFrom,
    by,
  });
  store.auditLog.add(by, "campaign_copied", {
    campaign: name,
    from: copiedFrom,
    sha: parsed.sha,
    ...(otherMcp ? { mcp_servers: uses } : {}),
    ...(ctx !== undefined ? { agents_context: parsed.contract.agents_context ?? null } : {}),
    // The parts of the brief the copy has of its own (goal 078): their text is in its contract.
    ...(BRIEF_PARTS.some((k) => req[k] !== undefined)
      ? { own_brief: BRIEF_PARTS.filter((k) => req[k] !== undefined) }
      : {}),
  });
  return {
    state: "copied",
    campaign: name,
    version,
    sha: parsed.sha,
    from: copiedFrom,
    ...(parsed.contract.agents_context ? { context: parsed.contract.agents_context } : {}),
  };
}

/**
 * Copies a campaign (goal 069): the Copy panel on its page, REST, MCP's copy_campaign and
 * `thermite campaign copy`, with the campaigns control knows from its rigs' reports too.
 */
export const copyACampaign = (parts: ControlParts, req: CopyCampaignRequest, by: string) =>
  copyCampaign(parts.store, req, by, campaignModes(parts.store, parts.views()));

/** The answer REST and MCP give: the copy, its contract's hash and where it came from. */
export function copyCampaignAnswer(
  out: Extract<CopyCampaignOutcome, { state: "copied" }>,
): Record<string, unknown> {
  return {
    campaign: out.campaign,
    version: out.version,
    contract_sha: out.sha,
    from: out.from,
    // The copy's own context settings for its runs' agents, when it has any (goal 070).
    ...(out.context ? { agents_context: out.context } : {}),
  };
}

/**
 * What a copy's page says when its contract names other MCP servers than its source's: the
 * servers its agents use now, from the copy's first contract.
 */
export function copiedMcpWords(contract: unknown): string {
  const uses =
    McpUses.safeParse((contract as { mcp_servers?: unknown } | null)?.mcp_servers ?? []).data ?? [];
  return uses.length
    ? `Its agents use other MCP servers than its source's: ${usesWords(uses)}.`
    : "Its agents use no MCP server. Its source's agents use some.";
}

/** Where a copy came from, in words: "gemv-speed version 2", or the assignment it copied. */
export function copiedFromWords(f: CopiedFrom): string {
  return f.version !== undefined
    ? `${f.campaign} version ${f.version}`
    : `${f.campaign} as assigned for ${f.run ?? "a run"} on ${f.rig ?? "a rig"}`;
}
