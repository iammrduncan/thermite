/**
 * Statistics for the judge: Student-t intervals on paired log ratios. Pure functions, tested
 * against reference values generated offline (tests/helpers/data/stats-reference.json).
 */

const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
  1.5056327351493116e-7,
];

/** ln Γ(x), by the Lanczos approximation (g = 7). */
function logGamma(x: number): number {
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  const z = x - 1;
  let a = LANCZOS[0] as number;
  const t = z + 7.5;
  for (let i = 1; i < LANCZOS.length; i++) a += (LANCZOS[i] as number) / (z + i);
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Continued fraction for the incomplete beta function (modified Lentz). */
function betaFraction(x: number, a: number, b: number): number {
  const tiny = 1e-300;
  const clamp = (v: number) => (Math.abs(v) < tiny ? tiny : v);
  let c = 1;
  let d = 1 / clamp(1 - ((a + b) * x) / (a + 1));
  let h = d;
  for (let m = 1; m <= 500; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((a - 1 + m2) * (a + m2));
    d = 1 / clamp(1 + aa * d);
    c = clamp(1 + aa / c);
    h *= d * c;
    aa = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + 1 + m2));
    d = 1 / clamp(1 + aa * d);
    c = clamp(1 + aa / c);
    const step = d * c;
    h *= step;
    if (Math.abs(step - 1) < 1e-15) break;
  }
  return h;
}

/** The regularized incomplete beta function I_x(a, b). */
export function incompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(
    logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x),
  );
  if (x < (a + 1) / (a + b + 2)) return (front * betaFraction(x, a, b)) / a;
  return 1 - (front * betaFraction(1 - x, b, a)) / b;
}

export function studentTCdf(t: number, df: number): number {
  const tail = 0.5 * incompleteBeta(df / (df + t * t), df / 2, 0.5);
  return t >= 0 ? 1 - tail : tail;
}

export function studentTQuantile(p: number, df: number): number {
  if (!(p > 0 && p < 1)) throw new RangeError(`quantile needs 0 < p < 1, got ${p}`);
  if (!(df > 0)) throw new RangeError(`degrees of freedom must be positive, got ${df}`);
  let lo = -1;
  let hi = 1;
  while (studentTCdf(lo, df) > p) lo *= 2;
  while (studentTCdf(hi, df) < p) hi *= 2;
  for (let i = 0; i < 200 && hi - lo > 1e-13 * Math.max(1, Math.abs(hi)); i++) {
    const mid = (lo + hi) / 2;
    if (studentTCdf(mid, df) < p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

function requireFinite(xs: readonly number[]): void {
  for (const x of xs) {
    if (!Number.isFinite(x)) throw new RangeError("statistics need finite values");
  }
}

export function mean(xs: readonly number[]): number {
  if (xs.length === 0) throw new RangeError("mean of no values");
  requireFinite(xs);
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

export function sampleSd(xs: readonly number[]): number {
  if (xs.length < 2) throw new RangeError("a standard deviation needs at least two values");
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}

export interface Interval {
  n: number;
  estimate: number;
  low: number;
  high: number;
}

/**
 * Two-sided 1 - alpha Student-t interval for the mean. `sdFloor` is the least spread to assume:
 * a few values that happen to agree on a noisy target must not look more precise than the
 * target's own A/A calibration showed it to be.
 */
export function meanInterval(xs: readonly number[], alpha: number, sdFloor = 0): Interval {
  if (!(alpha > 0 && alpha < 1)) throw new RangeError(`alpha must be in (0, 1), got ${alpha}`);
  const n = xs.length;
  const m = mean(xs);
  const sd = Math.max(sampleSd(xs), sdFloor);
  const half = (studentTQuantile(1 - alpha / 2, n - 1) * sd) / Math.sqrt(n);
  return { n, estimate: m, low: m - half, high: m + half };
}

/**
 * Improvement of a candidate over a reference as a log ratio: positive is better, whichever
 * direction the metric goes. Ratios need positive, finite values; anything else is refused.
 */
export function logImprovement(
  candidate: number,
  reference: number,
  direction: "max" | "min",
): number {
  if (!(candidate > 0 && reference > 0 && Number.isFinite(candidate + reference))) {
    throw new RangeError(`ratios need positive finite values (${candidate}, ${reference})`);
  }
  const r = Math.log(candidate / reference);
  return direction === "max" ? r : -r;
}

/** A fractional threshold (0.01 = 1%) in log-ratio space, and back. */
export const toLog = (fraction: number): number => Math.log1p(fraction);
export const toFraction = (logRatio: number): number => Math.expm1(logRatio);
