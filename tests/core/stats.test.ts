import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import {
  logImprovement,
  meanInterval,
  studentTCdf,
  studentTQuantile,
  toFraction,
  toLog,
} from "../../src/core/stats.ts";
import { forCases } from "../helpers/property.ts";

const reference = JSON.parse(
  readFileSync(new URL("../helpers/data/stats-reference.json", import.meta.url), "utf8"),
) as {
  t_quantile: [number, number, number][];
  t_cdf: [number, number, number][];
  mean_interval: { xs: number[]; alpha: number; mean: number; low: number; high: number }[];
};

const close = (got: number, want: number, rel = 1e-9) =>
  assert.ok(Math.abs(got - want) <= rel * Math.max(1, Math.abs(want)), `got ${got}, want ${want}`);

describe("statistics against offline reference values", () => {
  test("Student-t quantiles", () => {
    for (const [p, df, want] of reference.t_quantile) close(studentTQuantile(p, df), want);
  });

  test("Student-t distribution function", () => {
    for (const [t, df, want] of reference.t_cdf) close(studentTCdf(t, df), want);
  });

  test("mean intervals", () => {
    for (const r of reference.mean_interval) {
      const i = meanInterval(r.xs, r.alpha);
      close(i.estimate, r.mean);
      close(i.low, r.low);
      close(i.high, r.high);
    }
  });
});

describe("log improvements", () => {
  test("positive means better in both directions", () => {
    assert.ok(logImprovement(110, 100, "max") > 0);
    assert.ok(logImprovement(90, 100, "min") > 0);
    close(toFraction(logImprovement(110, 100, "max")), 0.1);
    close(toFraction(toLog(0.005)), 0.005);
  });

  test("NaN, infinities, zeros and negatives are never scores", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1]) {
      assert.throws(() => logImprovement(bad, 1, "max"), RangeError);
      assert.throws(() => logImprovement(1, bad, "max"), RangeError);
    }
    assert.throws(() => meanInterval([1, Number.NaN, 2], 0.05), RangeError);
    assert.throws(() => meanInterval([1], 0.05), RangeError);
  });
});

describe("statistics' properties, on seeded random cases", () => {
  test("the t distribution and its quantile are inverses, and symmetric", () => {
    forCases(
      300,
      1,
      (d) => ({ p: d.between(0.001, 0.999), df: d.int(1, 200) }),
      ({ p, df }) => {
        const q = studentTQuantile(p, df);
        close(studentTCdf(q, df), p, 1e-6);
        close(studentTQuantile(1 - p, df), -q, 1e-6);
      },
    );
  });

  test("a mean's interval holds its estimate, moves and scales with its values, and widens", () => {
    forCases(
      300,
      2,
      (d) => {
        const n = d.int(2, 30);
        return {
          xs: d.list(n, () => d.normal() * d.between(0.01, 5)),
          shift: d.between(-100, 100),
          scale: d.between(0.1, 10),
          alpha: d.between(0.01, 0.2),
          floor: d.between(0, 3),
        };
      },
      ({ xs, shift, scale, alpha, floor }) => {
        const i = meanInterval(xs, alpha);
        assert.ok(i.low <= i.estimate && i.estimate <= i.high);
        const moved = meanInterval(
          xs.map((x) => x + shift),
          alpha,
        );
        close(moved.low, i.low + shift, 1e-9);
        close(moved.high, i.high + shift, 1e-9);
        const scaled = meanInterval(
          xs.map((x) => x * scale),
          alpha,
        );
        close(scaled.high - scaled.low, (i.high - i.low) * scale, 1e-9);
        // A smaller alpha or a floor on the spread never narrows it.
        const strict = meanInterval(xs, alpha / 2);
        assert.ok(strict.high - strict.low >= i.high - i.low);
        const floored = meanInterval(xs, alpha, floor);
        assert.ok(floored.high - floored.low >= i.high - i.low);
      },
    );
  });

  test("an improvement is the same whichever way it is read", () => {
    forCases(
      300,
      3,
      (d) => ({ a: d.between(0.001, 1e6), b: d.between(0.001, 1e6), f: d.between(-0.9, 10) }),
      ({ a, b, f }) => {
        close(logImprovement(a, b, "max"), -logImprovement(b, a, "max"), 1e-12);
        close(logImprovement(a, b, "min"), logImprovement(b, a, "max"), 1e-12);
        close(toFraction(toLog(f)), f, 1e-9);
      },
    );
  });
});
