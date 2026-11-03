import type { Hono } from "hono";
import { commandFollowUrl, commandProgress } from "../../../command-progress.ts";
import { esc } from "../../../ui/components/index.ts";
import {
  attemptDetail,
  needs as operatorNeeds,
  withdrawBlock,
} from "../../../ui/operator/index.ts";
import {
  attemptHref,
  campaignHref,
  championPatchHref,
  RUN_ROUTES,
  runHref,
} from "../../../ui/urls.ts";
import { runCampaign } from "../../../views/index.ts";
import type { Dashboard } from "../../context.ts";

/**
 * What a run owns that has a page or a file of its own, under the run's address (goal 170): one
 * attempt's page, the run's champion patches and its research paper.
 */
export function attemptRoutes(app: Hono, dash: Dashboard): void {
  const { forms, page, runOf, store } = dash;
  /** The run the route names, under the campaign it names. */
  const named = (c: { req: { param(k: string): string } }) =>
    runOf(c.req.param("campaign"), c.req.param("run"));

  // A champion as a patch file: the result an operator takes away (it applies to the base commit).
  app.get(RUN_ROUTES.champion, async (c) => {
    const m = /^(\d+)\.patch$/.exec(c.req.param("file"));
    const x = await named(c);
    const p =
      m && x
        ? store.championPatches.get(x.rig.id, x.rig.ledger_id, x.run.id, Number(m[1]))
        : undefined;
    if (!m || !x || !p) return c.text("No patch for that champion yet.", 404);
    // A project in a folder: named after the repository's commit, the one its owner has.
    const folder = x.run.seed_folder;
    const name = `${x.run.id}-champion-${m[1]}-on-${(folder?.commit ?? p.base_commit).slice(0, 8)}.patch`;
    return c.body(new Uint8Array(p.patch), 200, {
      "content-type": "text/x-diff; charset=utf-8",
      "content-disposition": `attachment; filename="${name.replace(/[^\w.-]/g, "_")}"`,
    });
  });

  // A research run's paper (goal 112), as its rig's report carries it: the Markdown file, with
  // the references the harness appended (the same text is paper.md in the run's research folder).
  // Shown as plain text: it is the agents' writing.
  app.get(RUN_ROUTES.paper, async (c) => {
    const x = await named(c);
    const p = x?.run.paper;
    if (!x || p?.state !== "in" || !p.text)
      return c.text("No research paper for that run yet.", 404);
    return c.body(p.text, 200, {
      "content-type": "text/plain; charset=utf-8",
      "content-disposition": `inline; filename="${`${x.run.id}-paper.md`.replace(/[^\w.-]/g, "_")}"`,
    });
  });

  /** The follow of the owner's newest decision on a change, while the rig has not done it. */
  const followDecision = (rig: string, attempt: string, now: number) => {
    const d = store.commands.decisions().find((x) => x.rig === rig && x.attempt === attempt);
    const cmd = d ? store.commands.row(d.id) : undefined;
    const p = cmd ? commandProgress(cmd, now) : undefined;
    return cmd && p && !p.final
      ? ` data-follow="${esc(commandFollowUrl(cmd.id))}" data-follow-state="${esc(p.state)}"`
      : "";
  };
  app.get(RUN_ROUTES.attempt, async (c) => {
    const now = Date.now();
    const x = await named(c);
    const id = c.req.param("attempt");
    const a = x?.run.attempts.find((y) => y.id === id);
    if (!x || !a) {
      c.status(404);
      return page(
        c,
        { title: "Not found", active: "campaigns" },
        `<div class="card"><div class="empty">No such attempt in this run.</div></div>`,
      );
    }
    const { rig: u, run: r } = x;
    const back = attemptHref(r, a.id);
    // The change's own page keeps its decision after the owner chose: it says what the rig did.
    // An earlier run's changes wait for no one: its rig takes no more commands for it.
    const decision = x.earlier
      ? undefined
      : operatorNeeds(store, [u], forms(c), now, back).find((n) => n.attempt === a.id);
    // A champion's patch, once the rig has published it.
    const champ = r.champion.find((y) => y.attempt === a.id && !y.reopened);
    const patch =
      champ && store.championPatches.get(u.id, u.ledger_id, r.id, champ.seq)
        ? `<a href="${championPatchHref(r, champ.seq)}">Download champion #${champ.seq} as a patch</a>`
        : undefined;
    // The owner's withdrawal of its evidence (goal 174): the newest command about it or its jobs.
    const jobs = u.judge.jobs.filter((j) => j.attempt === a.id);
    const asked = store.commands
      .latest(u.id, "invalidate_evidence")
      .find(
        (y) =>
          y.payload.run === r.id &&
          (y.payload.attempt === a.id || jobs.some((j) => Number(j.id) === y.payload.job)),
      );
    const withdraw = x.earlier
      ? undefined
      : withdrawBlock({ csrf: forms(c).csrf, rig: u.id, back }, r, a, jobs, asked, now);
    return page(
      c,
      {
        title: a.id,
        crumbs: [
          { href: "/ui/campaigns", text: "Campaigns" },
          { href: campaignHref(runCampaign(r)), text: runCampaign(r) },
          { href: runHref(r), text: r.id },
        ],
        active: "campaigns",
      },
      // One part: the owner's decision and what the rig did show without a refresh (goal 080),
      // followed while the rig has not done it.
      `<div data-part="attempt"${followDecision(u.id, a.id, now)}>${attemptDetail(u, r, a, now, { decision, patch, withdraw })}</div>`,
    );
  });
}
