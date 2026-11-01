import { DAYS, dayWords, type RetentionPolicy, type RetentionSpec } from "./policy.ts";

/** When a retention policy runs (index.ts): its due times, in UTC, and once for each. */
/** When a policy runs once on: its days and time, in UTC. */
export type RetentionWhen = Pick<RetentionSpec, "when" | "time" | "day">;

/** Monday is 0, as DAYS lists them; Date's getUTCDay has Sunday 0. */
const dayIndex = (d: Date) => (d.getUTCDay() + 6) % 7;

/**
 * The latest time the policy was due at or before `now`, in UTC; null for one only run by hand.
 * Daily: today's time, or yesterday's when it has not come yet. Weekly: its day's time this week,
 * or last week's.
 */
export function dueAt(w: RetentionWhen, now: Date): Date | null {
  if (w.when === "hand") return null;
  const [h, m] = w.time.split(":").map(Number) as [number, number];
  const at = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), h, m, 0, 0),
  );
  if (w.when === "daily") {
    if (at > now) at.setUTCDate(at.getUTCDate() - 1);
    return at;
  }
  at.setUTCDate(at.getUTCDate() - ((dayIndex(at) - DAYS.indexOf(w.day) + 7) % 7));
  if (at > now) at.setUTCDate(at.getUTCDate() - 7);
  return at;
}

/** The next time the policy is due after `now`; null for one only run by hand. */
export function nextDueAt(w: RetentionWhen, now: Date): Date | null {
  const last = dueAt(w, now);
  if (!last) return null;
  const next = new Date(last);
  next.setUTCDate(next.getUTCDate() + (w.when === "daily" ? 1 : 7));
  return next;
}

/** When a policy turned on now first runs, in words, as the form says it beside Save. */
export function firstRunWords(w: RetentionWhen, now: Date): string {
  const next = nextDueAt(w, now);
  if (!next) return "Turned on, it still runs only when you press Run now.";
  const day = (d: Date) => d.toISOString().slice(0, 10);
  const tomorrow = new Date(now);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const when =
    day(next) === day(now)
      ? "today"
      : day(next) === day(tomorrow)
        ? "tomorrow"
        : `on ${dayWords(DAYS[dayIndex(next)] ?? "monday")} ${day(next)}`;
  return `Turned on, it first runs ${when} at ${w.time} UTC.`;
}

/**
 * The due time a policy that is on runs for now, or null: at most once for each due time (it
 * last ran for `last_due`), never for one before it was turned on, and after a time control was
 * away, once for the latest due time it missed.
 */
export function dueNow(
  p: RetentionWhen & Pick<RetentionPolicy, "on" | "on_since" | "last_due">,
  now: Date,
): Date | null {
  if (!p.on || !p.on_since) return null;
  const at = dueAt(p, now);
  if (!at) return null;
  if (at.getTime() < Date.parse(p.on_since)) return null;
  if (p.last_due && Date.parse(p.last_due) >= at.getTime()) return null;
  return at;
}
