import type { KbWrites } from "../../core/kb.ts";
import type { CampaignProposal, ControlStore, ProposedField } from "../store/index.ts";
import { contractAdditions, sameAdditions, setCampaignAdditions } from "./additions.ts";
import { campaignContract } from "./context.ts";
import { campaignKbWrites, sameKbWrites, setCampaignKbWrites } from "./kb-writes.ts";

/**
 * The operator's proposals to a campaign's own settings (the owner's decision, 2026-10-29): the
 * additions to its roles, which the prompts carry as the owner's, and which roles write in its
 * collection. An operator's change is checked as the owner's would be, then waits for the owner,
 * who approves or declines it on the campaign's page and under Needs you; only an approval saves
 * a new version of the contract. The owner's own changes take effect at once. An assignment from
 * the operator's or an agent's token carries both as a saved version has them (savedSettingsRefusal).
 */

/** Each setting in words, for the cards and the answers. */
export const PROPOSED_WORDS: Record<ProposedField, string> = {
  role_additions: "additions to its roles",
  kb_writes: "which roles write in its collection",
};

export type ProposeOutcome =
  | { state: "proposed"; id: number; campaign: string; field: ProposedField; said: string }
  | { state: "unchanged"; campaign: string; field: ProposedField; said: string }
  | { state: "refused"; error: string; status: 400 | 404 | 409 };

/** The setting as the store keeps it, and as its function takes it. */
type Value = Record<string, string> | KbWrites | undefined;

/** Checks or saves a setting through its own function, which refuses what it would refuse. */
function setField(
  store: ControlStore,
  campaign: string,
  field: ProposedField,
  value: Value,
  by: string,
  check: boolean,
) {
  return field === "role_additions"
    ? setCampaignAdditions(
        store,
        { campaign, additions: value as Record<string, string> | undefined },
        by,
        check,
      )
    : setCampaignKbWrites(store, { campaign, kb_writes: value as KbWrites | undefined }, by, check);
}

/**
 * An operator's change to a campaign's setting, kept as a proposal for the owner: refused in the
 * same words as the owner's change would be, and nothing kept when the newest version says it
 * already. A newer proposal of the same setting replaces one still waiting.
 */
export function proposeSetting(
  store: ControlStore,
  req: { campaign: string; field: ProposedField; value: Value },
  by: string,
): ProposeOutcome {
  const { campaign, field } = req;
  const checked = setField(store, campaign, field, req.value, by, true);
  if (checked.state === "refused") return checked;
  const what = PROPOSED_WORDS[field];
  if (checked.state === "unchanged")
    return {
      state: "unchanged",
      campaign,
      field,
      said: `Version ${checked.version} of ${campaign} has these ${what} already: nothing to propose.`,
    };
  const id = store.proposals.propose({ campaign, field, value: req.value, by });
  store.auditLog.add(by, "campaign_setting_proposed", { campaign, field, proposal: id });
  return {
    state: "proposed",
    id,
    campaign,
    field,
    said: `Proposed to the owner: ${what} of ${campaign}. Nothing changes until the owner approves it on the campaign's page; the campaign's runs keep what they have.`,
  };
}

export type DecideOutcome =
  | { state: "approved"; said: string }
  | { state: "declined"; said: string }
  | { state: "refused"; error: string; status: 400 | 404 | 409 };

/**
 * The owner's decision on a proposal. Approved: saved as the owner's own change would be, a new
 * version of the contract, which the audit log ties to the proposal; refused in words when it can
 * no longer be saved, and it waits on. Declined: nothing changes.
 */
export function decideProposal(
  store: ControlStore,
  id: number,
  approve: boolean,
  by: string,
): DecideOutcome {
  const p = store.proposals.get(id);
  if (!p || p.decision !== null)
    return { state: "refused", error: "That proposal no longer waits for you.", status: 404 };
  const what = `${PROPOSED_WORDS[p.field]} of ${p.campaign}`;
  if (!approve) {
    store.proposals.decide(id, "declined", by);
    store.auditLog.add(by, "campaign_setting_declined", {
      campaign: p.campaign,
      field: p.field,
      proposal: id,
      proposed_by: p.proposed_by,
    });
    return {
      state: "declined",
      said: `Declined: the ${what}, as ${p.proposed_by} proposed them. Nothing changed.`,
    };
  }
  const saved = setField(store, p.campaign, p.field, (p.value ?? undefined) as Value, by, false);
  if (saved.state === "refused") return saved;
  store.proposals.decide(id, "approved", by);
  store.auditLog.add(by, "campaign_setting_approved", {
    campaign: p.campaign,
    field: p.field,
    proposal: id,
    proposed_by: p.proposed_by,
    version: saved.version,
  });
  return {
    state: "approved",
    said: `Approved: version ${saved.version} of ${p.campaign} has the ${PROPOSED_WORDS[p.field]} ${p.proposed_by} proposed. Runs started from now take it.`,
  };
}

/** What a proposal would change, in plain words: the setting now, and as proposed. */
export function proposalChange(
  store: ControlStore,
  p: CampaignProposal,
): { now: string; proposed: string } {
  if (p.field === "role_additions") {
    const words = (a: Record<string, string> | undefined) =>
      Object.entries(a ?? {})
        .filter(([, t]) => t.trim())
        .map(([role, t]) => `${role}: ${t.trim()}`)
        .join("\n\n") || "none";
    return {
      now: words(contractAdditions(campaignContract(store, p.campaign))),
      proposed: words((p.value ?? undefined) as Record<string, string> | undefined),
    };
  }
  const words = (w: KbWrites) =>
    Object.entries(w)
      .filter(([, kinds]) => (kinds ?? []).length)
      .map(([role, kinds]) => `${role}: ${(kinds ?? []).join(", ")}`)
      .join("; ") || "no role writes";
  return {
    now: words(campaignKbWrites(store, p.campaign)),
    proposed: p.value === null ? "the default" : words(p.value as KbWrites),
  };
}

/**
 * Why control refuses an assignment from the operator's or an agent's token, in words, or "": its
 * contract's additions to the roles, or which roles write in the collection, differ from those of
 * the campaign's saved version (the one the contract names, else the newest), which the owner
 * saved or approved; for a campaign control knows only by an assignment, from those of its last
 * one. With neither, the contract may set neither. The owner's token is not held to it.
 */
export function savedSettingsRefusal(store: ControlStore, payload: unknown): string {
  const contract = (payload as { contract?: { campaign?: unknown; version?: unknown } } | null)
    ?.contract;
  const campaign = typeof contract?.campaign === "string" ? contract.campaign : "";
  const versions = campaign ? store.campaigns.versions(campaign) : [];
  const saved = versions.find((v) => v.version === contract?.version) ?? versions[0];
  const known = saved?.contract ?? (campaign ? campaignContract(store, campaign) : undefined);
  const differ = (Object.keys(PROPOSED_WORDS) as ProposedField[]).filter((field) =>
    field === "role_additions"
      ? !sameAdditions(contractAdditions(contract), contractAdditions(known))
      : !sameKbWrites(contract, known),
  );
  if (!differ.length) return "";
  const what = differ
    .map((f) => (f === "role_additions" ? `the ${PROPOSED_WORDS[f]}` : PROPOSED_WORDS[f]))
    .join(" and ");
  const against = saved
    ? `in ${what}, this assignment differs from version ${saved.version} of ${campaign}, as the owner saved it`
    : known
      ? `in ${what}, this assignment differs from the last assignment of ${campaign}`
      : `control has no saved version of ${campaign || "this campaign"}, so this assignment may not change ${what}`;
  return `Not sent: ${against}. With the operator's or an agent's token, an assignment carries the campaign's saved settings: propose a change with set_campaign_additions or set_campaign_kb_writes for the owner to approve, or assign it with the owner's token.`;
}
