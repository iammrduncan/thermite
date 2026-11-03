/**
 * When to start a part again after it exited (the broker's controller and supervisor, the
 * supervisor image's supervisor): after a second if it had run for more than a minute, otherwise
 * twice as long as the last time, up to 30 s.
 */
export function restartAfter(
  ranMs: number,
  restarts: number,
): { restarts: number; delayMs: number } {
  const next = ranMs > 60_000 ? 0 : restarts + 1;
  return { restarts: next, delayMs: Math.min(30_000, 1000 * 2 ** Math.min(next, 5)) };
}
