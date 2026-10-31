import type { ControlStore } from "../store/index.ts";
import { campaignModes, type RigView } from "../views/index.ts";

/**
 * Grants (goals 065, 175 and 176): which other campaigns' collections a campaign's agents may
 * read, read only. The owner adds and removes them on a collection in the Knowledge page, over
 * REST (`POST` and `DELETE /v1/campaigns/<campaign>/kb-grants`), MCP (`kb_grant`, `kb_revoke`)
 * and with `thermite kb grant` and `kb revoke`, all through these two functions, with the same
 * words. A grant removed leaves every run's search at once (store/kb/scope.ts); a grant added
 * reaches the runs started from then that include it. Each change is in control's audit log.
 */

/** A grant's change, with the campaign's grants both ways after it; or why not, in words. */
export type GrantOutcome =
  | {
      ok: true;
      changed: boolean;
      campaign: string;
      reads: string[];
      read_by: string[];
      said: string;
    }
  | { ok: false; error: string; status: 400 | 404 };

const after = (store: ControlStore, campaign: string, changed: boolean, said: string) => ({
  ok: true as const,
  changed,
  campaign,
  reads: store.kb().reads(campaign),
  read_by: store.kb().readBy(campaign),
  said,
});

/** Why a grant can't be given, in words; undefined when it can (an operator proposes it then). */
export function grantProblem(
  store: ControlStore,
  vs: readonly RigView[],
  g: { campaign: string; reads: string },
): { error: string; status: 400 | 404 } | undefined {
  const known = campaignModes(store, [...vs]);
  const reads = g.reads.trim();
  if (!known.has(g.campaign))
    return { error: `Control has no campaign named ${g.campaign}.`, status: 404 };
  if (!reads) return { error: "Choose a collection to add.", status: 400 };
  if (reads === g.campaign)
    return {
      error: "A campaign always reads its own collection: choose another campaign's.",
      status: 400,
    };
  if (!known.has(reads)) return { error: `Control has no campaign named ${reads}.`, status: 404 };
  return undefined;
}

/** Lets `campaign`'s agents read `reads`'s collection, read only. */
export function grantCollection(
  store: ControlStore,
  vs: readonly RigView[],
  g: { campaign: string; reads: string },
  by: string,
): GrantOutcome {
  const problem = grantProblem(store, vs, g);
  if (problem) return { ok: false, ...problem };
  const reads = g.reads.trim();
  if (!store.kb().grant(g.campaign, reads, by))
    return after(store, g.campaign, false, `${g.campaign} reads ${reads} already.`);
  store.auditLog.add(by, "kb_grant", { campaign: g.campaign, reads });
  return after(
    store,
    g.campaign,
    true,
    `${g.campaign}'s agents may now read ${reads}'s collection. Runs started from now can include it in their search; runs at work keep their search as it started, and their research folders get it at the next sync.`,
  );
}

/** Ends a grant: `campaign`'s agents no longer read `reads`'s collection, at once. */
export function revokeCollection(
  store: ControlStore,
  g: { campaign: string; reads: string },
  by: string,
): GrantOutcome {
  if (!store.kb().revoke(g.campaign, g.reads))
    return { ok: false, error: `${g.campaign} does not read ${g.reads}.`, status: 404 };
  store.auditLog.add(by, "kb_revoke", { campaign: g.campaign, reads: g.reads });
  return after(
    store,
    g.campaign,
    true,
    `${g.campaign}'s agents no longer read ${g.reads}'s collection: it left every run's search at once, and leaves runs' research folders at the next sync. Nothing is deleted.`,
  );
}

/** What a grant opens and what removing one does, said before either is done. */
export const GRANT_WORDS = {
  add: "The campaign's agents may then read the collection you choose, read only, and never write to it. Runs started from then can include it in their search. Runs at work keep their search as it started; their research folders get it at the next sync.",
  remove: (campaign: string, reads: string) =>
    `${campaign}'s agents stop reading ${reads}'s collection: it leaves every run's search at once, and runs' research folders at the next sync. Nothing is deleted, and you can add it again.`,
};
