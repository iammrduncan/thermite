#!/usr/bin/env node
// The sample kit's check, run by the judge on one run's outputs (never by the candidate).
// It recomputes the expected product in float64 from the same inputs, and reads the
// dispatch probe. Prints one JSON object: {"pass": ..., "reasons": [...], ...}.
// usage: check.mjs <params.json> <out-dir>
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const [paramsPath, outDir] = process.argv.slice(2);
const p = JSON.parse(readFileSync(paramsPath, "utf8"));
const n = p.n;
const reasons = [];

let state = p.seed >>> 0;
const lcg = () => {
  state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
  return Math.fround((state >>> 8) / 16777216) - 0.5;
};
// The benchmark makes all of A and B new for every rep; the result is for the last rep's.
for (let r = 0; r < p.reps - 1; r++) for (let i = 0; i < 2 * n * n; i++) lcg();
const a = Float64Array.from({ length: n * n }, lcg);
const b = Float64Array.from({ length: n * n }, lcg);

const cPath = join(outDir, "c.bin");
let maxErr = Number.POSITIVE_INFINITY;
if (!existsSync(cPath)) {
  reasons.push("no result matrix");
} else {
  const buf = readFileSync(cPath);
  if (buf.length !== n * n * 4) {
    reasons.push(`result has ${buf.length} bytes, expected ${n * n * 4}`);
  } else {
    const c = new Float32Array(buf.buffer, buf.byteOffset, n * n);
    maxErr = 0;
    let nonFinite = 0;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        let s = 0;
        for (let k = 0; k < n; k++) s += a[i * n + k] * b[k * n + j];
        const got = c[i * n + j];
        if (!Number.isFinite(got)) {
          nonFinite++;
          continue;
        }
        maxErr = Math.max(maxErr, Math.abs(got - s));
      }
    }
    if (nonFinite) reasons.push(`${nonFinite} non-finite values`);
    const tolerance = 2e-3;
    if (maxErr > tolerance) reasons.push(`max abs error ${maxErr} above ${tolerance}`);
  }
}

let refCalls = null;
const probePath = join(outDir, "probe.txt");
if (existsSync(probePath)) {
  const m = /ref_calls=(\d+)/.exec(readFileSync(probePath, "utf8"));
  refCalls = m ? Number(m[1]) : null;
}
if (refCalls === null) reasons.push("dispatch probe missing");
else if (refCalls > 0) reasons.push(`dispatch proof failed: reference op called ${refCalls} times`);

process.stdout.write(
  `${JSON.stringify({ pass: reasons.length === 0, reasons, max_abs_error: maxErr, ref_calls: refCalls })}\n`,
);
