import { z } from "zod";
import {
  additionRolesOf,
  ROLE_ADDITION_MAX_CHARS,
  type RoleAdditions,
  requestedAdditions,
} from "../../core/role-additions.ts";
import type { ControlStore } from "../store/index.ts";
import { campaignContract } from "./context.ts";
import { saveWithField } from "./saved-version.ts";

/**
 * The owner's additions to a campaign's roles (goal 166, the owner's decision 1): text the owner
 * adds to a role's own instructions for one campaign, with no change to Thermite's code. They live
 * in the contract, as `role_additions`, so each one is signed into every assignment, versioned
 * with the contract, and copied with it; a change is a new version, and a run keeps the additions
 * it started with. Each prompt of the role carries its addition as a section of its own, labelled
 * as the owner's, after the role's text, which it never replaces.
 *
 * REST's POST /v1/campaigns/<name>/additions, MCP's set_campaign_additions, `thermite campaign
 * additions` and the campaign's page save a new version with them; New campaign sets them on the
 * first version.
 */

/** The request's fields over REST and MCP (MCP adds the campaign). */
export const campaignAdditionsFields = {
  additions: z
    .record(z.string(), z.string())
    .optional()
    .describe(
      `Each role's addition, by the role's id: worker, planner, teacher, merged-by, auditor or reviewer for a hill-climb or goal campaign; research-worker, research-planner, research-teacher, research-merged-by, research-reviewer, synthesizer or final-writer for a research campaign. Each at most ${ROLE_ADDITION_MAX_CHARS} characters. An empty text leaves its role out. Left out or {}: the campaign has none`,
    ),
};

/** The REST body: the additions, and nothing else; an empty body removes them. */
export const CampaignAdditionsBody = z.strictObject(campaignAdditionsFields);
export type CampaignAdditionsBody = z.infer<typeof CampaignAdditionsBody>;

export type CampaignAdditionsOutcome =
  | {
      state: "saved" | "unchanged" | "valid";
      campaign: string;
      version: number;
      sha: string;
      additions: RoleAdditions | undefined;
    }
  | { state: "refused"; error: string; status: 400 | 404 | 409 };

/** A contract's additions, when it has any. */
export function contractAdditions(contract: unknown): RoleAdditions | undefined {
  const raw = (contract as { role_additions?: unknown } | null | undefined)?.role_additions;
  return raw && typeof raw === "object" && Object.keys(raw).length
    ? (raw as RoleAdditions)
    : undefined;
}

const same = (a: RoleAdditions | undefined, b: RoleAdditions | undefined) =>
  JSON.stringify(Object.entries(a ?? {}).sort()) === JSON.stringify(Object.entries(b ?? {}).sort());

/**
 * Sets the owner's additions to a campaign's roles, or (none given) removes them: a new version of
 * its contract. Each call sets them anew: a role it leaves out has none in the new version. A role
 * the campaign's mode never runs, an unknown role and a text that is too long are refused in
 * words, by the contract's own check. With `check`, nothing is saved (proposals.ts).
 */
export function setCampaignAdditions(
  store: ControlStore,
  req: { campaign: string; additions?: Record<string, string> | undefined },
  by: string,
  check = false,
): CampaignAdditionsOutcome {
  const want = requestedAdditions(req.additions);
  const mode = String((campaignContract(store, req.campaign) as { mode?: unknown })?.mode ?? "");
  const roles = additionRolesOf(mode);
  const unknown = Object.keys(want ?? {}).filter((r) => !(roles as readonly string[]).includes(r));
  if (mode && unknown.length)
    return {
      state: "refused",
      error: `${req.campaign} is a ${mode.replace("_", " ")} campaign: it runs no ${unknown.join(", ")}. Its roles are ${roles.join(", ")}.`,
      status: 400,
    };
  const out = saveWithField(store, {
    campaign: req.campaign,
    field: "role_additions",
    value: want,
    same: (contract) => same(contractAdditions(contract), want),
    what: "their roles' own texts",
    by,
    action: "campaign_additions_set",
    audit: { roles: Object.keys(want ?? {}) },
    check,
  });
  return out.state === "refused" ? out : { ...out, additions: want };
}

/** The answer REST and MCP give: the campaign's version with the additions, and what it says. */
export function campaignAdditionsAnswer(
  out: Exclude<CampaignAdditionsOutcome, { state: "refused" }>,
): Record<string, unknown> {
  const roles = Object.keys(out.additions ?? {});
  const words = roles.length ? `additions for ${roles.join(", ")}` : "no additions";
  return {
    campaign: out.campaign,
    version: out.version,
    contract_sha: out.sha,
    role_additions: out.additions ?? null,
    said:
      out.state === "unchanged"
        ? `Version ${out.version} of ${out.campaign} has these additions already: ${words}.`
        : `Version ${out.version} of ${out.campaign} is saved, with ${words}. Runs started from now take it.`,
  };
}
