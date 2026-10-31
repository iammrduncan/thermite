import type { Hono } from "hono";
import { knownTimeZone, type UsagePeriod } from "../../core/usage.ts";
import { campaignFilter, campaignsListBody, isRigCheck } from "../ui/campaigns/list.ts";
import { ago, esc } from "../ui/components/index.ts";
import { runBrief, timeline } from "../ui/operator/index.ts";
import { campaignHref } from "../ui/urls.ts";
import { metricsBody } from "../ui/usage.ts";
import { usageData } from "../usage.ts";
import {
  type CampaignView,
  campaignModes,
  campaignViews,
  podStopped,
  type RigView,
  type RunView,
  runCampaign,
} from "../views/index.ts";
import { campaignHelpers, copiedBy, headline } from "./campaigns/shared.ts";
import { campaignOfRun, type Dashboard } from "./context.ts";

/** The Overview, Campaigns and Metrics pages: the first pages of the navigation. */
export function overviewRoutes(app: Hono, dash: Dashboard): void {
  const { archivedNames, csrf, needs, notArchived, opts, page, store, views } = dash;
  const { aboutOf, workCardFor } = campaignHelpers(dash);

  // ---------------------------------------------------------------- overview (Magnesium's Home)
  /** The run an event is about: its body's run, the run it names, or its attempt's run. */
  const eventRun = (u: RigView, e: RigView["recent"][number]): string | undefined => {
    const b = e.body?.run;
    if (typeof b === "string") return b;
    if (!e.subject) return undefined;
    if (u.runs.some((r) => r.id === e.subject)) return e.subject;
    return u.runs.find((r) => r.attempts.some((a) => a.id === e.subject))?.id;
  };
  app.get("/ui", (c) => {
    const now = Date.now();
    const vs = views();
    // An archived campaign (goal 077) leaves Needs you and the lists here.
    const archived = archivedNames();
    const feed = notArchived(vs, needs(c, vs, now), archived);
    const urgent = feed.filter((n) => n.kind !== "stale");
    const camps = campaignViews(vs);
    const shelved = (u: RigView, run: string | undefined) =>
      run !== undefined && archived.has(campaignOfRun([u], u.id, run) ?? "");
    // What happened lately, across rigs, in words.
    const activity = timeline(
      vs.flatMap((u) =>
        u.recent
          .slice(0, 40)
          .filter((e) => !archived.size || !shelved(u, eventRun(u, e)))
          .map((e) => ({ u, e })),
      ),
      now,
      { limit: 10, showRig: true },
    );
    // One scan, top to bottom: what needs you, what is at work, what happened.
    const live = vs.flatMap((u) =>
      u.runs
        .filter((i) => i.status === "running" && !archived.has(runCampaign(i)))
        .map((i) =>
          runBrief(store, u, i, now, {
            heading: true,
            waiting: feed.filter((n) => n.rig === u.id && n.run === i.id).length,
          }),
        ),
    );
    const running = live.length;
    // A stopped RunPod pod can't report, and that is expected: it is counted apart.
    const stopped = vs.filter(podStopped).length;
    const expected = vs.length - stopped;
    const reporting = vs.filter((u) => !u.stale && !podStopped(u)).length;
    const judging = vs.filter((u) => u.judge.now).length;
    const tile = (n: string, label: string, tone: string, href = "") =>
      `<${href ? `a href="${href}"` : "div"} class="tally ${tone}"><b>${n}</b><span>${esc(label)}</span></${href ? "a" : "div"}>`;
    const tallies = `<div class="tallies">${tile(String(urgent.length), urgent.length === 1 ? "needs you" : "need you", urgent.length ? "warn" : "", urgent.length ? "#needs" : "")}${tile(String(running), running === 1 ? "run at work" : "runs at work", running ? "ok" : "")}${tile(String(judging), judging === 1 ? "judge measuring" : "judges measuring", "")}${tile(`${reporting}/${expected}`, `rigs reporting${stopped ? `, ${stopped} stopped` : ""}`, reporting < expected ? "bad" : "")}</div>`;
    return page(
      c,
      {
        title: "Overview",
        summary: `${urgent.length ? `<span class="warn">${urgent.length} need${urgent.length === 1 ? "s" : ""} you</span>` : "nothing needs you"} · ${running} run${running === 1 ? "" : "s"} at work · ${reporting} of ${expected} rigs reporting${stopped ? ` · ${stopped} stopped` : ""}`,
        active: "overview",
      },
      `<div data-part="tallies">${tallies}</div>
<div class="block" id="needs" data-part="needs"><div class="head"><h2>Needs you</h2><span class="n">${feed.length}</span><span class="right">open one for its evidence and what each choice does</span></div>
${feed.length ? `<div class="dqs">${feed.map((n) => n.html).join("")}</div>` : `<div class="card"><div class="empty">Nothing waits for you. The campaigns go on by themselves.</div></div>`}</div>
<div class="block" data-part="at-work"><div class="head"><h2>At work</h2><span class="n">${running}</span></div>
${live.length ? live.join("") : `<div class="card"><div class="empty">${camps.length ? "No run is running." : opts.kits ? "No campaign yet. Make one with New campaign on the Campaigns page, or assign one to a rig through control's API, MCP or the CLI." : "No campaign yet. Assign one to a rig through control's API, MCP or the CLI."}</div></div>`}</div>
<div class="block" data-part="happened"><div class="head"><h2>What happened</h2><span class="right">newest first</span></div>${activity}</div>`,
      vs,
    );
  });

  // ---------------------------------------------------------------- campaigns
  app.get("/ui/campaigns", (c) => {
    const now = Date.now();
    const vs = views();
    // Archived campaigns (goal 077) have their own filter, with Unarchive; one with no runs too.
    const shelf = new Map(store.archive.list().map((a) => [a.campaign, a]));
    const reported = campaignViews(vs);
    const modes = shelf.size ? campaignModes(store, vs) : new Map<string, string | null>();
    const camps: CampaignView[] = [
      ...reported,
      ...[...shelf.keys()]
        .filter((name) => !reported.some((k) => k.name === name))
        .map((name) => ({ name, mode: modes.get(name) ?? null, runs: [] })),
    ];
    const feed = notArchived(vs, needs(c, vs, now, "/ui/campaigns"), new Set(shelf.keys()));
    const waitingFor = (u: RigView, r: RunView) =>
      feed.filter((n) => n.rig === u.id && n.run === r.id).length;
    // Rig checks have their own filter: At work counts the campaigns' runs only.
    const atWork = vs.flatMap((u) =>
      u.runs
        .filter(
          (r) =>
            r.status === "running" && !isRigCheck(r.campaign ?? "") && !shelf.has(runCampaign(r)),
        )
        .map((r) => workCardFor(c, u, r, now, waitingFor(u, r), "/ui/campaigns")),
    );
    const waiting = vs
      .flatMap((u) => u.runs.map((r) => ({ rig: u, run: r, n: waitingFor(u, r) })))
      .filter((w) => w.n > 0);
    const shown = camps.length - shelf.size;
    return page(
      c,
      {
        title: "Campaigns",
        summary: `${atWork.length} at work · ${waiting.reduce((a, w) => a + w.n, 0)} decision${waiting.reduce((a, w) => a + w.n, 0) === 1 ? " waits" : "s wait"} for you · ${shown} campaign${shown === 1 ? "" : "s"}${shelf.size ? ` · ${shelf.size} archived` : ""}`,
        active: "campaigns",
        actions: opts.kits
          ? `<a class="btn primary" href="/ui/campaigns/new">New campaign</a>`
          : undefined,
      },
      camps.length
        ? campaignsListBody({
            camps,
            atWork,
            waiting,
            archived: new Map(
              [...shelf].map(([name, a]) => {
                const folder = store.folders.of(name);
                return [
                  name,
                  `${ago(a.at, now)} ago by ${copiedBy(a.by)}${folder ? ` · in ${folder.name}` : ""}`,
                ];
              }),
            ),
            unarchive: (name) =>
              `<form class="inline" method="post" action="${campaignHref(name)}/unarchive"><input type="hidden" name="csrf" value="${esc(csrf(c))}"><input type="hidden" name="back" value="/ui/campaigns?f=archived"><button class="sm">Unarchive</button></form>`,
            filter: campaignFilter(c.req.query("f")),
            query: c.req.query("q") ?? "",
            now,
            best: (k) => {
              const h = headline(k);
              return `${h.value} ${h.sub.replace(" (best run)", "").replace("best gain over its baseline", "gain")}`;
            },
            about: (k) => aboutOf(k.name),
          })
        : `<div class="card"><div class="empty">No campaign yet.${opts.kits ? ` <a href="/ui/campaigns/new">Start one.</a>` : ""}</div></div>`,
      vs,
    );
  });

  // ---------------------------------------------------------------- Metrics (goal 075)
  // The whole system's model use and cost, by model and by campaign: today, the last 7 days (the
  // default) or all. Today starts at midnight in the viewer's own time zone, which the page
  // script adds to the address (tz); without it, UTC, and the line under the title says so.
  app.get("/ui/metrics", (c) => {
    const now = Date.now();
    const vs = views();
    const p = c.req.query("period");
    const period: UsagePeriod = p === "today" || p === "all" ? p : "7d";
    const asked = (c.req.query("tz") ?? "").trim();
    const tz = asked && asked.length <= 64 && knownTimeZone(asked) ? asked : "UTC";
    const d = usageData(store, { period, tz }, new Date(now));
    const modes = new Map(campaignViews(vs).map((k) => [k.name, k.mode]));
    return page(
      c,
      {
        title: "Metrics",
        summary: `every campaign and rig · times in ${esc(tz)}`,
        active: "metrics",
      },
      metricsBody({
        report: d.report,
        rows: d.rows,
        podRigs: [...new Set(d.pods.map((x) => x.rig))],
        // A campaign no rig reports now: its mode as control saved it, when it did.
        mode: (k) => {
          const saved = (store.campaigns.versions(k)[0]?.contract as { mode?: unknown } | undefined)
            ?.mode;
          return modes.get(k) ?? (typeof saved === "string" ? saved : null);
        },
        now,
      }),
      vs,
    );
  });
}
