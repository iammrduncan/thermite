import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { errorText } from "../../../common/errors.ts";
import { commandFollowUrl, commandProgress, notSent } from "../../command-progress.ts";
import { issueCommand, nobodyReads, panelReviews } from "../../issue/index.ts";
import { HARNESS_NAMES } from "../../rigs/index.ts";
import { lastActivity } from "../../ui/campaigns/list.ts";
import {
  ago,
  esc,
  icon,
  modeAvatar,
  modeName,
  num,
  runCompleted,
  runState,
} from "../../ui/components/index.ts";
import {
  liveEntryHtml,
  liveLinesHtml,
  resultJoin,
  runEntryHtml,
  runLinesHtml,
} from "../../ui/live.ts";
import { waitingOn } from "../../ui/operator/index.ts";
import {
  liveHref,
  RUN_ROUTES,
  rigHref,
  rigLiveStreamHref,
  runHref,
  runLiveHref,
  runLiveStreamHref,
  runMessageHref,
} from "../../ui/urls.ts";
import { clip, earlierWords, signed } from "../../ui/words/index.ts";
import {
  currentChampion,
  podStopped,
  type RigView,
  type RunOnRig,
  type RunView,
  runCampaign,
  runMessages,
} from "../../views/index.ts";
import { type Ctx, type Dashboard, wantsJson } from "../context.ts";
import { type LiveFeed, type PushedLine, pushLive, pushStart, recheckIds } from "./push.ts";
import { terminalPanel, terminalRoutes } from "./terminal.ts";

/**
 * Live, one run at a time (goal 063), under the run's address, with the owner's messages to its
 * agents; and one rig's sessions over every run, a trial's with its terminal and the owner's
 * console (terminal.ts). Each page's new lines are pushed to it as control gets them (push.ts).
 */
export function liveRoutes(app: Hono, dash: Dashboard): void {
  const { cmdForm, csrf, moreMenu, opts, page, pauseMenu, runOf, store, views } = dash;
  terminalRoutes(app, dash);
  /** The run a route names, under the campaign it names (goal 170). */
  const named = (c: Ctx) => runOf(c.req.param("campaign") ?? "", c.req.param("run") ?? "");

  // ---------------------------------------------------------------- live, one run at a time (goal 063)
  /**
   * Live: the runs at work on the left; one run's stream in the middle, with filters for each
   * lane, the planner, the judge, the advisors and the owner's own messages; under it, one
   * message box that writes to the lane being watched. `chosen`: the run the address names,
   * wherever it ran (an earlier run takes no messages); none, the first run at work.
   */
  const livePage = (c: Ctx, chosen?: RunOnRig) => {
    const vs = views();
    const now = Date.now();
    const all = vs.flatMap((u) => u.runs.map((r) => ({ u, r })));
    const atWork = all.filter((x) => x.r.status === "running");
    const first = atWork[0];
    const sel = chosen
      ? { u: chosen.rig, r: chosen.run, earlier: chosen.earlier }
      : first
        ? { ...first, earlier: null }
        : undefined;
    const day = now - 24 * 3600_000;
    const ended = all
      .filter((x) => x.r.status !== "running" && Date.parse(lastActivity(x.r)) > day)
      .sort((a, b) => lastActivity(b.r).localeCompare(lastActivity(a.r)));
    const idle = vs.filter((u) => !u.runs.some((r) => r.status === "running"));
    const runLink = (x: { u: RigView; r: RunView }, sub: string, cls = "") =>
      `<a class="lr${sel && x.u.id === sel.u.id && x.r.id === sel.r.id ? " on" : ""}${cls}" href="${runLiveHref(x.r)}"><span class="t">${x.r.status === "running" ? `<span class="dot ok pulse"></span>` : ""}${esc(x.r.id)}</span><span class="s">${sub}</span></a>`;
    const nav = `<nav class="lruns" aria-label="Runs" data-part="lruns">
<div class="hd">At work</div>${atWork.map((x) => runLink(x, `${esc(x.u.id)} · ${esc(modeName(x.r.mode))} · ${Object.keys(x.r.at_work).length} working${waitingOn(x.r, x.u) ? ` · <span class="warn">${waitingOn(x.r, x.u)} wait for you</span>` : ""}`)).join("") || `<div class="lempty">No run is at work.</div>`}
${idle.length ? `<div class="hd">Idle rigs</div>${idle.map((u) => `<a class="lr idle" href="${rigHref(u.id)}"><span class="t">${esc(u.id)}</span><span class="s">no run at work${podStopped(u) ? " · its pod is stopped" : u.stale ? " · not reporting" : ""}</span></a>`).join("")}` : ""}
${ended.length ? `<details class="lended"${sel && sel.r.status !== "running" ? " open" : ""}><summary class="hd">Ended in the last day (${ended.length})</summary>${ended.map((x) => runLink(x, `${esc(x.u.id)} · ${runCompleted(x.r) ? "completed" : x.r.status === "closed" ? "finished" : esc(x.r.status)}`, " idle")).join("")}</details>` : ""}
</nav>`;
    if (!sel)
      return page(
        c,
        { title: "Live", summary: "no run at work", active: "live", flush: true },
        `<div class="lwrap">${nav}<section class="lcol"><div class="empty" style="margin:auto">${ended.length ? "No run is at work. Pick one from the list to see its lines." : "No run to watch yet. Runs show here as soon as a rig reports one."}</div></section></div>`,
        vs,
      );
    const { u, r } = sel;
    const research = r.mode === "research";
    const trials = store.liveLines.trials(u.id).filter((t) => t.run === r.id);
    const lanes = [
      ...new Set([
        ...Object.keys(r.at_work),
        ...(r.epoch?.assignments.map((a) => a.lane) ?? []),
        ...trials.map((t) => t.lane).filter((l): l is string => !!l),
      ]),
    ].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const lines = store.liveLines.runTail(u.id, r.id, 600);
    const after = lines.at(-1)?.id ?? 0;
    const w = c.req.query("w") || "all";
    // The filters: everyone, each lane (working or not), the planner, the judge, the advisors, you.
    const chip = (key: string, label: string, title = "", working = false) =>
      `<a class="lchip${w === key ? " on" : ""}" data-w="${esc(key)}" href="${runLiveHref(r, { w: key })}"${title ? ` title="${esc(title)}"` : ""}>${working ? `<span class="dot ok"></span>` : ""}${esc(label)}</a>`;
    const chips = [
      chip("all", "Everyone"),
      ...lanes.map((l) => {
        const work = r.at_work[l];
        return chip(
          l,
          l,
          work ? `${work.family}: ${work.focus}` : "between trials",
          Boolean(work) && r.status === "running",
        );
      }),
      chip("planner", "Planner"),
      ...(research ? [] : [chip("judge", "Judge")]),
      chip("advisors", "Advisors"),
      chip("you", "You", "your messages, and who read them"),
    ].join("");
    // Each lane's trial at work in its program's own terminal (goal 169): its page has the terminal.
    const inTerminals =
      r.status === "running" && u.settings?.program_mode === "terminal" && u.model?.harness !== "pi"
        ? Object.entries(r.at_work).sort(([a], [b]) =>
            a.localeCompare(b, undefined, { numeric: true }),
          )
        : [];
    const terminals = inTerminals.length
      ? `<details class="lkept"><summary class="lchip" title="Each lane's agent in its own terminal: watch it, and type into it">⌨ Terminals</summary><div class="menu-pop">${inTerminals.map(([lane, work]) => `<div><a href="${liveHref(u.id, `trial:${work.trial}`)}">${esc(lane)}'s terminal</a> <span class="muted small">(${esc(work.family)})</span></div>`).join("")}</div></details>`
      : "";
    const kept = r.messages.filter((m) => m.keep && !m.unkept);
    const keptBox = kept.length
      ? `<details class="lkept"><summary class="lchip" title="Your messages kept in force">📌 ${kept.length} kept</summary><div class="menu-pop"><div class="muted small">Every new trial gets these, until you remove them.</div>${kept
          .map(
            (m) =>
              `<div class="krow"><span class="small"><b>To ${esc(m.to === "all" ? "everyone" : m.to)}:</b> ${esc(clip(m.text, 200))}</span>${cmdForm(c, { rig: u.id, kind: "unkeep_message", fields: { run: r.id, message: String(m.id) }, label: "Remove", cls: "sm ghost", back: runLiveHref(r) })}</div>`,
          )
          .join("")}</div></details>`
      : "";
    // The message box: who it goes to, and when they read it (the placeholder says).
    // When they read it depends on the agents' harness: Pi between steps; OpenCode, Claude Code
    // and Codex when their current run ends (or in the lane's next trial). A research run's
    // workers on a Codex rig run in Pi.
    const harness = u.model?.harness;
    const pi = harness === "pi" || (research && harness === "codex");
    const when =
      harness === undefined
        ? "when it can (this rig hasn't said which program runs its agents)"
        : pi
          ? "at its next step"
          : "when its current run ends, or in its next trial";
    const hint = (to: string) =>
      to === "all"
        ? `Each agent reads it ${harness === undefined ? "when it can" : pi ? "at its next step" : "when its current run ends"}; the planner at its next plan`
        : to.startsWith("lane-")
          ? `${to}${r.at_work[to] ? ` (on ${r.at_work[to]?.family})` : ""} reads it ${when}`
          : to === "planner"
            ? "The planner reads it when it plans the next round"
            : to === "teachers"
              ? "The teachers read it in their next round and answer here"
              : to === "auditor"
                ? "The auditor reads it before its next audit and answers here"
                : to === "review_panel"
                  ? "The review panel reads it before its next review and answers here"
                  : "The advisors read it and answer here";
    // A run without agents has no one working: the box starts on the advisors.
    const to =
      lanes.includes(w) || w === "planner"
        ? w
        : w === "advisors" || r.has_agents === false
          ? "advisors"
          : "all";
    // The review panel reads only for a goal it reviews (a goal checked by review) or a research
    // run's questions (goal 112).
    const reviewed = panelReviews(store, runCampaign(r));
    // Who would read nothing: off on the rig, or not set up on its supervisor. Control refuses
    // a message to them with the same words (issue.ts).
    const off = (v: string) => nobodyReads(u, v, r);
    const opt = (v: string, label: string, off = "") =>
      `<option value="${esc(v)}" data-hint="${esc(hint(v))}"${v === to ? " selected" : ""}${off ? ` disabled title="${esc(off)}"` : ""}>${esc(label)}</option>`;
    // A message control refused, or the rig refused (its newest one to this run).
    const refused = c.req.query("msgerror");
    const rigRefused = store.commands.lastMessageToRun(u.id, r.id)?.refused ?? "";
    const notice =
      refused || rigRefused
        ? `<div class="lnotice">${icon.warn}<span><b>Not sent.</b> ${esc(refused || `The rig refused your last message: ${rigRefused}`)}</span></div>`
        : "";
    const box = sel.earlier
      ? `<div class="lcomposer off">This is an earlier run (${esc(earlierWords(u.id, sel.earlier))}): its agents take no more messages.</div>`
      : r.status === "closed"
        ? `<div class="lcomposer off">This run has finished: its agents take no more messages.</div>`
        : `<form class="lcomposer" method="post" action="${esc(runMessageHref(r))}" data-act><input type="hidden" name="csrf" value="${csrf(c)}"><input type="hidden" name="w" value="${esc(w)}">
<select name="to" aria-label="To" class="lto">${opt("all", "To everyone working", off("all"))}${lanes.map((l) => opt(l, `To ${l}`, off(l))).join("")}${opt("planner", "To the planner", off("planner"))}<optgroup label="Advisors">${opt("advisors", "To all advisors", off("advisors"))}${opt("teachers", "To the teachers", off("teachers"))}${opt("auditor", "To the auditor", off("auditor"))}${opt("review_panel", "To the review panel", off("review_panel") || (!reviewed ? "This run has no goal the review panel reviews." : ""))}</optgroup></select>
<textarea name="text" rows="1" required data-words maxlength="4000" aria-label="Message" placeholder="${esc(hint(to))} · ⌘↩ sends"${c.req.query("compose") ? " autofocus" : ""}></textarea>
<label class="lpin" title="Keep it in force: every new trial gets it too, until you remove it"><input type="checkbox" name="keep" value="1">📌</label>
<button class="primary">${icon.send}Send</button></form>`;
    const meta = [
      esc(u.id),
      r.epoch ? `round ${r.epoch.n}` : "",
      research
        ? `${num((r.research as Record<string, unknown> | null)?.verified)} verified claims`
        : r.mode === "goal"
          ? `${r.goals.filter((g) => g.status === "met").length} of ${r.goals.length} goals met`
          : signed((currentChampion(r)?.cumulative ?? 1) - 1),
      waitingOn(r, u)
        ? `<a class="warn" href="${runHref(r)}#needs">${waitingOn(r, u)} wait${waitingOn(r, u) === 1 ? "s" : ""} for you</a>`
        : "",
    ]
      .filter(Boolean)
      .join(" · ");
    const st =
      sel.earlier && r.status !== "closed"
        ? { text: "Stopped", cls: "muted", icon: "" }
        : runState(r);
    const head = `<div data-part="lhead"><div class="lhead"><button class="ghost sm lnav-btn" type="button" title="Show or hide the list of runs" aria-label="Runs">☰</button>${modeAvatar(r.mode)}<span class="t">${esc(r.id)}</span><span class="label ${st.cls}">${st.icon}${esc(st.text)}</span><span class="lmeta">${meta}</span><a class="btn sm" href="${runHref(r)}">Open the run</a>${
      sel.earlier
        ? ""
        : r.status === "running"
          ? pauseMenu(c, u.id, r.id, runLiveHref(r), "sm") +
            moreMenu(c, u.id, r, runLiveHref(r), "sm")
          : r.status === "paused"
            ? cmdForm(c, {
                rig: u.id,
                kind: "resume_run",
                fields: { run: r.id },
                label: "Resume",
                cls: "sm",
                back: runLiveHref(r),
              })
            : ""
    }</div></div>`;
    return page(
      c,
      {
        title: "Live",
        summary: `${atWork.length} run${atWork.length === 1 ? "" : "s"} at work`,
        active: "live",
        flush: true,
      },
      `<div class="lwrap" id="lwrap">${nav}<section class="lcol">${head}<div data-fw-top></div><div class="lchips">${chips}<span class="grow"></span>${terminals}<span data-part="lkept">${keptBox}</span><button class="lchip on lfollow" type="button" aria-pressed="true" title="Follow new lines">↓ Follow</button></div>
<div class="transcript lstream" id="transcript" data-stream="${esc(runLiveStreamHref(r))}" data-run="${esc(r.id)}" data-w="${esc(w)}" data-after="${after}">${runLinesHtml(lines, now, runMessages(store, u.id, r.id)) || `<div class="empty">No live lines yet. They appear here as the run's agents and judge work.</div>`}</div>
<div data-part="lnotice">${notice}</div>${box}</section></div>`,
      vs,
    );
  };
  app.get("/ui/live", (c) => livePage(c));
  app.get(RUN_ROUTES.live, async (c) => {
    const x = await named(c);
    if (x) return livePage(c, x);
    c.status(404);
    return page(
      c,
      { title: "Not found", active: "live" },
      `<div class="card"><div class="empty">No such run in this campaign.</div></div>`,
    );
  });

  /**
   * One run's lines, as its Live page draws them: each tagged with its filters and its source; a
   * result also as the part it adds to its call's row.
   */
  const runFeed = (rig: string, run: string): LiveFeed => {
    const draw = (lines: ReturnType<typeof store.liveLines.ofRun>): PushedLine[] => {
      const now = Date.now();
      const messages = runMessages(store, rig, run);
      return lines.map((e) => ({
        id: e.id,
        kind: e.kind,
        src: e.source,
        html: runEntryHtml(e, now, messages),
        ...(e.kind === "result" ? { join: resultJoin(e) } : {}),
      }));
    };
    return {
      rig,
      after: (after, limit) => draw(store.liveLines.ofRun(rig, run, after, limit)),
      newest: (limit) => draw(store.liveLines.runTail(rig, run, limit)),
      count: (after) => store.liveLines.countOfRun(rig, run, after),
      // Lines drawn before their event came, drawn again once it has.
      redraw: (ids) =>
        draw(store.liveLines.ofRun(rig, run, 0, ids.length, ids))
          .map((y) => ({ id: y.id, html: y.html }))
          .filter((y) => !y.html.includes('data-recheck="1"')),
    };
  };

  // The run's new lines, pushed to its Live page.
  app.get(RUN_ROUTES.liveStream, async (c) => {
    const x = await named(c);
    if (!x) return c.json({ error: "no such run in this campaign" }, 404);
    const feed = runFeed(x.rig.id, x.run.id);
    const after = pushStart(c.req.header("last-event-id"), c.req.query("after"));
    const recheck = recheckIds(c.req.query("recheck"));
    return streamSSE(c, (stream) => pushLive(stream, store, feed, { after, recheck }));
  });

  // The owner's message to a run's agents, from its Live and its Planner tab: a signed command
  // to the rig the run is on.
  app.post(RUN_ROUTES.message, async (c) => {
    const f = await c.req.parseBody();
    const x = await named(c);
    if (!x) return c.text("No such run in this campaign.", 404);
    const w = String(f.w ?? "");
    // From the Planner tab, back there; from Live, to the same filter.
    const from = String(f.back ?? "");
    const live = runLiveHref(x.run, { w });
    const back = (more = "") =>
      c.redirect(
        from.startsWith("/ui/")
          ? `${from}${from.includes("?") ? "&" : "?"}${more || `sent=${encodeURIComponent("Sent to the rig. The planner reads it when it next gives out work; Commands shows whether the rig took it.")}`}`
          : `${live}${more ? `${live.includes("?") ? "&" : "?"}${more}` : ""}`,
        303,
      );
    const to = String(f.to ?? "all");
    const keep = String(f.keep ?? "") === "1" && (to === "all" || to.startsWith("lane-"));
    // From the page's script (goal 080): JSON, and the message is followed until the rig took it.
    const json = wantsJson(c);
    let id: string;
    try {
      ({ id } = issueCommand(store, opts.privateKeyPem, {
        rig: x.rig.id,
        kind: "message_agent",
        payload: {
          run: x.run.id,
          to,
          text: String(f.text ?? "").trim(),
          ...(keep ? { keep: true } : {}),
        },
        issuedBy: "owner:ui",
      }));
    } catch (err) {
      const why = errorText(err);
      return json ? c.json(notSent(why), 400) : back(`msgerror=${encodeURIComponent(why)}`);
    }
    const cmd = json ? store.commands.row(id) : undefined;
    if (cmd) return c.json({ ...commandProgress(cmd, Date.now()), follow: commandFollowUrl(id) });
    return back();
  });

  // ---------------------------------------------------------------- one rig's sessions, every run
  const sourceName = (s: string, lane?: string | null) =>
    s === "planner"
      ? "Planner"
      : s === "judge"
        ? "Judge"
        : s === "supervisor"
          ? "Supervisor"
          : `Worker${lane ? ` · ${lane}` : ""}`;
  const sourceAvatar = (s: string) =>
    s === "planner"
      ? `<span class="av c5">PL</span>`
      : s === "judge"
        ? `<span class="av c4">JG</span>`
        : s === "supervisor"
          ? `<span class="av c3">SV</span>`
          : `<span class="av c1">WK</span>`;

  app.get("/ui/rigs/:rig/live", (c) => {
    const vs = views();
    const now = Date.now();
    const u = vs.find((x) => x.id === c.req.param("rig"));
    if (!u)
      return page(
        c,
        { title: "Not found", active: "live" },
        `<div class="card"><div class="empty">No such rig.</div></div>`,
        vs,
      );
    const sources = store.liveLines.sources(u.id);
    const intros = new Map(
      store.liveLines
        .trials(u.id)
        .map((x) => [x.source, x.intro.replace(/^(research )?trial on [^:]+: /, "")]),
    );
    const source = c.req.query("source") || "";
    const sel = sources.find((x) => x.source === source);
    const lines = store.liveLines.tail(u.id, 400, source || undefined);
    const after = lines.at(-1)?.id ?? 0;
    // A trial works while the ledger has it at work; its "trial ended" line may never come (a
    // restart cuts it off, and the harness closes it as interrupted when it starts again).
    const atWork = new Set(
      u.runs.flatMap((r) => Object.values(r.at_work).map((w) => `trial:${w.trial}`)),
    );
    const ended = new Map(sources.map((x) => [x.source, x.ended || !atWork.has(x.source)]));
    const list = [
      `<a class="side-row${source ? "" : " on"}" href="${liveHref(u.id)}">${icon.live}<span class="two"><span class="name"><b>Everything</b></span><span class="muted xs">all sessions, interleaved</span></span></a>`,
      ...sources.map(
        (s) =>
          `<a class="side-row${s.source === source ? " on" : ""}" href="${liveHref(u.id, s.source)}">${sourceAvatar(s.source)}<span class="two"><span class="name"><b>${esc(sourceName(s.source, s.lane))}</b></span><span class="muted xs clip">${esc([intros.get(s.source) || (s.source.startsWith("trial:") ? s.source.slice(6) : (s.run ?? "")), `${ago(s.last_at, now)} ago`].filter(Boolean).join(" · "))}</span></span>${s.source.startsWith("trial:") ? `<span class="right">${ended.get(s.source) ? `<span class="muted xs">ended</span>` : `<span class="label info xs"><span class="dot info pulse"></span>working</span>`}</span>` : ""}</a>`,
      ),
    ].join("");
    // Lines with their times, formatted once (ui/live.ts); the script adds new ones the same way.
    const out = [liveLinesHtml(lines, { showWho: !source, name: sourceName, now })];
    // Who is at work: for one worker, its agent, task, start and last activity.
    const agent = u.model
      ? u.model.source === "control"
        ? `${HARNESS_NAMES[u.model.harness] ?? u.model.harness} · ${u.model.model} (from ${u.model.name})`
        : u.model.source === "environment"
          ? `${HARNESS_NAMES[u.model.harness] ?? u.model.harness} · ${u.model.model} (the rig's own settings)`
          : "no model: the agents wait"
      : "not reported by this rig's harness";
    const trial = source.startsWith("trial:")
      ? store.liveLines.trials(u.id).find((x) => x.source === source)
      : undefined;
    const whenAt = (at: string) =>
      `${esc(at.slice(11, 19))} UTC <span class="muted">(${esc(ago(at, now))} ago)</span>`;
    const head = trial
      ? `<div class="lv-head"><dl class="facts"><dt>Agent</dt><dd>${esc(agent)}</dd><dt>Task</dt><dd>${esc(intros.get(source) || "not given")}</dd><dt>Started</dt><dd>${whenAt(trial.started_at)}</dd><dt>Last activity</dt><dd>${whenAt(trial.last_at)} ${trial.ended ? `<span class="chip">ended</span>` : `<span class="chip info">working</span>`}</dd></dl></div>`
      : !source
        ? `<div class="lv-head"><dl class="facts"><dt>Agents</dt><dd>${esc(agent)}</dd><dt>Last activity</dt><dd>${sources[0] ? whenAt(sources[0].last_at) : "none yet"}</dd></dl></div>`
        : "";
    // Messages go from a run's own Live page, where each recipient says when it reads them.
    const composer = u.runs.filter((x) => x.status !== "closed").length
      ? `<div class="composer off">To message an agent, open its run's Live: ${u.runs
          .filter((x) => x.status !== "closed")
          .map((x) => `<a href="${runLiveHref(x)}">${esc(x.id)}</a>`)
          .join(", ")}.</div>`
      : `<div class="composer off">No run on this rig to message.</div>`;
    // A trial's page has its terminal, and the owner's console into it (goal 169).
    const term =
      trial?.run && u.model?.harness !== "pi"
        ? terminalPanel(dash, c, {
            rig: u.id,
            run: trial.run,
            trial: source.slice(6),
            ended: Boolean(ended.get(source)),
          })
        : "";
    const title = source ? sourceName(source, sel?.lane) : "Everything";
    return page(
      c,
      {
        title,
        crumbs: [
          { href: "/ui/live", text: "Live" },
          { href: rigHref(u.id), text: u.id },
        ],
        summary: source.startsWith("trial:")
          ? (() => {
              // Where this session sits: Campaign › Run › Lane › Trial.
              const run = sel?.run ? u.runs.find((i) => i.id === sel.run) : undefined;
              return [
                run
                  ? `<a href="${runHref(run)}">${esc(runCampaign(run))} › ${esc(run.id)}</a>`
                  : esc(sel?.run ?? ""),
                esc(sel?.lane ?? ""),
                esc(source.slice(6)),
              ]
                .filter(Boolean)
                .join(" › ");
            })()
          : source === "supervisor"
            ? "relayed by the supervisor, unsigned"
            : `${sources.length} sessions`,
        active: "live",
        flush: true,
      },
      `<aside class="sessions"><div class="section" style="margin-top:4px">Sessions</div>${list}</aside>
<div class="transcript-wrap">${head}${term}<div class="transcript" id="transcript" data-stream="${esc(rigLiveStreamHref(u.id))}" data-source="${esc(source)}" data-after="${after}">${out.join("") || `<div class="empty">No live lines yet. They appear here as the rig's agents and judge work.</div>`}</div>${composer}</div>`,
      vs,
    );
  });

  // The rig's new lines, or one source's, pushed to its Live page: each line as the page shows
  // it; a result also as the part it adds to its call's row.
  app.get("/ui/rigs/:rig/live/stream", (c) => {
    const rig = c.req.param("rig");
    if (!views().some((u) => u.id === rig)) return c.json({ error: "no such rig" }, 404);
    const source = c.req.query("source") || undefined;
    const draw = (lines: ReturnType<typeof store.liveLines.after>): PushedLine[] => {
      const now = Date.now();
      return lines.map((e) => ({
        id: e.id,
        kind: e.kind,
        html: liveEntryHtml(e, { showWho: !source, name: sourceName, now }),
        ...(e.kind === "result" ? { join: resultJoin(e) } : {}),
      }));
    };
    const feed: LiveFeed = {
      rig,
      after: (after, limit) => draw(store.liveLines.after(rig, after, limit, source)),
      newest: (limit) => draw(store.liveLines.tail(rig, limit, source)),
      count: (after) => store.liveLines.count(rig, after, source),
    };
    const after = pushStart(c.req.header("last-event-id"), c.req.query("after"));
    return streamSSE(c, (stream) => pushLive(stream, store, feed, { after, recheck: [] }));
  });
}
