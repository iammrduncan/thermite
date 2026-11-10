import type {
  EventRow,
  HomeAnswer,
  NavCampaign,
  NeedRow,
  NowLine,
  RunRow,
  StateWord,
  Tone,
} from "../../../core/api/control/dashboard.ts";
import type { ControlStore } from "../../store/index.ts";
import { campaignState, modeName, runState } from "../../ui/components/index.ts";
import { goalState, type Need, runFigure } from "../../ui/operator/index.ts";
import { attemptHref, runHref } from "../../ui/urls.ts";
import { clip, jobText, runOfAttempt, sentence } from "../../ui/words/index.ts";
import {
  campaignViews,
  currentChampion,
  newestRun,
  podStopped,
  type RigView,
  type RunView,
  runCampaign,
  type StoredEvent,
} from "../../views/index.ts";

/**
 * Home's answer for the dashboard's app (goal 243): what needs the owner, what is at work and what
 * happened, each in the words the pages at /ui use, as data. It stands on the pages' own word and
 * card helpers, so it is page code until they leave it (goals 244 and 246); its shape is the
 * contract's (core/api/control/dashboard.ts).
 */

/** The pages' class of a state as one of the app's four colours. */
const toneOf = (cls: string): Tone =>
  cls === "ok"
    ? "good"
    : cls === "warn" || cls === "violet"
      ? "needs"
      : cls === "bad"
        ? "wrong"
        : cls === "info"
          ? "working"
          : "none";

const stateOf = (s: { text: string; cls: string }): StateWord => ({
  word: s.text,
  tone: toneOf(s.cls),
});

/** A need as one row of words. Its page is the pages' own, until the app has it (goal 246). */
export function needRow(vs: RigView[], n: Need, i: number): NeedRow {
  const u = vs.find((x) => x.id === n.rig);
  const r = n.run ? u?.runs.find((x) => x.id === n.run) : undefined;
  const row = n.row;
  return {
    key: `${n.kind}:${n.rig}:${n.run ?? ""}:${n.attempt ?? ""}:${i}`,
    kind: n.kind,
    tone: row ? toneOf(row.tone) : "needs",
    label: row?.label ?? n.kind.replace(/_/g, " "),
    headline: row?.headline ?? "",
    why: row?.why ?? "",
    where: {
      campaign: r ? runCampaign(r) : null,
      run: n.run ?? null,
      rig: n.rig || null,
      lane: row?.lane ?? null,
      attempt: n.attempt ?? null,
    },
    since: row?.since ?? n.at ?? null,
    page:
      r && n.attempt
        ? attemptHref(r, n.attempt)
        : r
          ? runHref(r)
          : n.rig
            ? `/ui/rigs/${encodeURIComponent(n.rig)}`
            : "/ui",
  };
}

/** A trial's intro line without its "trial on lane-1: " prefix. */
const introText = (s: string) => s.replace(/^(research )?trial on [^:]+: /, "");

/**
 * What each agent of a run does now, one line each: every lane, the final writer, the planner
 * when it waits, and the judge. The pages' run brief says the same (ui/operator/brief.ts).
 */
function nowLines(store: ControlStore, u: RigView, r: RunView, now: number): NowLine[] {
  const out: NowLine[] = [];
  const running = r.status === "running";
  const trials = store.liveLines.trials(u.id).filter((t) => t.run === r.id);
  const lanes = [
    ...new Set([
      ...Object.keys(r.at_work),
      ...(r.epoch?.assignments.map((a) => a.lane) ?? []),
      ...trials.map((t) => t.lane).filter((l): l is string => !!l),
    ]),
  ].sort();
  for (const lane of lanes) {
    const t = trials.find((x) => x.lane === lane);
    const plan = r.epoch?.assignments.find((a) => a.lane === lane);
    const work = r.at_work[lane];
    // A live session counts only while it is fresh: a trial cut off by a restart never ends.
    const fresh = t && !t.ended && Date.parse(t.last_at) > now - 15 * 60_000;
    if ((work || fresh) && running) {
      const what =
        work?.focus ||
        plan?.focus ||
        introText(t?.intro ?? "") ||
        work?.direction ||
        plan?.direction ||
        "";
      out.push({
        who: lane,
        text: clip(what, 200),
        since: work?.since ?? t?.started_at ?? null,
        busy: true,
        tone: "working",
      });
    } else
      out.push({
        who: lane,
        text: !running
          ? "stopped"
          : plan
            ? `next: ${clip(plan.focus || plan.direction, 160)}`
            : "between trials",
        since: null,
        busy: false,
        tone: "none",
      });
  }
  if (!lanes.length && running)
    out.push({
      who: "lanes",
      text: !r.has_agents
        ? "no agents on this run: changes come from people"
        : r.agents.trials
          ? "between trials"
          : "waiting for the first round",
      since: null,
      busy: false,
      tone: "none",
    });
  if (running && r.paper?.state === "writing")
    out.push({
      who: "writer",
      text: "the final writer is writing the paper",
      since: r.paper.requested_at,
      busy: true,
      tone: "working",
    });
  // The planner, only when it waits for something.
  const planner = store.liveLines
    .tail(u.id, 40, "planner")
    .filter((l) => !l.run || l.run === r.id)
    .at(-1);
  if (running && planner && planner.kind === "status" && (!r.epoch || planner.at > r.epoch.at))
    out.push({ who: "planner", text: planner.text, since: null, busy: false, tone: "needs" });
  const mine = (x: { run: string | null }) => x.run === r.id || x.run === null;
  const job = u.judge.now && mine(u.judge.now) ? u.judge.now : null;
  const queued = u.judge.queued.filter(mine).length;
  out.push(
    job
      ? {
          who: "judge",
          text: `${jobText(job)}${queued ? ` · ${queued} more queued` : ""}`,
          since: job.started_at ?? null,
          busy: true,
          tone: "working",
        }
      : {
          who: "judge",
          text: `idle${queued ? `, ${queued} queued` : ""}`,
          since: null,
          busy: false,
          tone: "none",
        },
  );
  return out;
}

/** A run as a row: its state, its result so far, and what each of its agents does now. */
export function runRow(
  store: ControlStore,
  u: RigView,
  r: RunView,
  now: number,
  waiting: number,
): RunRow {
  return {
    campaign: runCampaign(r),
    run: r.id,
    rig: u.id,
    mode: r.mode,
    mode_words: modeName(r.mode),
    state: stateOf(runState(r)),
    judge_only: r.has_agents === false,
    figure: {
      text: runFigure(r),
      steps:
        r.mode === "hill_climb"
          ? // A champion's gain over the starting point, which is champion #1 at 0.
            r.champion.map((c) => ({ seq: c.seq, at: c.at, gain: c.cumulative - 1 }))
          : [],
      goals:
        r.mode === "goal"
          ? r.goals.map((g) => {
              const st = goalState(g);
              return {
                goal: g.goal,
                state: { word: st.word, tone: toneOf(st.tone) },
                reasons: g.reasons,
              };
            })
          : [],
    },
    champion: currentChampion(r)?.seq ?? null,
    started_at: r.created_at,
    now: nowLines(store, u, r, now),
    needs: waiting,
  };
}

/** The run an event is about: its body's run, the run it names, or its attempt's run. */
const eventRun = (u: RigView, e: StoredEvent): RunView | undefined => {
  const b = e.body?.run;
  if (typeof b === "string") return u.runs.find((r) => r.id === b);
  if (!e.subject) return undefined;
  return (
    u.runs.find((r) => r.id === e.subject) ??
    u.runs.find((r) => r.attempts.some((a) => a.id === e.subject))
  );
};

/** Events as sentences, newest first; bookkeeping events are left out. */
export function eventRows(items: { u: RigView; e: StoredEvent }[], limit: number): EventRow[] {
  const out: EventRow[] = [];
  for (const { u, e } of [...items].sort((a, b) => b.e.at.localeCompare(a.e.at))) {
    const s = sentence(u, e);
    if (!s) continue;
    // An attempt is named by what it does, as the pages name it, where its author said.
    const of = s.attempt ? runOfAttempt(u, s.attempt) : undefined;
    const said = of?.attempts.find((a) => a.id === s.attempt)?.hypothesis;
    const run = of ?? eventRun(u, e);
    out.push({
      at: e.at,
      tone: toneOf(s.tone),
      text: s.attempt && said ? s.text.replace(s.attempt, `“${clip(said, 70)}”`) : s.text,
      rig: u.id,
      campaign: run ? runCampaign(run) : null,
      run: run?.id ?? null,
      attempt: s.attempt ?? null,
    });
    if (out.length >= limit) break;
  }
  return out;
}

/** The navigation's campaigns, with each one's state and folder; archived ones are left out. */
function navCampaigns(
  store: ControlStore,
  vs: RigView[],
  archived: ReadonlySet<string>,
): { campaigns: NavCampaign[]; folders: string[] } {
  const folders = store.folders.list();
  const folderOf = new Map(folders.flatMap((f) => f.campaigns.map((c) => [c, f.name] as const)));
  const campaigns = campaignViews(vs)
    .filter((k) => !archived.has(k.name))
    .map((k) => ({
      name: k.name,
      mode: k.mode,
      state: stateOf(campaignState(k)),
      folder: folderOf.get(k.name) ?? null,
      run: newestRun(k)?.run.id ?? null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { campaigns, folders: folders.map((f) => f.name) };
}

/** Home, from the rigs' views and what waits for the owner (the caller leaves out the archived). */
export function homeAnswer(
  store: ControlStore,
  vs: RigView[],
  feed: Need[],
  archived: ReadonlySet<string>,
  now: number,
): HomeAnswer {
  const shown = (r: RunView) => !archived.has(runCampaign(r));
  const atWork = vs.flatMap((u) =>
    u.runs
      .filter((r) => r.status === "running" && shown(r))
      .map((r) =>
        runRow(store, u, r, now, feed.filter((n) => n.rig === u.id && n.run === r.id).length),
      ),
  );
  const happened = eventRows(
    vs.flatMap((u) =>
      u.recent
        .slice(0, 40)
        .filter((e) => {
          const r = eventRun(u, e);
          return !r || shown(r);
        })
        .map((e) => ({ u, e })),
    ),
    10,
  );
  // A stopped RunPod pod can't report, and that is expected: it is not counted as offline.
  const expected = vs.filter((u) => !podStopped(u));
  return {
    at: new Date(now).toISOString(),
    counts: {
      // Every row of the list below, a rig that stopped reporting too: one number, one list.
      needs: feed.length,
      running: atWork.length,
      judging: vs.filter((u) => u.judge.now).length,
      queued: vs.reduce((n, u) => n + u.judge.queued.length, 0),
      rigs: expected.length,
      offline: expected.filter((u) => u.stale).length,
    },
    needs: feed.map((n, i) => needRow(vs, n, i)),
    at_work: atWork,
    happened,
    nav: navCampaigns(store, vs, archived),
  };
}
