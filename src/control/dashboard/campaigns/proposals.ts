import type { Hono } from "hono";
import { decideProposal } from "../../campaigns/index.ts";
import { esc } from "../../ui/components/index.ts";
import { proposalCard } from "../../ui/operator/index.ts";
import { campaignHref } from "../../ui/urls.ts";
import type { Ctx, Dashboard } from "../context.ts";

/**
 * The operator's proposals to a campaign's settings on its page (campaigns/proposals.ts): each
 * waiting one as a card with Approve and Decline, which only the owner's session sends.
 */
export function proposalRoutes(app: Hono, dash: Dashboard): void {
  const { store } = dash;
  // The campaign's page says what the decision did, wherever the owner decided.
  const decide = (approve: boolean) => async (c: Ctx) => {
    const campaign = c.req.param("campaign") ?? "";
    const id = Number(c.req.param("id"));
    const p = Number.isSafeInteger(id) ? store.proposals.get(id) : undefined;
    if (!p || p.campaign !== campaign) return c.text("No such proposal.", 404);
    const out = decideProposal(store, id, approve, "owner:ui");
    const k = out.state === "refused" ? "error" : "ok";
    const said = out.state === "refused" ? out.error : out.said;
    return c.redirect(
      `${campaignHref(campaign)}?on=proposals&${k}=${encodeURIComponent(said)}#proposals`,
      303,
    );
  };
  app.post("/ui/campaigns/:campaign/proposals/:id/approve", decide(true));
  app.post("/ui/campaigns/:campaign/proposals/:id/decline", decide(false));
}

/** The campaign's proposals that wait for the owner, as cards; none: nothing. */
export function proposalsBlock(dash: Dashboard, c: Ctx, campaign: string): string {
  const waiting = dash.store.proposals.waiting(campaign);
  const said = c.req.query("on") === "proposals";
  const error = said ? dash.said(c) : undefined;
  const ok = said ? c.req.query("ok") : undefined;
  const note = error
    ? `<div class="card warn" style="margin-bottom:10px"><b class="bad">Not done.</b> ${esc(error)}</div>`
    : ok
      ? `<div class="card" style="margin-bottom:10px"><b class="ok">${esc(ok)}</b></div>`
      : "";
  if (!waiting.length && !note) return "";
  const now = Date.now();
  const cards = waiting.map((p) => proposalCard(dash.store, p, dash.csrf(c), now).html).join("");
  return `<div class="block" id="proposals"><div class="head"><h2>Proposed to you</h2><span class="n">${waiting.length}</span></div>${note}${cards}</div>`;
}
