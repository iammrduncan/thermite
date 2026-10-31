const RIG_MS = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

export const DURATION_PATTERN = /^(\d+(?:\.\d+)?)([smhd])$/;

/** Parses durations such as "90s", "30m", "8h" or "7d" into milliseconds. */
export function parseDuration(text: string): number {
  const m = DURATION_PATTERN.exec(text);
  if (!m) throw new RangeError(`invalid duration: ${text}`);
  const amount = Number(m[1]);
  const rig = m[2] as keyof typeof RIG_MS;
  return amount * RIG_MS[rig];
}

/** A time of day in UTC, as a trial's prompt says when it ends: "14:05 UTC". */
export const endWords = (at: number) => `${new Date(at).toISOString().slice(11, 16)} UTC`;
