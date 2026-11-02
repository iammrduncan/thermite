import { isRigCheck } from "../../core/ids.ts";
import type { RigView, RunView } from "../views/index.ts";
import { runCampaign } from "../views/index.ts";
import { esc, filterForm, pagerHtml } from "./components/index.ts";
import { championPatchHref, paperHref, runHref } from "./urls.ts";

/**
 * Reports (goal 181, from the owner's mockup): what each finished run produced, newest first. A
 * research run's final report and paper, a hill climb's champion against its starting point, a
 * goal run's outcome. Drop-down filters by mode and by campaign; the rig checks' runs only when
 * asked for. The rigs' daily summaries it showed before are gone from the dashboard, and a full
 * reset is on its rig's page and in Needs you.
 */

/** How many reports a page shows. */
const REPORTS_PAGE = 25;

const MODE_WORDS: Record<string, string> = {
  research: "Research",
  hill_climb: "Hill climb",
  goal: "Goal",
};

interface ReportsQuery {
  mode: string[];
  campaign: string[];
  checks: boolean;
  at: number;
}

function reportsHref(q: ReportsQuery): string {
  const p = new URLSearchParams();
  for (const v of q.mode) p.append("mode", v);
  for (const v of q.campaign) p.append("campaign", v);
  if (q.checks) p.set("checks", "1");
  if (q.at > 0) p.set("at", String(q.at));
  const s = p.toString();
  return `/ui/reports${s ? `?${s}` : ""}`;
}

/** A finished run's report: its headline, a line under it, and where to read it. */
function reportOf(i: RunView): { head: string; sub: string; links: [string, string][] } {
  const open: [string, string] = [runHref(i), "Open the run"];
  if (i.mode === "research") {
    const paper = i.paper?.state === "in" ? (i.paper.text ?? "") : "";
    const title = /^#\s+(.+)$/m.exec(paper)?.[1]?.trim();
    const final = (i.research as { kind?: unknown } | null)?.kind === "final";
    const answered = i.cards.length;
    return {
      head: title ?? (final ? "Its final report" : "It ended before its final report"),
      sub: [
        final ? "final report" : "",
        paper ? "paper" : i.paper ? "no paper: the final writer's draft was refused" : "",
        answered ? `${answered} question${answered === 1 ? "" : "s"} with an answer card` : "",
      ]
        .filter(Boolean)
        .join(" · "),
      links: [open, ...(paper ? ([[paperHref(i), "paper.md"]] as [string, string][]) : [])],
    };
  }
  if (i.mode === "hill_climb") {
    const champ = i.champion.at(-1);
    const v = i.verdicts;
    const n = (k: string) => Number(v[k] ?? 0);
    const counts = [
      [n("win_confirmed"), "wins confirmed"],
      [n("regress"), "regressions"],
      [n("neutral"), "neutral"],
      [n("invalid"), "invalid"],
    ]
      .filter(([c]) => Number(c) > 0)
      .map(([c, w]) => `${c} ${w}`)
      .join(" · ");
    const won = champ && champ.seq > 1;
    const published = won && i.published_patches.some((p) => p.seq === champ.seq);
    return {
      head: won
        ? `Champion #${champ.seq}: ${champ.cumulative.toFixed(2)}× its starting point`
        : "No win over its starting point",
      sub: `${i.attempts.length} attempt${i.attempts.length === 1 ? "" : "s"}${counts ? ` · ${counts}` : ""}`,
      links: [
        open,
        ...(published && champ
          ? ([[championPatchHref(i, champ.seq), `Champion #${champ.seq} as a patch`]] as [
              string,
              string,
            ][])
          : []),
      ],
    };
  }
  const met = i.goals.filter((g) => g.status === "met").length;
  const accepted = i.conclusions.some((c) => c.decision === "accepted");
  return {
    head: i.goals_complete
      ? "Its goals were met"
      : accepted
        ? "Not possible: you accepted the run's conclusion"
        : "It ended without meeting its goals",
    sub: i.goals.length ? `${met} of ${i.goals.length} goals met` : "",
    links: [open],
  };
}

export function reportsBody(o: { views: RigView[]; query: ReportsQuery }): string {
  const q = o.query;
  const runs = o.views
    .flatMap((u) => u.runs.filter((i) => i.status === "closed").map((i) => ({ u, i })))
    .filter(({ i }) => q.checks || !isRigCheck(runCampaign(i)))
    .sort((a, b) => String(b.i.status_at ?? "").localeCompare(String(a.i.status_at ?? "")));
  const shown = runs.filter(
    ({ i }) =>
      (!q.mode.length || q.mode.includes(i.mode ?? "")) &&
      (!q.campaign.length || q.campaign.includes(runCampaign(i))),
  );
  const campaigns = [...new Set(runs.map(({ i }) => runCampaign(i)))].sort();
  const count = (k: (i: RunView) => string, v: string) => runs.filter(({ i }) => k(i) === v).length;
  const filters = filterForm({
    action: "/ui/reports",
    filters: [
      {
        name: "mode",
        label: "Mode",
        tip: "A research run writes a final report and, once the review panel passed it, a paper; a hill climb ends with its champion; a goal run with its outcome.",
        choices: Object.entries(MODE_WORDS).map(([value, label]) => ({
          value,
          label,
          n: count((i) => i.mode ?? "", value),
        })),
        picked: q.mode,
      },
      {
        name: "campaign",
        label: "Campaign",
        tip: "The campaign the run was of.",
        choices: campaigns.map((c) => ({ value: c, label: c, n: count(runCampaign, c) })),
        picked: q.campaign,
      },
    ],
    keep: q.checks ? { checks: "1" } : undefined,
    href: (picked) =>
      reportsHref({
        mode: [...(picked.mode ?? [])],
        campaign: [...(picked.campaign ?? [])],
        checks: q.checks,
        at: 0,
      }),
  });
  const checks = `<a class="small" href="${esc(reportsHref({ ...q, checks: !q.checks, at: 0 }))}">${q.checks ? "Leave out the rig checks' runs" : "Show the rig checks' runs too"}</a>`;
  const at = Math.min(Math.max(0, q.at), Math.max(0, shown.length - 1));
  const page = shown.slice(at, at + REPORTS_PAGE);
  const cards = page
    .map(({ u, i }) => {
      const r = reportOf(i);
      const ended = i.status_at ? `${i.status_at.slice(0, 16).replace("T", " ")} UTC` : "";
      return `<div class="card rp-card" data-run="${esc(i.id)}"><div class="rp-top"><span class="muted small">${esc(runCampaign(i))} › ${esc(i.id)}</span><span class="chip">${esc(MODE_WORDS[i.mode ?? ""] ?? i.mode ?? "")}</span><span class="rp-when muted small">${ended ? `ended ${esc(ended)} · ` : ""}${esc(u.id)}</span></div><h3 class="rp-head">${esc(r.head)}</h3>${r.sub ? `<div class="small muted">${esc(r.sub)}</div>` : ""}<div class="rp-links">${r.links.map(([href, word], k) => `<a class="btn sm${k ? "" : " primary"}" href="${esc(href)}">${esc(word)}</a>`).join("")}</div></div>`;
    })
    .join("");
  const pager = pagerHtml({
    from: page.length ? at + 1 : 0,
    to: at + page.length,
    total: shown.length,
    newest: at > 0 ? reportsHref({ ...q, at: 0 }) : null,
    newer: at > 0 ? reportsHref({ ...q, at: Math.max(0, at - REPORTS_PAGE) }) : null,
    older: at + REPORTS_PAGE < shown.length ? reportsHref({ ...q, at: at + REPORTS_PAGE }) : null,
  });
  return `<p class="muted small" style="margin:0 0 10px">What each finished run produced, newest first: a research run's final report and paper, a hill climb's champion against its starting point, a goal run's outcome. A full reset is on its rig's page, and in Needs you when it waits for you.</p><div class="rp-bar">${runs.length ? filters : ""}${checks}</div>${cards ? `<div class="rp-list">${cards}</div>${pager}` : `<div class="card"><div class="empty">${runs.length ? "No finished run matches." : "No run has finished yet."}</div></div>`}`;
}

/** The Reports page's filters, as its address gives them. */
export function reportsQuery(
  get: (k: string) => string | undefined,
  many: (k: string) => string[],
): ReportsQuery {
  const at = Number(get("at"));
  return {
    mode: many("mode").filter((m) => m in MODE_WORDS),
    campaign: many("campaign"),
    checks: get("checks") === "1",
    at: Number.isInteger(at) && at > 0 ? at : 0,
  };
}
