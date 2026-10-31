import type { Hono } from "hono";
import { isRigCheck } from "../../../../core/ids.ts";
import { commandFollowUrl, commandProgress } from "../../../command-progress.ts";
import { runPrompts } from "../../../prompts.ts";
import {
  esc,
  icon,
  JUDGE_ONLY_WORDS,
  modeName,
  reportingTag,
  runState,
} from "../../../ui/components/index.ts";
import { exportMenu } from "../../../ui/exports.ts";
import { waitEnd, waitsForLimit } from "../../../ui/operator/index.ts";
import {
  campaignHref,
  knowledgeHref,
  RUN_ROUTES,
  type RunTab,
  rigHref,
  runHref,
  runLiveHref,
  runTab,
} from "../../../ui/urls.ts";
import { earlierWords } from "../../../ui/words/index.ts";
import type { RunOnRig } from "../../../views/index.ts";
import type { Ctx, Dashboard } from "../../context.ts";
import { runHelpers } from "./section.ts";

/**
 * A run's page under its campaign (goal 170), one tab at a time, wherever the run ran: its rig's
 * current ledger, an earlier ledger or a retired rig. Before the rig reports the run, the page
 * follows its start instead.
 */
export function runPageRoutes(app: Hono, dash: Dashboard): void {
  const { cmdForm, csrf, moreMenu, page, pauseMenu, runOf, store, views } = dash;
  const { runSection } = runHelpers(dash);

  /**
   * A run that is starting, until its rig reports it: how the start goes, in words, following its
   * command (goal 080); the page opens on the run once the rig reports it. A start the rig refused
   * says why. Undefined: control signed no assignment of this run for this campaign.
   */
  const startingCard = (campaign: string, run: string) => {
    const a = store.runRegistry.assigned(run);
    const cmd = a && (a.campaign ?? run) === campaign ? store.commands.row(a.command) : undefined;
    if (!a || !cmd) return undefined;
    const p = commandProgress(cmd, Date.now());
    const failed = p.state === "refused" || p.state === "expired";
    const follow = p.final
      ? ""
      : ` data-follow="${esc(commandFollowUrl(cmd.id))}" data-follow-state="${p.state}"`;
    return `<div class="card" style="margin-bottom:16px" data-part="starting"${follow}><b${failed ? ` class="bad"` : ""}>${failed ? "Not started:" : "Starting"} ${esc(run)} on ${esc(a.rig)}.</b> <span class="${p.tone}">${esc(p.said)}</span>${failed ? "" : ` <span class="muted">The rig fetches the project and the kit, and checks both. The run's page opens here when the rig reports the run, usually within a minute.</span>`}</div>`;
  };

  /**
   * Resume now, while the run's agents wait for the provider's limit: what the wait is, and what
   * ending it does (`end_wait`).
   */
  const resumeNow = (c: Ctx, x: RunOnRig, back: string) => {
    const { rig: u, run: r } = x;
    const wait = r.agents_wait;
    if (!wait || !waitsForLimit(r, Date.now())) return "";
    return `<details class="menu" data-part="resume-now"><summary class="btn">Resume now</summary><div class="menu-pop">${cmdForm(c, { rig: u.id, kind: "end_wait", fields: { run: r.id }, label: "End the wait now", cls: "sm primary", back })}<div class="muted small">The agents wait for the provider's limit until ${esc(waitEnd(wait.until))}${wait.reason ? ` (${esc(wait.reason.slice(0, 200))})` : ""}: no new trial or plan of this run starts before then. Ending the wait starts them now. If the limit still holds, the next trial meets it and the run waits again. A trial that waits in its own conversation goes on at its own time.</div></div></details>`;
  };

  /**
   * The run's buttons: Live, Message, Resume now (while it waits for its provider), Pause or
   * Resume, Export and ⋯; none for an earlier run.
   */
  const actions = (c: Ctx, x: RunOnRig, back: string) => {
    const { rig: u, run: r } = x;
    if (x.earlier) return "";
    const quick =
      r.status === "paused"
        ? cmdForm(c, {
            rig: u.id,
            kind: "resume_run",
            fields: { run: r.id },
            label: "Resume",
            back,
          })
        : r.status === "running"
          ? pauseMenu(c, u.id, r.id, back)
          : "";
    // A run without agents (a try, a rig check) has no one to message and no lanes to restart.
    const agents = r.has_agents !== false;
    return `<a class="btn" href="${runLiveHref(r)}">${icon.terminal}Live</a>${agents ? `<a class="btn" href="${runLiveHref(r, { compose: true })}">Message</a>` : ""}${resumeNow(c, x, back)}${quick}${exportMenu({ csrf: csrf(c), rig: u.id, run: r.id, back })}${moreMenu(c, u.id, r, back, "", true)}`;
  };

  const runPage = async (c: Ctx, tab: RunTab) => {
    const now = Date.now();
    const vs = views();
    const campaign = c.req.param("campaign") ?? "";
    const id = c.req.param("run") ?? "";
    const x = await runOf(campaign, id);
    const crumbs = [
      { href: "/ui/campaigns", text: "Campaigns" },
      { href: campaignHref(campaign), text: campaign },
    ];
    if (!x) {
      const starting = startingCard(campaign, id);
      if (!starting) c.status(404);
      return page(
        c,
        { title: starting ? id : "Not found", crumbs, active: "campaigns" },
        starting ??
          `<div class="card"><div class="empty">No such run in this campaign.</div></div>`,
        vs,
      );
    }
    const { rig: u, run: r } = x;
    const back = runHref(r, tab);
    const note = c.req.query("ok") ?? c.req.query("error");
    const said = note
      ? `<div class="card${c.req.query("error") ? " warn" : ""}" style="margin-bottom:16px"><b class="${c.req.query("error") ? "bad" : "ok"}">${esc(note)}</b></div>`
      : "";
    // An earlier run (goal 170): its rig retired, or it ran before its rig's full reset. Its
    // records stay; it runs no more and takes no commands.
    const st = x.earlier
      ? r.status === "closed"
        ? runState(r)
        : { text: "Stopped", cls: "muted", icon: "" }
      : runState(r);
    const where = x.earlier
      ? `${esc(earlierWords(u.id, x.earlier))}`
      : `on <a href="${rigHref(u.id)}">${esc(u.id)}</a>${reportingTag(u)}`;
    const earlierCard = x.earlier
      ? `<div class="card hl" style="margin-bottom:12px"><b>An earlier run.</b> ${
          x.earlier === "retired"
            ? `It ran on ${esc(u.id)}, which is retired.`
            : `It ran on <a href="${rigHref(u.id)}">${esc(u.id)}</a> before the rig's full reset.`
        } Control keeps its records, which show here as they were. It runs no more, and it takes no commands.</div>`
      : "";
    const agents = r.has_agents !== false;
    const kind = /-try-\d+$/.test(r.id)
      ? `<div class="card hl" style="margin-bottom:12px"><b>A try of the kit.</b> No agents work on this run: the judge builds the starting point and runs every case on its own. When the results look right, <a href="${campaignHref(campaign)}?start=1">start the campaign</a>.</div>`
      : agents || isRigCheck(campaign)
        ? ""
        : // Any other run started with its agents off (goal 099): say so plainly. A rig check's
          // smoke run is the rig page's to explain.
          `<div class="card hl" style="margin-bottom:12px"><b>Judge only:</b> ${esc(JUDGE_ONLY_WORDS)}</div>`;
    // What its agents search in the knowledge base, fixed when it started (goal 175).
    const scope = agents && !x.earlier ? store.kb().scope(campaign, r.id) : undefined;
    const searches = scope
      ? `<div class="muted small" style="margin-bottom:12px" data-part="kb-scope">Its agents search ${scope.fresh ? "only this run's own items" : "the campaign's whole collection"} in the <a href="${knowledgeHref(campaign)}">knowledge base</a>${scope.granted.length ? `, and ${esc(scope.granted.join(", "))}, read only` : ""}: set when the run started.</div>`
      : "";
    // The Prompts tab's list, read from the message bus.
    const prompts = tab === "prompts" ? await runPrompts(store, x) : [];
    return page(
      c,
      {
        title: r.id,
        crumbs,
        summary: `${where} · ${esc(modeName(r.mode))}${agents ? "" : " · judge only"} · <span class="label ${st.cls}">${st.icon}${esc(st.text)}</span>`,
        active: "campaigns",
        actions: actions(c, x, back),
      },
      `${said}${earlierCard}${kind}${searches}${runSection(c, x, vs, now, tab, prompts)}`,
      vs,
    );
  };

  app.get(RUN_ROUTES.run, (c) => runPage(c, "overview"));
  // A tab; any other last part is another route's (Live, the paper), registered with theirs.
  app.get(RUN_ROUTES.tab, (c, next) => {
    const tab = runTab(c.req.param("tab"));
    return tab ? runPage(c, tab) : next();
  });
}
