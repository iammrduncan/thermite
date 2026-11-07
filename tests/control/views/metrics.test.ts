import assert from "node:assert/strict";
import { test } from "node:test";
import { metricsBlock } from "../../../src/control/ui/components/metrics.ts";
import { guardsOf } from "../../../src/control/views/guards.ts";
import { roomLeft, runMetrics } from "../../../src/control/views/metrics.ts";
import type { RunView } from "../../../src/control/views/types.ts";

/**
 * Goal 209: a hill climb's metrics on its Overview, from its baseline's plan and its verdicts:
 * each metric at the start, at each champion and in the newest measured attempt, each guard's
 * limit and the room it leaves, drawn as option B2.
 */

const vals = (metric: string, candidate: number, reference: number) => ({
  metric,
  cells: [{ cell: "x", candidate, reference }],
});

function run(): RunView {
  const start = (metric: string, median: number, mad: number) => ({ metric, median, mad, n: 3 });
  return {
    id: "spark-decode-1",
    mode: "hill_climb",
    baseline: {
      champion_seq: 1,
      primary: { metric: "decode_tps", direction: "max" },
      guards: [],
      units: { decode_tps: "tok/s", prefill_tps: "tok/s", peak_gib: "GiB", ppl: "", itl_ms: "ms" },
      plan: {
        priorities: [
          { metric: "decode_tps", priority: 1, direction: "max", min_effect: 0.02 },
          { metric: "prefill_tps", priority: 2, direction: "max", min_effect: 0.01 },
        ],
        guards: [
          {
            metric: "peak_gib",
            rule: { stay: "below", against: "baseline", by: 0.05 },
            from: "kit",
          },
          { metric: "ppl", rule: { stay: "within", against: "baseline", by: 3 }, from: "kit" },
          {
            metric: "prefill_tps",
            rule: { stay: "above", against: "champion", by: 0.03 },
            from: "contract",
          },
        ],
        info: [{ metric: "itl_ms", kind: "info" }],
      },
      cells: [
        {
          cell: "x",
          metrics: [
            start("decode_tps", 41.8, 0.1),
            start("prefill_tps", 2140, 4),
            start("peak_gib", 92, 0.2),
            start("ppl", 6.412, 0.003),
            start("itl_ms", 23.9, 0.1),
          ],
        },
      ],
    },
    champion: [
      {
        seq: 1,
        attempt: null,
        cumulative: 1,
        delta: null,
        at: "2026-11-05T19:00:00Z",
        reopened: false,
      },
      {
        seq: 2,
        attempt: "a-1",
        cumulative: 43.5 / 41.8,
        delta: 43.5 / 41.8 - 1,
        at: "2026-11-05T19:20:00Z",
        reopened: false,
      },
    ],
    attempts: [
      {
        id: "a-1",
        recorded_at: "2026-11-05T19:10:00Z",
        values: vals("decode_tps", 43.5, 41.8),
        metrics: [vals("prefill_tps", 2190, 2140), vals("itl_ms", 23.0, 23.9)],
        guards: guardsOf([
          {
            metric: "peak_gib",
            status: "ok",
            rule: { stay: "below", against: "baseline", by: 0.05 },
            values: vals("peak_gib", 92.4, 92),
          },
          {
            metric: "ppl",
            status: "ok",
            rule: { stay: "within", against: "baseline", by: 3 },
            values: vals("ppl", 6.413, 6.412),
          },
        ]),
      },
      {
        id: "a-2",
        recorded_at: "2026-11-05T19:30:00Z",
        values: vals("decode_tps", 44.0, 43.5),
        metrics: [vals("itl_ms", 22.9, 23.0)],
        guards: guardsOf([
          {
            metric: "peak_gib",
            status: "ok",
            rule: { stay: "below", against: "baseline", by: 0.05 },
            values: vals("peak_gib", 95.8, 92.4),
          },
        ]),
      },
    ],
  } as unknown as RunView;
}

test("each metric of the plan at the start, at each champion and in the newest measured attempt", () => {
  const m = runMetrics(run());
  assert.ok(m);
  assert.deepEqual(
    m.priorities.map((p) => [p.metric, p.points.map((x) => x.value), p.latest?.attempt ?? null]),
    [
      ["decode_tps", [41.8, 43.5], "a-2"],
      ["prefill_tps", [2140, 2190], null],
    ],
  );
  assert.deepEqual(
    m.info.map((i) => [i.metric, i.points.map((x) => x.value), i.latest?.value]),
    [["itl_ms", [23.9, 23.0], 22.9]],
  );
  const [peak, ppl, prefill] = m.guards;
  // At most 5% above the baseline: 96.6 GiB at every champion; a-2's 95.8 leaves 0.8.
  assert.ok(peak?.limits.every((l) => l.low === null && Math.abs((l.high ?? 0) - 96.6) < 1e-9));
  assert.equal(peak && roomLeft(peak), "0.8 GiB to spare");
  // Within 3 sd of the baseline: a band around the start, from its MAD × 1.4826.
  const band = ppl?.limits[0];
  assert.ok(
    band && band.low !== null && band.high !== null && band.low < 6.412 && band.high > 6.412,
  );
  // Against the champion, the bound a change judged against each one keeps: 3% below its value.
  assert.deepEqual(
    prefill?.limits.map((l) => Math.round((l.low ?? 0) * 100) / 100),
    [2075.8, 2124.3],
  );
});

test("the Overview's metrics block: the primary's chart, a card for each lower priority, a row for each guard, a tile for each informational metric", () => {
  const html = metricsBlock(run());
  assert.match(html, /<h2>Metrics<\/h2>/);
  assert.match(html, /Priority 1 · primary<\/span><b>decode_tps<\/b>/);
  assert.match(html, /<label for="ms-gain">Gain<\/label>.*<label for="ms-unit">tok\/s<\/label>/s);
  assert.match(html, /Priority 2<\/span><b>prefill_tps<\/b>/);
  // The lower priorities in a row of their own, each sparkline as wide as its card.
  assert.match(
    html,
    /<div class="ms-top"><div class="card ms-primary">.*<\/div><div class="ms-lowers"><div class="card ms-lower">/s,
  );
  assert.match(html, /class="chart ms-spark fluid"/);
  assert.match(
    html,
    /<b>peak_gib<\/b><div class="muted small">at most 5% above the baseline<\/div>/,
  );
  assert.match(html, /<span class="chip ok">0\.8 GiB to spare<\/span>/);
  assert.match(
    html,
    /<b>ppl<\/b><div class="muted small">within 3 standard deviations of the baseline<\/div>/,
  );
  assert.match(html, /Informational metrics/);
  assert.match(html, /itl_ms/);
  // No baseline yet: no block, and the page keeps its champions' chart.
  assert.equal(metricsBlock({ ...run(), baseline: null } as RunView), "");
});
