import { PROPOSED_WORDS, proposalChange } from "../../campaigns/index.ts";
import { GRANT_OPENS } from "../../kb/index.ts";
import type { CampaignProposal, ControlStore } from "../../store/index.ts";
import { card, esc, icon } from "../components/index.ts";
import { campaignHref } from "../urls.ts";
import type { Need, NeedsContext } from "./index.ts";

/**
 * The operator's proposals to a campaign's settings, which wait for the owner (the owner's
 * decisions, 2026-10-29 and 2026-10-30): the change in full, the setting now beside it, and what
 * Approve and Decline each do. The same card is under Needs you and on the campaign's page.
 */

/** Where a proposal's forms go: the campaign's page decides it. */
export const proposalAction = (p: CampaignProposal, choice: "approve" | "decline") =>
  `${campaignHref(p.campaign)}/proposals/${p.id}/${choice}`;

/** One proposal's card, with its two forms. */
export function proposalCard(
  store: ControlStore,
  p: CampaignProposal,
  csrf: string,
  now: number,
): { html: string; box: string } {
  const what = PROPOSED_WORDS[p.field];
  const change = proposalChange(store, p);
  const form = (choice: "approve" | "decline", label: string, cls: string) =>
    `<form class="inline" method="post" action="${esc(proposalAction(p, choice))}"><input type="hidden" name="csrf" value="${esc(csrf)}"><button class="${cls}">${label}</button></form>`;
  if (p.field === "kb_grant") return grantCard(p, change, form, now);
  const prompts =
    p.field === "role_additions"
      ? "Each prompt of a role carries its addition as the owner's own words"
      : "Which roles write in the campaign's collection is the owner's choice";
  const c = card({
    tone: "violet",
    ic: icon.list,
    kind: "Proposal",
    question: `Approve the ${what} of ${p.campaign} that ${p.proposed_by} proposes?`,
    headline: `${esc(p.proposed_by)} proposes ${esc(what)} for ${esc(p.campaign)}`,
    why: `${prompts}, so an operator's change waits for you`,
    key: `proposal-${p.id}`,
    where: `campaign <a href="${esc(campaignHref(p.campaign))}#proposals">${esc(p.campaign)}</a>`,
    since: p.proposed_at,
    now,
    facts: `<dt>Now</dt><dd><pre class="json" style="white-space:pre-wrap">${esc(change.now)}</pre></dd>
<dt>Proposed</dt><dd><pre class="json" style="white-space:pre-wrap">${esc(change.proposed)}</pre></dd>
<dt>By</dt><dd>${esc(p.proposed_by)}, with the operator's token. Each call sets the whole setting: a role it leaves out has none.</dd>`,
    choices: [
      {
        button: form("approve", "Approve", "primary"),
        label: "Approve",
        does: `Control saves a new version of ${esc(p.campaign)}'s contract with these ${esc(what)}, as your own change. Runs started from now take it; runs at work keep what they started with.`,
      },
      {
        button: form("decline", "Decline", ""),
        label: "Decline",
        does: "Nothing changes. The audit log keeps the proposal and your decision.",
      },
    ],
  });
  return { html: c.html, box: c.box };
}

/** A proposed grant's card: which collection, what it opens, and the campaign's reads now. */
function grantCard(
  p: CampaignProposal,
  change: { now: string; proposed: string },
  form: (choice: "approve" | "decline", label: string, cls: string) => string,
  now: number,
): { html: string; box: string } {
  const reads = String(p.value);
  const c = card({
    tone: "violet",
    ic: icon.list,
    kind: "Proposal",
    question: `Let every agent of ${p.campaign} read ${reads}'s collection, as ${p.proposed_by} proposes?`,
    headline: `${esc(p.proposed_by)} proposes that ${esc(p.campaign)} read ${esc(reads)}'s collection`,
    why: "A grant opens the collection to every agent of the campaign, so an operator's grant waits for you",
    key: `proposal-${p.id}`,
    where: `campaign <a href="${esc(campaignHref(p.campaign))}#proposals">${esc(p.campaign)}</a>`,
    since: p.proposed_at,
    now,
    facts: `<dt>What</dt><dd>${esc(GRANT_OPENS)}</dd>
<dt>Reads now</dt><dd>${esc(change.now)}</dd>
<dt>Proposed</dt><dd>${esc(change.proposed)}</dd>
<dt>By</dt><dd>${esc(p.proposed_by)}, with the operator's token.</dd>`,
    choices: [
      {
        button: form("approve", "Approve", "primary"),
        label: "Approve",
        does: `Control grants it, as your own grant: every agent of ${esc(p.campaign)} may search and read ${esc(reads)}'s collection. Runs started from now may search it; runs at work get it at their next sync. You can remove it under Reads on the campaign's collection in Knowledge.`,
      },
      {
        button: form("decline", "Decline", ""),
        label: "Decline",
        does: "Nothing changes. The audit log keeps the proposal and your decision.",
      },
    ],
  });
  return { html: c.html, box: c.box };
}

/** Every proposal that waits for the owner, as Needs you lists them. */
export function proposalNeeds(c: NeedsContext, store: ControlStore): Need[] {
  return store.proposals.waiting().map((p) => ({
    kind: "proposal",
    rig: "",
    at: p.proposed_at,
    ...proposalCard(store, p, c.f.csrf, c.now),
  }));
}
