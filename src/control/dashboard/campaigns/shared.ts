import { parseContract } from "../../../core/contract.ts";
import { type GoalChecks, goalChecks } from "../../../core/goal/index.ts";
import { KitSchema } from "../../../core/kit.ts";
import { type KbKind, PICKABLE } from "../../kb/index.ts";
import type { ChecksSource } from "../../ui/campaigns/goal-checks.ts";
import { isRigCheck, workCard } from "../../ui/campaigns/list.ts";
import { bestGainWords, icon, modeName, num, pct } from "../../ui/components/index.ts";
import { runBrief } from "../../ui/operator/index.ts";
import { runLiveHref } from "../../ui/urls.ts";
import {
  type CampaignView,
  currentChampion,
  type RigView,
  type RunView,
} from "../../views/index.ts";
import type { Ctx, Dashboard } from "../context.ts";

/** A campaign's headline figure: its best run's gain, goals met or verified claims. */
export const headline = (k: CampaignView): { value: string; sub: string; best?: RunView } => {
  const runs = k.runs.map((x) => x.run);
  if (k.mode === "hill_climb") {
    const gain = (i: RunView) => (currentChampion(i)?.cumulative ?? 1) - 1;
    const best = [...runs].sort((a, b) => gain(b) - gain(a))[0];
    return { value: best ? pct(gain(best), 1) : "·", sub: bestGainWords(best), best };
  }
  if (k.mode === "goal") {
    const met = (i: RunView) => i.goals.filter((g) => g.status === "met").length;
    const best = [...runs].sort((a, b) => met(b) - met(a))[0];
    return {
      value: best ? `${met(best)}/${best.goals.length || "?"}` : "·",
      sub: "goals met (best run)",
      best,
    };
  }
  const claims = (i: RunView) => num((i.research as Record<string, unknown> | null)?.verified);
  return { value: String(Math.max(0, ...runs.map(claims))), sub: "verified claims" };
};
/** Who copied a campaign, as its page says it: the dashboard is the owner's, so "you". */
export const copiedBy = (by: string) =>
  by === "owner:operator" ? "the operator" : by === "owner" || by.startsWith("owner:") ? "you" : by;

/** A campaign's mode in words, for collections: hill climb, goal, research or rig check. */
export const modeWords =
  (modes: Map<string, string | null>) =>
  (name: string): string =>
    isRigCheck(name) ? "rig check" : modeName(modes.get(name) ?? null) || "campaign";

/**
 * What the campaigns' pages share: a run at work as a card, how each goal is checked, what a
 * campaign is for, and past research a new run can start from. The Campaigns list, a campaign's
 * page, its runs and the Knowledge page use them.
 */
export function campaignHelpers(dash: Dashboard) {
  const { opts, pauseMenu, store } = dash;
  /** Past research a new run of a campaign can start from: its readable collections' newest matches. */
  const pastResults = (campaign: string, q: string) => {
    const kb = store.kb();
    return kb.search(q, kb.readable(campaign), {
      kinds: (Object.keys(PICKABLE) as KbKind[]).filter((k) => PICKABLE[k]),
      limit: 40,
    });
  };

  /** A run at work as a card: its brief, then Live, Message and Pause. */
  const workCardFor = (
    c: Ctx,
    u: RigView,
    r: RunView,
    now: number,
    waiting: number,
    back: string,
  ) =>
    workCard(
      runBrief(store, u, r, now, { heading: true }),
      // A run without agents (a try, a rig check) has no one to message.
      `<a class="btn sm" href="${runLiveHref(r)}">${icon.terminal}Live</a>${r.has_agents === false ? "" : `<a class="btn sm" href="${runLiveHref(r, { compose: true })}">Message</a>`}${pauseMenu(c, u.id, r.id, back, "sm ghost")}`,
      waiting,
    );

  /**
   * How each goal of a goal campaign is really checked (goal 082), and where that comes from: a
   * run's own rig report first; then the kit control keeps, at the contract's commit; then, for
   * a campaign's page, the newest run whose rig reported it; else what the contract says. Undefined
   * when control has no goal contract for the campaign and no rig reported its checks.
   */
  const goalChecksFor = (
    name: string,
    vs: RigView[],
    rig?: string,
    run?: RunView,
  ): { checks: GoalChecks; source: ChecksSource } | undefined => {
    if (rig && run?.goal_checks) return { checks: run.goal_checks, source: { from: "rig", rig } };
    const v = store.campaigns.versions(name)[0];
    const raw = v?.contract ?? store.commands.latestAssignments().get(name)?.payload.contract;
    const parsed = raw ? parseContract(raw) : undefined;
    const contract = parsed?.ok && parsed.contract.mode === "goal" ? parsed.contract : undefined;
    const ref = contract?.project.kit;
    const kept = v?.sources.kit !== undefined && "control" in v.sources.kit;
    if (contract && ref && kept && opts.kits) {
      const kit = KitSchema.safeParse(opts.kits.manifest(ref.repo, ref.commit));
      if (kit.success)
        return {
          checks: goalChecks(contract, { kit: kit.data, repo: ref.repo, commit: ref.commit }),
          source: { from: "control" },
        };
    }
    if (!run) {
      const reported = vs
        .flatMap((u) => u.runs.map((r) => ({ u, r })))
        .filter((x) => (x.r.campaign || x.r.id) === name && x.r.goal_checks)
        .sort((a, b) => (b.r.created_at ?? "").localeCompare(a.r.created_at ?? ""))[0];
      if (reported?.r.goal_checks)
        return { checks: reported.r.goal_checks, source: { from: "rig", rig: reported.u.id } };
    }
    if (!contract) return undefined;
    return {
      checks: goalChecks(contract),
      source: {
        from: "contract",
        why: kept
          ? "Control can't read its copy of this campaign's kit at the contract's commit, so the cases' parameters and time limits are not shown."
          : "Control keeps no copy of this campaign's kit, which is in its repository, and no rig has reported its checks yet, so the cases' parameters and time limits are not shown.",
      },
    };
  };

  /** What a campaign is for, from its contract on control: its title, topic or objective. */
  const aboutOf = (name: string): string => {
    const contract = (store.campaigns.versions(name)[0]?.contract ??
      store.commands.latestAssignments().get(name)?.payload.contract) as
      | { title?: string; topic?: string; objective?: { description?: string } }
      | undefined;
    return contract?.title ?? contract?.topic ?? contract?.objective?.description ?? "";
  };
  return { aboutOf, goalChecksFor, pastResults, workCardFor };
}
