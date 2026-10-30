import { RESEARCH_REVIEW } from "../../../../core/research-check.ts";
import { sumUsage } from "../../../../core/usage.ts";
import type { PromptItem } from "../../../prompts.ts";
import { howCheckedDetails } from "../../../ui/campaigns/goal-checks.ts";
import { experimentsTab, plannerTab } from "../../../ui/campaigns/queue/index.ts";
import {
  hypothesesTab,
  type ReviewSources,
  researchBlock,
  reviewsTab,
} from "../../../ui/campaigns/research.ts";
import {
  ago,
  championCard,
  deltaCell,
  esc,
  fmtInt,
  gainChart,
  gainChip,
  kpi,
  moreText,
  num,
  stackBar,
  startWords,
} from "../../../ui/components/index.ts";
import { journalTab } from "../../../ui/knowledge/index.ts";
import {
  attemptRows,
  baselineBlock,
  baselineWords,
  championHeldOutBlock,
  confirmingWords,
  goalState,
  leftByClose,
  runBrief,
  timeline,
  waitWords,
} from "../../../ui/operator/index.ts";
import { promptsTab } from "../../../ui/prompts.ts";
import { attemptHref, championPatchHref, type RunTab, runHref } from "../../../ui/urls.ts";
import { type RunUsage, runStatsTab, runUsageTop } from "../../../ui/usage.ts";
import { auditReason, clip, jobText, runStatusText, signed } from "../../../ui/words/index.ts";
import { pricingOf, usageData } from "../../../usage.ts";
import {
  championsInForce,
  currentChampion,
  type RigView,
  type RunOnRig,
  type RunView,
  runCampaign,
} from "../../../views/index.ts";
import type { Ctx, Dashboard } from "../../context.ts";
import { campaignHelpers } from "../shared.ts";

export type RunViewName = RunTab;

/**
 * One run on its campaign's page, one view at a time (runSection), and what a research run's
 * Reviews tab reads beyond the run's events (reviewSources, which the campaign's own tab reads too).
 */
export function runHelpers(dash: Dashboard) {
  const { cmdForm, csrf, needs, store } = dash;
  const { goalChecksFor } = campaignHelpers(dash);

  /**
   * A run's model use and cost (goal 075), for the top of its page above the tabs and its Stats
   * tab: control's sums of its records on this rig, its rounds for the bars, its time, and a
   * RunPod rig's price an hour. The teachers' lines say "teacher 1" or "teacher 2" where the
   * rig's settings tell which. None: a run with no agents (a try of a kit) and nothing spent.
   */
  const runUsage = (u: RigView, i: RunView, now: number): RunUsage | undefined => {
    const d = usageData(store, { run: i.id });
    if (!i.has_agents && !d.report.total.records && d.report.total.cost.pod_usd === null)
      return undefined;
    const roles = store.agentModels.byRole(u.id);
    const launched = store.runpod.rig(u.id);
    const perHour = (launched?.state as { price_per_hr?: unknown } | null)?.price_per_hr;
    // The run's time: from its start to now, or to its last event once it is finished.
    const start = Date.parse(i.created_at ?? "");
    const end = i.status === "closed" ? Date.parse(i.timeline.at(-1)?.at ?? "") : now;
    return {
      report: d.report,
      rows: d.rows,
      roundStarts: i.round_starts,
      trials: i.agents.trials,
      rounds: i.agents.epochs,
      wallMs: Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : null,
      rig: u.id,
      champion: championCard(i),
      pod: launched
        ? { perHour: typeof perHour === "number" && perHour > 0 ? perHour : null }
        : undefined,
      teacher: (provider, model) => {
        const is = (r: { provider: string; model: string } | undefined) =>
          r !== undefined && r.provider === provider && r.model === model;
        const one = is(roles.teachers);
        const two = is(roles.second_teacher);
        return one && !two ? "teacher 1" : two && !one ? "teacher 2" : "";
      },
    };
  };

  /**
   * What a research run's Reviews tab reads beyond the run's events (goal 116): each review's
   * model use, from the review panel's records (round "review N"), priced as Metrics prices them,
   * and the supervisor's lines for it in the run's Live view.
   */
  const reviewSources = (u: RigView, i: RunView): ReviewSources => {
    const rows = store.usage.reviewRows(u.id, i.id);
    const price = pricingOf(store);
    const lines = store.liveLines.reviewLines(u.id, i.id);
    return {
      usage: (n) => {
        const rs = rows.get(n);
        if (!rs?.length) return undefined;
        const s = sumUsage(
          rs.map((r) => ({ ...r, pricing: price(r.provider, r.model, r.harness) })),
        );
        return {
          calls: s.calls,
          tokens_in: s.tokens_in,
          tokens_out: s.tokens_out,
          call_ms: s.call_ms,
          usd: s.cost.usd,
        };
      },
      lines: (n) => lines.filter((l) => l.review === n),
    };
  };

  /**
   * One run's page, one view at a time: its overview (what waits for the owner, what it is doing
   * now, goals, what happened, latest attempts), all its attempts, its history in words, or its
   * steering. Command forms return to the same view. An earlier run (goal 170) takes no commands:
   * nothing of it waits for the owner, and its champion goes to no other rig. Its prompts, for
   * the Prompts view, are read from the message bus before (runPrompts).
   */
  const runSection = (
    c: Ctx,
    x: RunOnRig,
    vs: RigView[],
    now: number,
    view: RunViewName,
    prompts: PromptItem[],
  ) => {
    const { rig: u, run: i, earlier } = x;
    const t = csrf(c);
    const back = runHref(i, view);
    const others = earlier ? [] : vs.filter((o) => o.id !== u.id);
    // A research run's page has its Reviews and Hypotheses tabs (goals 116 and 117).
    const researchRun = i.mode === "research";
    const usage = runUsage(u, i, now);
    const decisions = earlier ? [] : needs(c, [u], now, back).filter((n) => n.run === i.id);
    // How each goal is really checked (goal 082): as this run's rig reported its kit, else as
    // control can read the campaign's kit or contract.
    const how = i.mode === "goal" ? goalChecksFor(runCampaign(i), vs, u.id, i) : undefined;
    const howFor = (goal: string) =>
      howCheckedDetails(
        how?.checks.goals.find((x) => x.goal === goal),
        how?.checks,
        how?.source,
      );
    const goals = i.goals.length
      ? `<div class="block"><div class="head"><h2>Goals</h2><span class="n">${i.goals.filter((g) => g.status === "met").length} of ${i.goals.length} met</span><span class="right">the judge's check of champion #${esc(i.goals_seq ?? "?")}${i.goals_at ? `, ${esc(ago(i.goals_at, now))} ago` : ""}</span></div><div class="card flat">${i.goals
          .map((g) => {
            const st = goalState(g);
            return `<div class="gl"><span class="gl-mark ${st.tone}">${st.mark}</span><span class="gl-main"><span><b>${esc(g.goal)}</b>${g.status === "met" ? "" : ` <span class="chip ${st.tone === "off" ? "" : st.tone}">${esc(st.word)}</span>`}</span>${g.description ? `<div class="muted">${moreText(g.description, 200)}</div>` : ""}<div class="gl-why ${st.tone}">${moreText(g.reasons, 400)}</div>${howFor(g.goal)}</span></div>`;
          })
          .join("")}</div></div>`
      : i.mode === "goal"
        ? `<div class="block"><div class="head"><h2>Goals</h2></div><div class="card${how?.checks.goals.length ? " flat" : ""}"><div class="empty">The judge has not checked the goals yet.</div>${(
            how?.checks.goals ?? []
          )
            .map(
              (g) =>
                `<div class="gl"><span class="gl-mark off">·</span><span class="gl-main"><span><b>${esc(g.goal)}</b></span>${g.description ? `<div class="muted">${moreText(g.description, 200)}</div>` : ""}${howFor(g.goal)}</span></div>`,
            )
            .join("")}</div></div>`
        : "";
    // A research run (goals 112, 116 and 117): each question with its answer card, its standing
    // decision, its gaps, its share of the work and whether it is saturated; the answer check and
    // the progress rule; the paper and the latest report.
    const research = i.mode === "research" || i.research ? researchBlock(u, i, now) : "";
    // The changes that waited when the run closed (goal 087): they left Needs you.
    const left = leftByClose(i, u).length;
    const leftWords = left
      ? ` When it closed, ${left} change${left === 1 ? "" : "s"} waited for a decision. ${left === 1 ? "It does" : "They do"} not become the champion, and nothing in this run waits for you.`
      : "";
    const now_ =
      i.status === "running"
        ? runBrief(store, u, i, now, { detail: true })
        : `<div class="card"><div class="small">This run is <b>${esc(runStatusText(i))}</b>. ${i.status === "paused" ? `Nothing new starts until it is resumed.` : `It is finished.${leftWords}`}</div></div>`;
    const recent = timeline(
      i.timeline.map((e) => ({ u, e })),
      now,
      { limit: 10 },
    );
    const newest = [...i.attempts].reverse();
    // Lane ▸ attempts: what each lane has tried and how the judge decided it.
    const lanes = [
      ...new Set(i.attempts.map((a) => a.lane).filter((l): l is string => !!l)),
    ].sort();
    const winKind = i.mode === "goal" ? "goal_progress" : "win_confirmed";
    const laneCard = lanes.length
      ? `<div class="card flat" style="margin-bottom:12px"><table><thead><tr><th>Lane</th><th class="num">Attempts</th><th class="num">${i.mode === "goal" ? "Goal progress" : "Confirmed wins"}</th><th class="num">Best change</th><th>Latest idea</th></tr></thead><tbody>${lanes
          .map((l) => {
            const xs = i.attempts.filter((a) => a.lane === l);
            const deltas = xs.map((a) => a.delta).filter((d): d is number => d !== null);
            return `<tr><td><span class="chip">${esc(l)}</span></td><td class="num">${xs.length}</td><td class="num">${xs.filter((a) => a.verdict === winKind).length}</td><td class="num">${deltas.length ? deltaCell(Math.max(...deltas)) : ""}</td><td class="clip">${esc(xs.at(-1)?.hypothesis ?? "")}</td></tr>`;
          })
          .join("")}</tbody></table></div>`
      : "";
    const sub = (v: RunViewName, label: string, extra = "") =>
      `<a class="${view === v ? "on" : ""}" href="${runHref(i, v)}">${label}${extra}</a>`;
    // Steering: each control says what it does.
    const ctl = (button: string, does: string) =>
      `<div class="choice"><div class="btns">${button}</div><div class="does">${does}</div></div>`;
    const propagate =
      i.published && others.length
        ? ctl(
            `<form class="inline" method="post" action="/ui/propagate"><input type="hidden" name="csrf" value="${t}"><input type="hidden" name="run" value="${esc(i.id)}"><select name="to_run">${others
              .flatMap((o) =>
                o.runs
                  .filter((x) => x.campaign === i.campaign)
                  .map((x) => `<option value="${esc(x.id)}">${esc(x.id)} on ${esc(o.id)}</option>`),
              )
              .join("")}</select><button>Send champion #${i.published.seq}</button></form>`,
            `Another rig's run of this campaign imports this run's champion, and its own judge tests it there. If it holds up, it counts as cross-verified.`,
          )
        : "";
    const audits = i.audits.slice(-8).reverse();
    const records = [
      audits.length
        ? `<div class="block"><div class="head"><h2>Audits</h2></div><div class="card flat"><table><thead><tr><th>Attempt</th><th>Why it was audited</th><th>Outcome</th></tr></thead><tbody>${audits
            .map(
              (x) =>
                `<tr><td><a href="${attemptHref(i, x.attempt)}"><code>${esc(x.attempt)}</code></a></td><td>${esc(auditReason(x.reason))}</td><td class="${x.decision === "block" ? "bad" : x.decision ? "ok" : "warn"}">${esc(x.decision === null ? (u.supervisor && (u.supervisor as { advisors?: unknown }).advisors ? "waiting for the auditor" : "waiting for you (no auditor configured)") : x.decision === "block" ? "blocked by the auditor" : x.decision === "clear" ? "cleared by the auditor" : x.decision === "needs_owner" ? "passed to you" : x.decision)}${x.reasons ? `<div class="muted xs">${esc(clip(x.reasons, 200))}</div>` : ""}</td></tr>`,
            )
            .join("")}</tbody></table></div></div>`
        : "",
      // A research run's reviews (goal 112) are not goals': its Overview's Answer check says
      // where they stand.
      i.reviews.some((r) => r.goal !== RESEARCH_REVIEW)
        ? `<div class="block"><div class="head"><h2>Reviews of subjective goals</h2></div><div class="card flat"><table><thead><tr><th>Goal</th><th>Commit</th><th>Review panel</th><th>You</th></tr></thead><tbody>${i.reviews
            .filter((r) => r.goal !== RESEARCH_REVIEW)
            .slice(-8)
            .reverse()
            .map(
              (r) =>
                `<tr><td>${esc(r.goal)}</td><td><code>${esc(r.commit.slice(0, 8))}</code></td><td>${esc((r.panel ?? "waiting").replace(/_/g, " "))}</td><td>${esc(r.owner ?? "")}</td></tr>`,
            )
            .join("")}</tbody></table></div></div>`
        : "",
      i.propagations.length
        ? `<div class="block"><div class="head"><h2>Champions from other rigs</h2></div><div class="card flat"><table><thead><tr><th>From</th><th>Attempt here</th><th>Result here</th></tr></thead><tbody>${i.propagations
            .slice(-8)
            .reverse()
            .map(
              (p) =>
                `<tr><td>${esc(p.source_rig)} / ${esc(p.source_run)} champion #${p.source_seq}</td><td>${p.attempt ? `<a href="${attemptHref(i, p.attempt)}"><code>${esc(p.attempt)}</code></a>` : ""}</td><td class="${p.result === "accepted" ? "ok" : p.result.startsWith("rejected") ? "bad" : "muted"}">${esc(p.result)}</td></tr>`,
            )
            .join("")}</tbody></table></div></div>`
        : "",
    ]
      .filter(Boolean)
      .join("");
    const a = i.agents;
    const diagnostics = `<div class="block"><div class="head"><h2>Agent figures</h2><span class="right">for diagnosing the agents, not the research</span></div><div class="kpis">${[
      i.mode === "research"
        ? kpi(
            "Rounds",
            String(a.epochs),
            a.epochs
              ? `${a.planner_valid} by the model · ${a.fallbacks} by the gap-driven plan`
              : "",
          )
        : kpi(
            "Plans",
            String(a.epochs),
            a.epochs
              ? `${Math.round((100 * a.planner_valid) / a.epochs)}% by the model · ${a.fallbacks} fallbacks`
              : "",
          ),
      kpi("Trials", String(a.trials), `${a.submitted} submitted`),
      kpi("Tokens", fmtInt(a.tokens_in + a.tokens_out), `${fmtInt(a.tokens_out)} out`),
      kpi("Duplicates", String(a.duplicates), "the same change again"),
      ...(i.mode === "hill_climb"
        ? [
            kpi(
              "Rig noise",
              i.calibration ? `±${(i.calibration.sigma * 100).toFixed(2)}%` : "·",
              "per block (A/A)",
            ),
          ]
        : []),
    ].join("")}</div></div>`;
    const waiting = decisions.length;
    const champ = currentChampion(i);
    const met = i.goals.filter((g) => g.status === "met").length;
    const lanesAtWork = Object.keys(i.at_work).length;
    const judging =
      u.judge.now && (u.judge.now.run === i.id || u.judge.now.run === null) ? u.judge.now : null;
    // The run in one or two sentences: where it stands, who is at work, what waits for you.
    const said = [
      i.mode === "goal"
        ? i.goals.length
          ? `${met} of ${i.goals.length} goals met by champion #${champ?.seq ?? 1}.`
          : "The judge has not checked the goals yet."
        : i.mode === "hill_climb"
          ? `Champion #${champ?.seq ?? 1} is ${esc(signed((champ?.cumulative ?? 1) - 1))} against where the run started.`
          : `${num((i.research as Record<string, unknown> | null)?.verified)} verified claims so far.`,
      i.status === "running"
        ? lanesAtWork
          ? `${lanesAtWork} lane${lanesAtWork === 1 ? " is" : "s are"} at work.`
          : "No lane is at work."
        : `It is ${esc(runStatusText(i))}.`,
      i.status === "running" ? confirmingWords(i) : "",
      // A wait for the provider's limit: Resume now in the header ends it.
      esc(waitWords(i, now)),
      // A hill climb's baseline (goal 115): the judge measures the starting point first.
      i.status === "running" ? esc(baselineWords(i)) : "",
      judging
        ? `The judge is ${esc(jobText(judging).replace(/^[A-Z]/, (x) => x.toLowerCase()))}.`
        : "",
      waiting
        ? `<b class="warn">${waiting} decision${waiting === 1 ? " waits" : "s wait"} for you.</b>`
        : "",
    ]
      .filter(Boolean)
      .join(" ");
    // A project in a folder: the patch's paths start at that folder of the repository's commit.
    const appliesTo = i.seed_folder
      ? `applies to the folder ${esc(i.seed_folder.folder)} at ${esc(i.seed_folder.commit.slice(0, 8))}: git apply --directory=${esc(i.seed_folder.folder)}`
      : `applies to ${esc(i.published?.base_commit.slice(0, 8) ?? "")}`;
    const patch =
      i.published && store.championPatches.get(u.id, u.ledger_id, i.id, i.published.seq)
        ? `<a href="${championPatchHref(i, i.published.seq)}">download champion #${i.published.seq} as a patch</a> <span class="muted small">(${appliesTo})</span>`
        : "";
    // The champions, newest first: what each one changed and what it gained.
    const ladder =
      i.mode === "hill_climb"
        ? `<div class="block"><div class="head"><h2>Champions</h2><span class="n">${championsInForce(i).length}</span><span class="right">gain over the starting point, measured on this rig</span></div><div class="card flat"><div class="ladder-chart">${gainChart(i)}</div>${i.champion
            .filter((x) => !x.reopened)
            .slice()
            .reverse()
            .slice(0, 12)
            .map((x) => {
              const a = x.attempt ? i.attempts.find((y) => y.id === x.attempt) : undefined;
              return `<div class="lad"><span class="lad-n">#${x.seq}</span><span class="lad-main">${x.attempt ? `<a href="${attemptHref(i, x.attempt)}">${esc(clip(a?.hypothesis ?? x.attempt, 140))}</a>` : `<span class="muted">the starting point</span>`}</span><span>${x.attempt ? gainChip(i, { delta: x.delta, values: a?.values }, "ok") : esc(startWords(i))}</span><b class="fig">${esc(signed(x.cumulative - 1))}</b><span class="lad-age">${esc(ago(x.at, now))}</span></div>`;
            })
            .join("")}</div></div>`
        : "";
    // Hands-off by default (goal 079): what the run asks you about, if anything.
    const asks = [
      typeof i.ask_owner.above_gain === "number"
        ? `a gain above ${(i.ask_owner.above_gain * 100).toFixed(1).replace(/\.0$/, "")}%`
        : "",
      i.ask_owner.declared_flaws ? "a change with declared flaws" : "",
      i.ask_owner.reviews ? "a review panel's pass" : "",
      i.ask_owner.not_possible ? 'a "not possible" ending' : "",
    ].filter(Boolean);
    const policyWord = `${
      i.promotion === "owner_approval"
        ? "Only with your approval"
        : i.promotion === "auto"
          ? "Automatic when the judge confirms, after the auditor's clear when an audit is called for"
          : "The rig's default (automatic unless it was set to ask you)"
    }${asks.length && i.promotion !== "owner_approval" ? `. It asks you about ${asks.join(", ")}` : ""}`;
    const settings = [
      [
        "Champion",
        `#${champ?.seq ?? 1}${champ?.attempt ? "" : " (the starting point)"}, since ${esc(ago(champ?.at, now))} ago${patch ? `<div>${patch}</div>` : ""}`,
      ],
      ["Promotion", esc(policyWord)],
      [
        "Mode",
        esc(
          i.mode === "goal"
            ? "Goal: work until every goal is met"
            : i.mode === "hill_climb"
              ? "Hill climb: keep improving the metric"
              : "Research: build a sourced corpus",
        ),
      ],
      [
        "Agents",
        i.agents.trials || i.epoch || lanesAtWork
          ? `${i.epoch?.assignments.length ?? lanesAtWork} lane${(i.epoch?.assignments.length ?? lanesAtWork) === 1 ? "" : "s"} · ${i.agents.trials} trial${i.agents.trials === 1 ? "" : "s"} done · ${i.agents.submitted} submitted`
          : i.has_agents
            ? "On: they start work at the first round"
            : "None: judge only. No workers run; changes come from people",
      ],
      [
        "Started",
        `${i.created_at ? `${esc(ago(i.created_at, now))} ago` : "?"}${i.seed_repo ? ` from ${esc(i.seed_repo)}` : ""}`,
      ],
    ]
      .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`)
      .join("");
    const body =
      view === "attempts"
        ? `${i.attempts.length ? `<div class="card" style="margin-bottom:12px"><div class="card-head"><span class="title">How the judge decided</span><span class="right muted small">${i.attempts.length} attempts</span></div><div style="margin-top:10px">${stackBar(i.verdicts)}</div></div>` : ""}${laneCard}${attemptRows(u, i, newest.slice(0, 300), now)}${i.attempts.length > 300 ? `<div class="muted small" style="margin-top:8px">The newest 300 of ${i.attempts.length}.</div>` : ""}${records}`
        : view === "prompts"
          ? promptsTab(i, prompts, now)
          : view === "history"
            ? timeline(
                i.timeline.map((e) => ({ u, e })),
                now,
                { limit: 400 },
              )
            : view === "planner"
              ? plannerTab({
                  u,
                  r: i,
                  now,
                  csrf: t,
                  back,
                  cmd: (f) => cmdForm(c, f),
                  model: (() => {
                    const own = store.agentModels.byRole(u.id).planner;
                    if (own) return `${own.model}, its own model (from ${own.provider})`;
                    return u.model
                      ? u.model.source === "none"
                        ? "No model: the lanes take the queue in order and keep to the rules."
                        : `${u.model.model}, the agents' model (Edit rig can give the planner its own)`
                      : "Not reported by this rig's harness.";
                  })(),
                  figures: diagnostics,
                  propagate,
                  // No model for the planner: an old rule in words waits to be converted (goal 066).
                  noModel: !store.agentModels.byRole(u.id).planner && u.model?.source === "none",
                  // A message to the planner that control or the rig refused.
                  refused:
                    c.req.query("msgerror") ||
                    (() => {
                      const why = store.commands.lastMessageToRun(u.id, i.id, "planner")?.refused;
                      return why ? `The rig refused your last message to the planner: ${why}` : "";
                    })(),
                })
              : view === "journal"
                ? journalTab({
                    r: i,
                    now,
                    counts: u.ledger_id ? store.kb().runCounts(u.id, u.ledger_id, i.id) : {},
                    reads: i.campaign ? store.kb().reads(i.campaign) : [],
                  })
                : view === "experiments"
                  ? experimentsTab({
                      u,
                      r: i,
                      now,
                      csrf: t,
                      back,
                      cmd: (f) => cmdForm(c, f),
                      families: [
                        ...new Set([
                          ...i.queue.map((x) => x.family),
                          ...i.trials.map((x) => x.family ?? ""),
                          ...(i.epoch?.assignments.map((a) => a.family) ?? []),
                        ]),
                      ].filter(Boolean),
                    })
                  : view === "reviews" && researchRun
                    ? reviewsTab({ u, r: i, now, ...reviewSources(u, i) })
                    : view === "hypotheses" && researchRun
                      ? hypothesesTab({ u, r: i, now, cmd: (f) => cmdForm(c, f), back })
                      : view === "stats"
                        ? usage
                          ? runStatsTab(usage)
                          : `<div class="card"><div class="empty">No model use: this run has no agents.</div></div>`
                        : `<p class="run-said" data-part="run-said">${said}</p>
<div data-part="run-needs">${waiting ? `<div class="block" id="needs"><div class="head"><h2>Needs you</h2><span class="n">${waiting}</span></div><div class="dqs">${decisions.map((n) => n.html).join("")}</div></div>` : ""}</div>
<div class="cols run-cols"><div>
${goals}${championHeldOutBlock(i, now)}${research}${baselineBlock(i, now)}${ladder}
<div class="block" data-part="attempts"><div class="head"><h2>Attempts</h2><span class="n">${i.attempts.length}</span><span class="right"><a href="${runHref(i, "attempts")}">All ${i.attempts.length}</a></span></div>${attemptRows(u, i, newest.slice(0, 8), now)}</div>
</div><div class="side">
<div class="block" data-part="now"><div class="head"><h2>Now</h2></div>${now_}</div>
<div class="block" data-part="facts"><div class="head"><h2>The run</h2></div><div class="card"><dl class="facts">${settings}</dl></div></div>
<div class="block" data-part="recent"><div class="head"><h2>Recent</h2><span class="right"><a href="${runHref(i, "history")}">Full history</a></span></div>${recent}</div>
</div></div>`;
    return `${usage ? runUsageTop(usage) : ""}<section class="block" id="run-${esc(i.id)}">
<nav class="tabs">${sub("overview", "Overview", waiting ? ` <span class="dot warn"></span>` : "")}${sub("experiments", researchRun ? "Tasks" : "Experiments", ` <span class="muted">${i.queue.filter((x) => x.state === "queued").length} up next</span>`)}${sub("journal", "Journal", ` <span class="muted">${((n) => `${n} note${n === 1 ? "" : "s"}`)(i.journal.filter((n) => n.id > 0).length)}</span>`)}${researchRun ? `${sub("reviews", "Reviews", ` <span class="muted">${i.reviews.filter((r) => r.goal === RESEARCH_REVIEW).length}</span>`)}${sub("hypotheses", "Hypotheses", ` <span class="muted">${i.hypotheses.length}</span>`)}` : ""}${sub("attempts", "Attempts", ` <span class="muted">${i.attempts.length}</span>`)}${sub("history", "History")}${sub("planner", "Planner")}${i.has_agents ? sub("prompts", "Prompts") : ""}${usage ? sub("stats", "Stats") : ""}</nav>
${body}
</section>`;
  };
  return { reviewSources, runSection };
}
