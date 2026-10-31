import assert from "node:assert/strict";

/**
 * Property tests without a library (goal 125, T10): seeded random cases, the same on every run,
 * each checked against a rule that must hold for all of them. A failure names its case and seed,
 * so it can be run again alone.
 */

/** Uniform numbers in [0, 1) from `seed` (mulberry32). */
export function uniforms(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal numbers from `seed` (Box-Muller over `uniforms`). */
export function normals(seed: number): () => number {
  const u = uniforms(seed);
  return () => Math.sqrt(-2 * Math.log(u() || 1e-12)) * Math.cos(2 * Math.PI * u());
}

/** Draws for one case: a number in [lo, hi), a whole number in [lo, hi], a normal, a list. */
export interface Draw {
  between(lo: number, hi: number): number;
  int(lo: number, hi: number): number;
  normal(): number;
  list<T>(n: number, item: () => T): T[];
}

function draws(seed: number): Draw {
  const u = uniforms(seed);
  const z = normals(seed ^ 0x5bd1e995);
  return {
    between: (lo, hi) => lo + (hi - lo) * u(),
    int: (lo, hi) => lo + Math.floor((hi - lo + 1) * u()),
    normal: z,
    list: (n, item) => Array.from({ length: n }, item),
  };
}

/**
 * Checks `rule` on `n` cases that `make` draws, case k from seed `seed + k`. The rule throws
 * (an assertion) when it does not hold; the failure says which case and seed.
 */
export function forCases<C>(
  n: number,
  seed: number,
  make: (d: Draw) => C,
  rule: (c: C) => void,
): void {
  for (let k = 0; k < n; k++) {
    const c = make(draws(seed + k));
    try {
      rule(c);
    } catch (err) {
      assert.fail(`case ${k} (seed ${seed + k}): ${JSON.stringify(c)}\n${String(err)}`);
    }
  }
}
