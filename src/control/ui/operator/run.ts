import {
  type AttemptView,
  currentChampion,
  type JudgeJob,
  type RigView,
  type RunView,
  runCampaign,
} from "../../views/index.ts";
import { ago, esc, gainChip, icon, reportingTag, sparkline } from "../components/index.ts";
import { attemptHref, runHref } from "../urls.ts";
import { attemptState, clip, jobText, runOfAttempt, signed } from "../words/index.ts";
import { cap } from "./change.ts";
import { hasAdvisors, outcome } from "./outcome.ts";

/**
 * A run at a glance: how many decisions wait for the owner, its state, and its progress as one
 * figure and as a bar; and a run, its attempts and a judge job as rows.
 */

/**
 * How many of the owner's decisions a run waits on. With its rig: an audit that the rig's
 * auditor will decide is not one of them (goal 079). A closed run waits on none (goal 087).
 */
export function waitingOn(r: RunView, u?: RigView): number {
  if (r.status === "closed") return 0;
  const auditor = u ? hasAdvisors(u) : false;
  return (
    r.pending_promotions.length +
    (r.agents_stopped ? 1 : 0) +
    r.audits.filter((x) => x.decision === "block" || (x.decision === null && !auditor)).length +
    r.reviews.filter((x) => x.panel === "review_passed" && !x.owner).length +
    r.conclusions.filter((x) => x.decision === null).length
  );
}

/**
 * The changes that waited for a decision when their run closed (goal 087): none of them becomes
 * the champion, and the rig refuses a decision on them. None for a run that is not closed.
 */
export function leftByClose(r: RunView, u?: RigView): AttemptView[] {
  return r.status === "closed"
    ? r.attempts.filter((a) => outcome(r, a, u).word === "Run closed")
    : [];
}

/** A run's status for tables: running, paused or closed (with why), and what waits for you. */
export function runStateHtml(r: RunView): string {
  const n = waitingOn(r);
  const tone = r.status === "running" ? "info" : "muted";
  return `<span class="label ${tone}">${r.status === "running" ? icon.live : r.status === "paused" ? icon.pause : icon.check}${esc(r.status)}</span>${n ? ` <span class="label warn">${icon.warn}${n} need${n === 1 ? "s" : ""} you</span>` : ""}${r.status !== "running" && r.pause_reason ? `<div class="muted xs clip" title="${esc(r.pause_reason)}">${esc(r.pause_reason)}</div>` : ""}`;
}

/**
 * Whether a running run's agents wait for the provider's limit now: its newest wait, before its
 * time. Resume now (`end_wait`) ends it.
 */
export function waitsForLimit(r: RunView, now: number): boolean {
  return r.status === "running" && r.agents_wait !== null && Date.parse(r.agents_wait.until) > now;
}

/** A wait's end, in words: `2026-10-29 03:14 UTC`. */
export const waitEnd = (until: string) => `${until.replace("T", " ").slice(0, 16)} UTC`;

/** Why a running run starts no new trial or plan for now, in words; "" when it does not wait. */
export function waitWords(r: RunView, now: number): string {
  if (!waitsForLimit(r, now) || !r.agents_wait) return "";
  return `Its agents wait for the provider's limit until ${waitEnd(r.agents_wait.until)}: no new trial or plan starts before then. Resume now ends the wait.`;
}

/**
 * Why a goal run starts no new trial while the judge confirms a champion that met every required
 * goal (goal 086), in words; "" when it does not wait for that.
 */
export function confirmingWords(r: RunView): string {
  if (r.mode !== "goal" || !r.goals_confirming) return "";
  return `Champion #${r.goals_seq ?? "?"} met every required goal, and the judge is checking it a second time: no new trial starts until that check is done. If it agrees, the run closes; if not, the lanes go on.`;
}

/**
 * Where a hill climb's baseline stands, for the run's status line (goal 115): the judge measures
 * the starting point first, or could not and the run is in setup. Empty once it has measured it.
 */
export function baselineWords(r: RunView): string {
  if (r.mode !== "hill_climb" || r.status === "closed" || r.baseline) return "";
  if (r.setup)
    return `The judge could not measure the starting point (champion #${r.setup.champion_seq}): the run is in setup, and the lanes work to make it build and run its cases. The first change the judge can measure becomes the starting point.`;
  if (r.baseline_waiting)
    return "The judge measures the starting point on every case first: no round or trial starts until it has.";
  return "";
}

/** A goal's state: its tone, mark and word. */
export function goalState(g: RunView["goals"][number]): {
  tone: string;
  mark: string;
  word: string;
} {
  if (g.status === "met") return { tone: "ok", mark: "✓", word: "met" };
  if (g.reasons.startsWith("not run") || g.status === "not_runnable")
    return {
      tone: "off",
      mark: "·",
      word: g.reasons.startsWith("not run") ? "waiting on another goal" : "not runnable",
    };
  if (g.status === "unmet") return { tone: "bad", mark: "✕", word: "unmet" };
  return { tone: "warn", mark: "·", word: g.status.replace(/_/g, " ") };
}

/**
 * A run's progress as one figure, in words: "4/8 goals", "+9.1%" or "84 verified claims"; null
 * for a goal run whose goals are not checked yet.
 */
export function runFigure(r: RunView): string | null {
  if (r.mode === "goal") {
    if (!r.goals.length) return null;
    return `${r.goals.filter((g) => g.status === "met").length}/${r.goals.length} goals`;
  }
  if (r.mode === "hill_climb") {
    const champ = currentChampion(r);
    return signed((champ?.cumulative ?? 1) - 1);
  }
  const verified = Number((r.research as Record<string, unknown> | null)?.verified ?? 0);
  return `${Number.isFinite(verified) ? verified : 0} verified claims`;
}

/** A run's progress in one glance: its goals as a bar, its gain, or its verified claims. */
export function runProgress(r: RunView): string {
  const fig = runFigure(r);
  if (r.mode === "goal") {
    if (fig === null) return `<span class="muted small">goals not checked yet</span>`;
    const segs = r.goals
      .map((g) => {
        const st = goalState(g);
        return `<span class="seg ${st.tone}" title="${esc(g.goal)}: ${esc(st.word)}"></span>`;
      })
      .join("");
    return `<span class="goalbar">${segs}</span><b class="fig">${esc(fig)}</b>`;
  }
  if (r.mode === "hill_climb") return `${sparkline(r, 90, 22)}<b class="fig">${esc(fig)}</b>`;
  return `<b class="fig">${esc(fig)}</b>`;
}

/**
 * A run as one row: its state, its name (with its campaign, or with its rig), why it is paused or
 * when it last had an attempt, its progress, and how many decisions wait for the owner.
 */
export function runRow(u: RigView, r: RunView, now: number, name: "campaign" | "rig"): string {
  const [word, tone] =
    r.status === "running"
      ? ["Running", "ok"]
      : r.status === "paused"
        ? ["Paused", "warn"]
        : [cap(r.status), ""];
  const n = waitingOn(r, u);
  const last = r.attempts
    .map((a) => a.updated_at)
    .sort()
    .at(-1);
  const sub =
    r.status !== "running" && r.pause_reason
      ? r.pause_reason
      : last
        ? `last attempt ${ago(last, now)} ago`
        : "no attempt yet";
  const title =
    name === "campaign"
      ? `${esc(runCampaign(r))} › ${esc(r.id)}`
      : `${esc(r.id)} <span class="muted small">on ${esc(u.id)}${reportingTag(u)}</span>`;
  return `<a class="rr" href="${runHref(r)}"><span class="chip ${tone}">${esc(word)}</span><span class="ar-main"><b>${title}</b><span class="muted small">${esc(sub)}</span></span><span class="brief-progress">${runProgress(r)}</span><span class="rr-need">${n ? `<span class="warn small">${n} need${n === 1 ? "s" : ""} you</span>` : ""}</span></a>`;
}

/** Attempts as rows: the outcome word, the change, where it stands, its effect, lane and age. */
export function attemptRows(u: RigView, r: RunView, xs: AttemptView[], now: number): string {
  if (!xs.length)
    return `<div class="card"><div class="empty">No attempt yet: the lanes have not submitted anything.</div></div>`;
  return `<div class="card flat">${xs
    .map((a) => {
      const o = outcome(r, a, u);
      const effect =
        r.mode === "goal"
          ? a.gained?.length || a.lost.length
            ? `${a.gained?.length ? `<span class="chip ok">+${a.gained.length} goal${a.gained.length === 1 ? "" : "s"}</span>` : ""}${a.lost.length ? `<span class="chip bad">−${a.lost.length}</span>` : ""}`
            : ""
          : typeof a.delta === "number"
            ? gainChip(r, a)
            : "";
      const where =
        o.word === "Blocked" ? "the judge measured it; the auditor blocked it" : attemptState(a);
      return `<a class="ar" href="${attemptHref(r, a.id)}"><span class="chip ${o.tone} ar-out">${esc(o.word)}</span><span class="ar-main"><b>${esc(clip(a.hypothesis ?? a.id, 160))}</b><span class="muted small">${esc(where)}${a.known_flaws.length ? ` · ${a.known_flaws.length} declared flaw${a.known_flaws.length === 1 ? "" : "s"}` : ""}</span></span><span class="ar-effect">${effect}</span><span class="ar-lane">${esc(a.lane ?? "by hand")}</span><span class="ar-age">${esc(ago(a.updated_at, now))}</span></a>`;
    })
    .join("")}</div>`;
}

/** A judge job in words, its attempt named by what it does and linked. */
export function jobHtml(u: RigView, j: JudgeJob): string {
  const r = j.attempt ? runOfAttempt(u, j.attempt) : undefined;
  const a = r?.attempts.find((x) => x.id === j.attempt);
  const html = esc(jobText(j, a?.lane));
  if (!j.attempt || !r) return html;
  const id = esc(j.attempt);
  return html.replace(
    id,
    `<a href="${attemptHref(r, j.attempt)}" title="${id}">${a?.hypothesis ? `“${esc(clip(a.hypothesis, 70))}”` : id}</a>`,
  );
}
