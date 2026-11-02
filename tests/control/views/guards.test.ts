import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  attemptGuards,
  championGuardLine,
  guardCharts,
} from "../../../src/control/ui/components/guards.ts";
import { championGuards, guardMeasured, guardsOf } from "../../../src/control/views/guards.ts";
import { parseContract } from "../../../src/core/contract.ts";
import { type Block, decideScreen } from "../../../src/harness/judge/decide.ts";
import { Ledger } from "../../../src/harness/ledger/index.ts";
import { hillClimbFixture } from "../../helpers/fixtures.ts";

/** A hill climb's contract with one guard: decode_tps may fall at most 1% in all. */
function contract() {
  const r = parseContract({
    ...hillClimbFixture,
    guards: [
      {
        metric: "decode_tps",
        direction: "max",
        max_step_regression: 0.01,
        max_total_regression: 0.01,
      },
    ],
  });
  if (!r.ok || r.contract.mode !== "hill_climb") throw new Error("fixture");
  return r;
}

test("the judge's decision carries each guard's measured values, as it does the main metric's", () => {
  const policy = contract().contract;
  if (policy.mode !== "hill_climb") throw new Error("fixture");
  const primary = policy.objective.primary.metric;
  const blocks: Block[] = [0, 1, 2].map((i) => ({
    candidate: {
      [primary]: Object.fromEntries(policy.cells.map((c) => [c, 120 + i])),
      decode_tps: Object.fromEntries(policy.cells.map((c) => [c, 29.9])),
    },
    reference: {
      [primary]: Object.fromEntries(policy.cells.map((c) => [c, 100 + i])),
      decode_tps: Object.fromEntries(policy.cells.map((c) => [c, 30])),
    },
  }));
  const d = decideScreen(policy, blocks);
  const g = d.guards.find((x) => x.metric === "decode_tps");
  assert.deepEqual(
    g?.values.cells.map((c) => [c.candidate, c.reference]),
    policy.cells.map(() => [29.9, 30]),
  );
});

test("a verdict's event carries its guards as fractions with their values; the ledger's row keeps the log ratios", () => {
  const ledger = Ledger.open(join(mkdtempSync(join(tmpdir(), "thermite-guards-")), "ledger.db"));
  const { contract: c, sha } = contract();
  ledger.contracts.store(c, sha, "test");
  ledger.runs.create({
    id: "r",
    contract: c,
    contractSha: sha,
    seedRepo: "p",
    seedCommit: "a".repeat(40),
    actor: "test",
  });
  ledger.attempts.record(
    {
      id: "a-1",
      run: "r",
      parentRef: "seed",
      parentCommit: "a".repeat(40),
      baselineChampionSeq: 1,
      commitSha: "b".repeat(40),
      ref: "refs/thermite/attempts/a-1",
      diffSha: "d",
      normalizedDiffSha: "d",
      lifecycle: "submitted",
    },
    "test",
  );
  const values = { metric: "decode_tps", cells: [{ cell: "x", candidate: 29.9, reference: 30 }] };
  const id = ledger.verdicts.record({
    attempt: "a-1",
    verdict: "win_confirmed",
    delta: 0.08,
    guards: [
      {
        metric: "decode_tps",
        status: "ok",
        estimate: Math.log(0.999),
        low: Math.log(0.995),
        high: Math.log(1.003),
        values,
        vs_start: { estimate: Math.log(0.998), noise: 0.001, spent: false },
      },
    ],
    reasons: "t",
    judgedBy: "j",
  });
  const e = ledger.eventsAfter(0, 1000).events.find((x) => x.kind === "verdict");
  assert.ok(e);
  const g = (e.body as { guards: Record<string, unknown>[] }).guards[0];
  assert.equal(g?.metric, "decode_tps");
  assert.equal(g?.status, "ok");
  assert.ok(Math.abs((g?.change as number) + 0.001) < 1e-9);
  assert.deepEqual(g?.values, values);
  assert.deepEqual(g?.vs_start, { change: 0.998 - 1, spent: false });
  assert.match(String(ledger.verdicts.get(id)?.guards), /"estimate":-0\.00100/);
  ledger.close();
});

/** A run as control folds it: a baseline with one guard, two champions after the start. */
function run() {
  const guard = (candidate: number, reference: number, status = "ok") =>
    guardsOf([
      {
        metric: "decode_tps",
        status,
        change: candidate / reference - 1,
        values: { metric: "decode_tps", cells: [{ cell: "x", candidate, reference }] },
      },
    ]);
  return {
    baseline: {
      champion_seq: 1,
      primary: { metric: "prefill_tps", direction: "max" },
      guards: [{ metric: "decode_tps", direction: "max", max_total_regression: 0.01 }],
      units: { decode_tps: "tok/s", prefill_tps: "tok/s" },
      cells: [{ cell: "x", metrics: [{ metric: "decode_tps", median: 30, mad: 0.1, n: 9 }] }],
    },
    champion: [
      { seq: 1, attempt: null, cumulative: 1, reopened: false },
      { seq: 2, attempt: "a-2", cumulative: 1.08, reopened: false },
      { seq: 3, attempt: "a-3", cumulative: 1.1, reopened: false },
      { seq: 4, attempt: "a-old", cumulative: 1.12, reopened: false },
    ],
    attempts: [
      { id: "a-2", guards: guard(29.9, 30) },
      { id: "a-3", guards: guard(29.75, 29.9) },
      // Judged before its verdicts carried guard values.
      { id: "a-old", guards: [] },
      { id: "a-tradeoff", guards: guard(29.5, 29.75, "violated") },
    ],
  } as unknown as Parameters<typeof championGuards>[0];
}

test("each guard across the champions: the start, the limit and each champion's value", () => {
  const [g] = championGuards(run());
  assert.equal(g?.start, 30);
  assert.ok(Math.abs((g?.limit as number) - 29.7) < 1e-9);
  assert.deepEqual(g?.points, [
    { seq: 1, value: 30 },
    { seq: 2, value: 29.9 },
    { seq: 3, value: 29.75 },
    { seq: 4, value: null },
  ]);
  // An older harness's event has no guards; a malformed one is left out.
  assert.deepEqual(guardsOf(undefined), []);
  assert.deepEqual(guardsOf([{ status: "ok" }]), []);
  assert.equal(guardsOf([{ metric: "m", status: "odd" }])[0]?.status, null);
});

test("the run page draws each guard's chart and a line under each champion, amber near the limit", () => {
  const r = run();
  const charts = guardCharts(r);
  assert.match(charts, /<b>decode_tps<\/b>/);
  assert.match(charts, /may fall at most 1% below the start/);
  assert.match(charts, /class="limit"/);
  assert.match(charts, /class="start"/);
  // Three known values: a line through them, the last one labelled; #4 has no point.
  assert.equal(charts.match(/class="gpt/g)?.length, 3);
  assert.match(charts, /29\.75 tok\/s<\/text>/);
  // 29.75 is past three quarters of the way to the limit (29.775): amber.
  assert.match(charts, /class="gpt near"[^>]*><title>#3/);
  assert.match(
    championGuardLine(r, 2),
    /decode_tps <b>29\.9 tok\/s<\/b> \(−0\.33% of the start; limit −1%\)/,
  );
  assert.match(championGuardLine(r, 3), /class="near".*near its limit/);
  assert.equal(championGuardLine(r, 4), "");
  // A run without guards, or without a baseline, draws none.
  assert.equal(guardCharts({ ...r, baseline: null } as unknown as typeof r), "");
});

test("an attempt shows each guard's change against its champion, red when the judge found it beyond the margin", () => {
  const r = run();
  const a = (r.attempts as { id: string; guards: ReturnType<typeof guardsOf> }[]).find(
    (x) => x.id === "a-tradeoff",
  );
  assert.ok(a);
  assert.ok(Math.abs((guardMeasured(a.guards[0] as never) as number) - (29.5 / 29.75 - 1)) < 1e-9);
  const html = attemptGuards(r, a);
  assert.match(
    html,
    /<span class="ag bad" title="decode_tps against the champion it was measured with\nx: 29\.8 → 29\.5 tok\/s/,
  );
  assert.match(html, />decode_tps -0\.8%</);
  assert.equal(attemptGuards(r, { guards: [] }), "");
});
