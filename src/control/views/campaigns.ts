import type { ControlStore } from "../store/index.ts";
import { runCampaign } from "./facts.ts";
import type { Earlier, RigView, RunView } from "./types.ts";

/**
 * A campaign and its runs on every rig: the dashboard's first level. A run is `earlier` (goal 170)
 * on a campaign's page, which reads its runs from control's run registry; the lists made from the
 * rigs' views have only their current runs.
 */
export interface CampaignView {
  name: string;
  mode: string | null;
  runs: { rig: RigView; run: RunView; earlier?: Earlier | null }[];
}

/**
 * A campaign's newest run, by when it started (goal 099): with no run at work, the campaign
 * stands where its newest run stands, so an older paused run does not hide a newer one's end.
 */
export function newestRun(k: CampaignView): CampaignView["runs"][number] | undefined {
  let best: CampaignView["runs"][number] | undefined;
  for (const x of k.runs)
    if (!best || (x.run.created_at ?? "") > (best.run.created_at ?? "")) best = x;
  return best;
}

/**
 * Groups runs by campaign: Campaign ▸ Run (on a rig) ▸ Lane ▸ Trial ▸ Attempt. Campaigns with a
 * live run come first, then those whose newest run is paused.
 */
export function campaignViews(vs: RigView[]): CampaignView[] {
  const by = new Map<string, CampaignView>();
  for (const rig of vs) {
    for (const run of rig.runs) {
      const name = runCampaign(run);
      const c = by.get(name) ?? { name, mode: run.mode, runs: [] };
      c.runs.push({ rig, run });
      by.set(name, c);
    }
  }
  const rank = (c: CampaignView) =>
    c.runs.some((x) => x.run.status === "running")
      ? 0
      : newestRun(c)?.run.status === "paused"
        ? 1
        : 2;
  return [...by.values()].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

/**
 * Every campaign control knows, with its mode: from the runs rigs report, the versions saved on
 * control, the assignments it signed, and the knowledge base's collections (goal 065).
 */
export function campaignModes(store: ControlStore, vs: RigView[]): Map<string, string | null> {
  const out = new Map<string, string | null>();
  const modeOf = (contract: unknown) => {
    const m = (contract as { mode?: unknown } | undefined)?.mode;
    return typeof m === "string" ? m : null;
  };
  for (const k of campaignViews(vs)) out.set(k.name, k.mode);
  for (const v of store.campaigns.versions())
    if (!out.get(v.campaign)) out.set(v.campaign, modeOf(v.contract));
  for (const [name, a] of store.commands.latestAssignments())
    if (!out.get(name)) out.set(name, modeOf(a.payload.contract));
  for (const f of store.kb().collections()) if (!out.has(f.campaign)) out.set(f.campaign, null);
  return out;
}
