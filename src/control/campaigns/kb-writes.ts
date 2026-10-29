import { z } from "zod";
import {
  KB_WRITER_ROLES,
  KB_WRITES_DEFAULT,
  KB_WRITTEN_KINDS,
  type KbWrites,
  KbWrites as KbWritesSchema,
  kbWritesOf,
} from "../../core/kb.ts";
import type { ControlStore } from "../store/index.ts";
import { campaignContract } from "./context.ts";
import { saveWithField } from "./saved-version.ts";

/**
 * Which kinds of item each role may write in its own slot of the campaign's collection in
 * Thermite's knowledge base (goal 175). It lives in the contract, as `kb_writes`, so it is signed
 * into every assignment, versioned and copied with the contract: a change is a new version, and a
 * run keeps what it started with. Left out, core/kb.ts's KB_WRITES_DEFAULT holds. A role that may
 * write gets the `kb_write` tool; every role gets `kb_search` and `kb_read`. The rig's harness
 * refuses another kind, and control refuses it again as it stores the item.
 *
 * REST's POST /v1/campaigns/<name>/kb-writes, MCP's set_campaign_kb_writes and the campaign's page
 * save a new version with it.
 */

/** The request's fields over REST and MCP (MCP adds the campaign). */
export const campaignKbWritesFields = {
  kb_writes: KbWritesSchema.optional().describe(
    `Each role's kinds, by role: ${KB_WRITER_ROLES.join(", ")}; each a list of ${KB_WRITTEN_KINDS.join(", ")}. A role left out, or given [], writes nothing. Left out: the default, ${defaultWords()}`,
  ),
};

/** The REST body: the setting, and nothing else; an empty body puts back the default. */
export const CampaignKbWritesBody = z.strictObject(campaignKbWritesFields);
export type CampaignKbWritesBody = z.infer<typeof CampaignKbWritesBody>;

/** The default in words, for the docs' and the tools' descriptions. */
export function defaultWords(): string {
  return KB_WRITER_ROLES.map(
    (r) => `${r}: ${(KB_WRITES_DEFAULT[r] ?? []).join(", ") || "nothing"}`,
  ).join("; ");
}

/** A setting with its roles and kinds in one order, so that equal settings compare equal. */
function canonical(w: KbWrites | undefined): string {
  if (!w) return "";
  return JSON.stringify(
    KB_WRITER_ROLES.map((r) => [r, [...(w[r] ?? [])].sort()] as const).filter(([, k]) => k.length),
  );
}

export type CampaignKbWritesOutcome =
  | {
      state: "saved" | "unchanged" | "valid";
      campaign: string;
      version: number;
      sha: string;
      kb_writes: KbWrites;
    }
  | { state: "refused"; error: string; status: 400 | 404 | 409 };

/** What a campaign lets each role write now: its newest contract's, or the default. */
export function campaignKbWrites(store: ControlStore, campaign: string): KbWrites {
  return kbWritesOf(campaignContract(store, campaign));
}

/**
 * Sets which kinds each role may write, or (none given) puts back the default: a new version of
 * the campaign's contract, unless its newest says the same already. With `check`, nothing is
 * saved (proposals.ts).
 */
export function setCampaignKbWrites(
  store: ControlStore,
  req: { campaign: string; kb_writes?: KbWrites | undefined },
  by: string,
  check = false,
): CampaignKbWritesOutcome {
  const want = req.kb_writes;
  const out = saveWithField(store, {
    campaign: req.campaign,
    field: "kb_writes",
    value: want,
    same: (contract) =>
      (contract as { kb_writes?: unknown } | null)?.kb_writes === undefined
        ? want === undefined
        : canonical(kbWritesOf(contract)) === canonical(want),
    what: "which roles write in its collection",
    by,
    action: "campaign_kb_writes_set",
    audit: { kb_writes: want ?? "default" },
    check,
  });
  return out.state === "refused" ? out : { ...out, kb_writes: want ?? KB_WRITES_DEFAULT };
}

/** The answer REST and MCP give: the campaign's version with the setting, and what it says. */
export function campaignKbWritesAnswer(
  out: Exclude<CampaignKbWritesOutcome, { state: "refused" }>,
): Record<string, unknown> {
  return {
    campaign: out.campaign,
    version: out.version,
    contract_sha: out.sha,
    kb_writes: out.kb_writes,
    said:
      out.state === "unchanged"
        ? `Version ${out.version} of ${out.campaign} says this already.`
        : `Version ${out.version} of ${out.campaign} is saved with which roles write in its collection. Runs started from now take it.`,
  };
}
