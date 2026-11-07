import type { AttemptView, JudgeJob, RigView, RunView } from "../../views/index.ts";
import { esc } from "../components/index.ts";
import { duration } from "../metrics/index.ts";

/** Each kind of the judge's job, as the attempt's page names its time (goal 228). */
const JOB_WORDS: Record<string, string> = {
  evaluate: "The judge screened it",
  confirm: "The judge confirmed it",
  parent_screen: "The judge measured its parent",
};

/** Where a job ran: a runner of another machine by its name, or the core's own GPU. */
const where = (by: string | undefined) =>
  !by ? "" : /^executor-\d+$/.test(by) ? "on the core" : `on ${by.replace(/^executor-/, "")}`;

interface Row {
  label: string;
  ms: number;
  /** Still going: the time so far. */
  open?: boolean;
  note?: string;
}

const between = (from: string, to: string | null | undefined, now: number) =>
  (to ? Date.parse(to) : now) - Date.parse(from);

/**
 * How long each stage of an attempt took (goal 228): its lane's work on it, its wait for the
 * judge, each of the judge's jobs on it with its runner, its wait for a confirmation, its audit,
 * and the time from its submission to the champion. A stage under way says its time so far; a
 * stage whose times control no longer keeps (its trial's start, a job past the newest 200) has
 * no row. Empty when there is nothing to say.
 */
export function tookBlock(u: RigView, r: RunView, a: AttemptView, now: number): string {
  const rows: Row[] = [];
  if (a.trial_started_at)
    rows.push({
      label: "Its lane's work",
      ms: between(a.trial_started_at, a.recorded_at, now),
      note: `${a.lane ?? "its lane"}, from its trial's start to the submission`,
    });
  const jobs: JudgeJob[] = u.judge.jobs
    .filter((j) => j.attempt === a.id)
    .sort((x, y) => x.queued_at.localeCompare(y.queued_at));
  const screens = jobs.filter((j) => j.kind === "evaluate");
  const firstStart = screens.find((j) => j.started_at)?.started_at;
  if (firstStart)
    rows.push({ label: "Waited for the judge", ms: between(a.recorded_at, firstStart, now) });
  else if (screens.length)
    rows.push({ label: "Waits for the judge", ms: between(a.recorded_at, null, now), open: true });
  const screened = screens.filter((j) => j.finished_at).at(-1)?.finished_at;
  for (const j of jobs) {
    if (!j.started_at) continue;
    if (j.kind === "confirm" && screened && j.started_at > screened)
      rows.push({ label: "Waited for its confirmation", ms: between(screened, j.started_at, now) });
    const state = j.state === "failed" || j.state === "cancelled" ? `, ${j.state}` : "";
    rows.push({
      label: JOB_WORDS[j.kind] ?? `The judge's ${j.kind.replace("_", " ")} job`,
      ms: between(j.started_at, j.finished_at, now),
      open: !j.finished_at,
      note: `job ${j.id}${j.by ? ` ${where(j.by)}` : ""}${state}`,
    });
  }
  if (screened && jobs.some((j) => j.kind === "confirm" && !j.started_at))
    rows.push({
      label: "Waits for its confirmation",
      ms: between(screened, null, now),
      open: true,
    });
  const audit = r.audits.filter((x) => x.attempt === a.id).at(-1);
  if (audit && (audit.decided_at || audit.decision === null))
    rows.push({
      label: audit.decided_at ? "Its audit" : "Its audit, under way",
      ms: between(audit.at, audit.decided_at, now),
      open: !audit.decided_at,
    });
  const champ = r.champion.find((c) => c.attempt === a.id && !c.reopened);
  if (champ)
    rows.push({
      label: "From submission to champion",
      ms: between(a.recorded_at, champ.at, now),
      note: `champion #${champ.seq}`,
    });
  const judged = jobs.filter((j) => j.started_at && j.finished_at);
  if (judged.length > 1)
    rows.push({
      label: "The judge's time in all",
      ms: judged.reduce((s, j) => s + between(j.started_at as string, j.finished_at, now), 0),
      note: `${judged.length} jobs`,
    });
  if (!rows.length) return "";
  const dl = rows
    .map(
      (x) =>
        `<dt>${esc(x.label)}</dt><dd>${esc(duration(x.ms / 1000))}${x.open ? " so far" : ""}${x.note ? ` <span class="muted small">(${esc(x.note)})</span>` : ""}</dd>`,
    )
    .join("");
  return `<div class="block"><div class="head"><h2>How long it took</h2></div><div class="card"><dl class="facts">${dl}</dl></div></div>`;
}
