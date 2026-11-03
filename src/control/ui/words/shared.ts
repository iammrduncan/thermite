import type { AttemptView, Earlier, RigView, RunView } from "../../views/index.ts";

/** Plain words the dashboard's pages share, and an attempt found on its rig. */

/** The run of the rig's view that has an attempt, which its page's address hangs from. */
export function runOfAttempt(u: RigView, id: string): RunView | undefined {
  return u.runs.find((r) => r.attempts.some((x) => x.id === id));
}

export function findAttempt(u: RigView, id: string): AttemptView | undefined {
  return runOfAttempt(u, id)?.attempts.find((x) => x.id === id);
}

/** Where an earlier run ran (goal 170), in words: "on rig-a, retired". */
export const earlierWords = (rig: string, earlier: Earlier): string =>
  earlier === "retired" ? `on ${rig}, retired` : `before ${rig}'s full reset`;

export const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** A run's status in a few words, including why it is paused or closed. */
export function runStatusText(r: RunView): string {
  if (r.status === "running") return "running";
  if (r.status === "paused") return r.pause_reason ? `paused: ${r.pause_reason}` : "paused";
  if (r.status === "closed") return r.pause_reason ? `closed: ${r.pause_reason}` : "closed";
  return r.status;
}

/** "3 h 10 min", "12 min", "40 s": how long something has gone on. */
export function span(fromIso: string | null | undefined, now: number): string {
  if (!fromIso) return "";
  const s = Math.max(0, Math.round((now - Date.parse(fromIso)) / 1000));
  if (!Number.isFinite(s)) return "";
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h${m % 60 ? ` ${m % 60} min` : ""}`;
  return `${Math.round(h / 24)} days`;
}
