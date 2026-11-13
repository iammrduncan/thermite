import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { esc, infoLabel } from "../../ui/components/index.ts";
import {
  advisorLabel,
  agentKind,
  type LiveEntry,
  liveEntryHtml,
  resultJoin,
  runSourceName,
  whoTags,
} from "../../ui/live.ts";
import { rigHref, runLiveHref } from "../../ui/urls.ts";
import type { RigView, RunView } from "../../views/index.ts";
import type { Ctx, Dashboard } from "../context.ts";
import { type LiveFeed, type PushedLine, pushLive, pushStart } from "./push.ts";
import { EVERYTHING_HREF, liveRunsNav } from "./runs.ts";

/**
 * Live's Everything (goal 188): every agent's lines from every run and rig, as they come, each
 * with its run (or its rig, for a line that names none), with Rig and Run to narrow them and a
 * filter for each agent, as a run's Live has.
 */

/** How many lines the page shows first. */
const FIRST_LINES = 600;

type Line = LiveEntry & { run?: string | undefined; signed: boolean; rig: string };

/** What the page narrows to: one rig, one run, or every one. */
interface Narrow {
  rig: string;
  run: string;
}

const narrowOf = (c: Ctx): Narrow => ({
  rig: c.req.query("rig") ?? "",
  run: c.req.query("run") ?? "",
});
const keeps = (n: Narrow) => (e: Line) =>
  (!n.rig || e.rig === n.rig) && (!n.run || e.run === n.run);

const hrefOf = (n: Narrow, w = "all", stream = false) => {
  const q = new URLSearchParams();
  if (n.rig) q.set("rig", n.rig);
  if (n.run) q.set("run", n.run);
  if (w !== "all" && !stream) q.set("w", w);
  const s = q.toString();
  return `${EVERYTHING_HREF}${stream ? "/stream" : ""}${s ? `?${s}` : ""}`;
};

/** One line as Everything shows it: its run (or rig) first, then the line as a run's Live has it. */
function lineHtml(e: Line, runs: ReadonlyMap<string, RunView>, now: number): string {
  const run = e.run ? runs.get(e.run) : undefined;
  const where = run
    ? `<a class="lv-runtag" href="${esc(runLiveHref(run))}" title="Open ${esc(run.id)}'s Live">${esc(run.id)}</a>`
    : `<a class="lv-runtag" href="${esc(`${rigHref(e.rig)}/live`)}" title="${esc(e.rig)}'s own lines">${esc(e.run ?? e.rig)}</a>`;
  return liveEntryHtml(e, { showWho: true, name: runSourceName, now, md: true })
    .replace(
      /^<div class="lv-row /,
      `<div data-who="${esc(whoTags(e))}" data-src="${esc(e.source)}" data-rig="${esc(e.rig)}" class="lv-row `,
    )
    .replace('<div class="lv-body">', `<div class="lv-body">${where}`);
}

const runsOf = (vs: readonly RigView[]) =>
  new Map(vs.flatMap((u) => u.runs.map((r): [string, RunView] => [r.id, r])));

export function everythingRoutes(app: Hono, dash: Dashboard): void {
  const { page, store, views } = dash;

  app.get(EVERYTHING_HREF, async (c) => {
    const vs = await views();
    const now = Date.now();
    const n = narrowOf(c);
    const w = c.req.query("w") || "all";
    const lines = (await store.liveLines.everywhereTail(FIRST_LINES)).filter(keeps(n));
    const runs = runsOf(vs);
    const { nav } = liveRunsNav(vs, now, "everything");
    // A filter for each agent with lines here, in the order of a run's Live, each in its colour.
    const chip = (key: string, label: string, kind = "") =>
      `<a class="lchip${w === key ? " on" : ""}" data-w="${esc(key)}" href="${esc(hrefOf(n, key))}">${kind ? `<span class="kdot k-${esc(kind)}"></span>` : ""}${esc(label)}</a>`;
    const lanes = [
      ...new Set(lines.flatMap((e) => (e.source.startsWith("trial:") && e.lane ? [e.lane] : []))),
    ].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const order = ["teacher", "merger", "auditor", "reviewer", "writer", "advisor"];
    const advisors = [
      ...new Set(lines.filter((e) => e.source.startsWith("advisor:")).map((e) => e.source)),
    ]
      .sort(
        (a, b) =>
          order.indexOf(agentKind(a)) - order.indexOf(agentKind(b)) ||
          a.localeCompare(b, undefined, { numeric: true }),
      )
      .map((s) => chip(s.slice(8), advisorLabel(s.slice(8)), agentKind(s)));
    const chips = [
      chip("all", "Everyone"),
      ...lanes.map((l) => chip(l, l, "lane")),
      chip("planner", "Planner", "planner"),
      chip("judge", "Judge", "judge"),
      chip("advisors", "Advisors", "advisor"),
      ...advisors,
    ].join("");
    const option = (value: string, label: string, chosen: string) =>
      `<option value="${esc(value)}"${value === chosen ? " selected" : ""}>${esc(label)}</option>`;
    const allRuns = [...runs.values()].filter((r) => r.status === "running" || r.id === n.run);
    const facets = `<form class="lfacets" method="get" action="${EVERYTHING_HREF}" data-autosubmit>
<input type="hidden" name="w" value="${esc(w)}">
<label>${infoLabel("Rig", "Show the lines of one rig only. Every rig: all of them.")} <select name="rig">${option("", "Every rig", n.rig)}${vs.map((u) => option(u.id, u.id, n.rig)).join("")}</select></label>
<label>${infoLabel("Run", "Show the lines of one run only. Every run: the runs at work, and the rigs' own lines.")} <select name="run">${option("", "Every run", n.run)}${allRuns.map((r) => option(r.id, r.id, n.run)).join("")}</select></label>
<noscript><button class="sm">Show</button></noscript>
</form>`;
    const atWork = [...runs.values()].filter((r) => r.status === "running").length;
    const head = `<div class="lhead"><button class="ghost sm lnav-btn" type="button" title="Show or hide the list of runs" aria-label="Runs">☰</button><span class="t">Everything</span><span class="lmeta">every agent of every run, as they work · ${vs.length} rig${vs.length === 1 ? "" : "s"} · ${atWork} run${atWork === 1 ? "" : "s"} at work</span></div>`;
    return page(
      c,
      { title: "Live", summary: "every agent of every run", active: "live", flush: true },
      `<div class="lwrap" id="lwrap">${nav}<section class="lcol">${head}${facets}<div class="lchips">${chips}<span class="grow"></span><button class="lchip on lfollow" type="button" aria-pressed="true" title="Follow new lines">↓ Follow</button></div>
<div class="transcript lstream" id="transcript" data-stream="${esc(hrefOf(n, w, true))}" data-run="*" data-w="${esc(w)}" data-after="${lines.at(-1)?.id ?? 0}">${lines.map((e) => lineHtml(e, runs, now)).join("") || `<div class="empty">No live lines yet. They appear here as the agents, the judges and the advisors work, on every rig.</div>`}</div></section></div>`,
      vs,
    );
  });

  // Every rig's new lines, narrowed as the page is, pushed to it.
  app.get(`${EVERYTHING_HREF}/stream`, (c) => {
    const n = narrowOf(c);
    const draw = async (lines: Line[]): Promise<PushedLine[]> => {
      const now = Date.now();
      const runs = runsOf(await views());
      return lines.filter(keeps(n)).map((e) => ({
        id: e.id,
        kind: e.kind,
        src: e.source,
        html: lineHtml(e, runs, now),
        ...(e.kind === "result" ? { join: resultJoin(e) } : {}),
      }));
    };
    const feed: LiveFeed = {
      after: async (after, limit) => draw(await store.liveLines.everywhere(after, limit)),
      newest: async (limit) => draw(await store.liveLines.everywhereTail(limit)),
      count: async (after) => store.liveLines.everywhereCount(after),
    };
    const after = pushStart(c.req.header("last-event-id"), c.req.query("after"));
    return streamSSE(c, (stream) => pushLive(stream, store, feed, { after, recheck: [] }));
  });
}
