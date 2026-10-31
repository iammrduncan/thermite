import assert from "node:assert/strict";
import { test } from "node:test";
import { gainChip, measuredWords, startWords } from "../../../src/control/ui/components/gains.ts";
import {
  figure,
  metricValuesOf,
  valuesByCase,
  valuesWords,
} from "../../../src/control/views/metric-values.ts";
import { blockEffects, metricValues } from "../../../src/harness/judge/decide.ts";

test("the judge's values are each case's median of each side, as the gain compares them", () => {
  // As the judge fills a block: by metric, then by case (goal 142).
  const block = (c: number, r: number) => ({
    candidate: { ops: { small: c } },
    reference: { ops: { small: r } },
  });
  const blocks = [block(600, 400), block(614, 412), block(650, 420)];
  const v = metricValues(blocks, "ops", ["small", "big"]);
  // The big case has no values in these blocks: it is left out, never given a zero.
  assert.deepEqual(v, {
    metric: "ops",
    cells: [{ cell: "small", candidate: 614, reference: 412 }],
  });
  // The gain reads the same blocks the same way.
  assert.equal(blockEffects(blocks, "ops", "max", ["small"]).length, 3);
});

test("an event's values are read leniently; one with none, or an older harness's, gives null", () => {
  assert.equal(metricValuesOf(undefined), null);
  assert.equal(metricValuesOf({ metric: "ops", cells: [] }), null);
  assert.deepEqual(
    metricValuesOf({
      metric: "ops",
      cells: [
        { cell: "a", candidate: 2, reference: 1 },
        { cell: "b", candidate: "x", reference: 1 },
      ],
    }),
    { metric: "ops", cells: [{ cell: "a", candidate: 2, reference: 1 }] },
  );
});

test("values in words: one case as it is, several as their geometric mean, with the unit", () => {
  const one = { metric: "tok_s", cells: [{ cell: "small", candidate: 614.2, reference: 412.4 }] };
  assert.equal(valuesWords(one, "tok/s"), "412 → 614 tok/s");
  const two = {
    metric: "tok_s",
    cells: [
      { cell: "small", candidate: 400, reference: 100 },
      { cell: "big", candidate: 100, reference: 100 },
    ],
  };
  assert.equal(valuesWords(two, "tok/s"), "100 → 200 tok/s, the mean of 2 cases");
  assert.equal(valuesByCase(two, "tok/s"), "small: 100 → 400 tok/s\nbig: 100 → 100 tok/s");
  assert.equal(figure(0.012345), "0.0123");
  assert.equal(figure(123456.7), "123,457");
});

test("a gain shows its values beside it, and the starting point its own, from the baseline", () => {
  const run = {
    baseline: {
      primary: { metric: "tok_s", direction: "max" },
      units: { tok_s: "tok/s" },
      cells: [{ cell: "small", metrics: [{ metric: "tok_s", median: 412, mad: 3, n: 9 }] }],
    },
  } as unknown as Parameters<typeof gainChip>[0];
  const values = { metric: "tok_s", cells: [{ cell: "small", candidate: 614, reference: 412 }] };
  const chip = gainChip(run, { delta: 0.4897, values });
  assert.match(chip, /<span class="chip ok"><b>\+49\.0%<\/b><\/span>/);
  assert.match(
    chip,
    /<span class="muted small" title="small: 412 → 614 tok\/s">412 → 614 tok\/s<\/span>/,
  );
  assert.equal(gainChip(run, { delta: null, values }), "");
  // An older harness's verdict, with no values: the chip alone.
  assert.doesNotMatch(gainChip(run, { delta: 0.1, values: null }), /→/);
  assert.equal(measuredWords(run, { delta: 0.4897, values }), "+49.0% (412 → 614 tok/s)");
  assert.equal(startWords(run), "412 tok/s");
  assert.equal(startWords({ baseline: null } as unknown as Parameters<typeof startWords>[0]), "");
});

test("the champion's value against the starting point's: on the leaderboard and the campaign headline", async () => {
  const { championValues, championWords } = await import(
    "../../../src/control/views/metric-values.ts"
  );
  const { bestGainWords } = await import("../../../src/control/ui/components/gains.ts");
  const run = {
    baseline: {
      primary: { metric: "tok_s", direction: "max" },
      units: { tok_s: "tok/s" },
      cells: [{ cell: "small", metrics: [{ metric: "tok_s", median: 412, mad: 3, n: 9 }] }],
    },
    champion: [
      { seq: 1, attempt: null, cumulative: 1, reopened: false },
      { seq: 2, attempt: "a-2", cumulative: 1.49, reopened: false },
    ],
    attempts: [
      {
        id: "a-2",
        values: { metric: "tok_s", cells: [{ cell: "small", candidate: 614, reference: 412 }] },
      },
    ],
  } as unknown as Parameters<typeof championValues>[0];
  assert.deepEqual(championValues(run), {
    start: 412,
    champion: 614,
    unit: "tok/s",
    estimated: false,
  });
  assert.equal(championWords(run), "412 → 614 tok/s");
  assert.equal(bestGainWords(run), "best gain over its baseline: 412 → 614 tok/s");
  // A champion whose verdict has no values (an older harness, or before goal 142): estimated
  // from the starting point and its gain, and marked; never the starting point's value alone.
  const older = { ...run, attempts: [{ id: "a-2", values: null }] } as unknown as typeof run;
  assert.equal(championValues(older)?.estimated, true);
  assert.equal(championWords(older), "412 → ≈614 tok/s");
  // With no baseline either, nothing to say.
  assert.equal(championValues({ ...older, baseline: null } as unknown as typeof run), null);
  // Still the starting point: the champion is it.
  const seed = { ...run, champion: [run.champion[0]] } as unknown as typeof run;
  assert.equal(championWords(seed), "412 → 412 tok/s");
  assert.equal(bestGainWords(undefined), "best gain over its baseline");
});

test("a hill climb's champion card: its value and its gain over the start, an estimate marked, none for another mode (goal 142)", async () => {
  const { championCard } = await import("../../../src/control/ui/components/gains.ts");
  const run = {
    mode: "hill_climb",
    baseline: {
      primary: { metric: "tok_s", direction: "max" },
      units: { tok_s: "tok/s" },
      cells: [{ cell: "small", metrics: [{ metric: "tok_s", median: 7.73, mad: 0, n: 3 }] }],
    },
    champion: [
      { seq: 1, attempt: null, cumulative: 1, reopened: false },
      { seq: 4, attempt: "a-4", cumulative: 1.88, reopened: false },
    ],
    attempts: [
      {
        id: "a-4",
        values: { metric: "tok_s", cells: [{ cell: "small", candidate: 14.6, reference: 13.3 }] },
      },
    ],
  } as unknown as Parameters<typeof championCard>[0];
  const card = championCard(run);
  assert.match(card, /Champion #4/);
  assert.match(card, /<div class="v">14\.6<span class="u"> tok\/s<\/span><\/div>/);
  assert.match(card, /<b>\+88\.0%<\/b><\/span> over the start, 7\.73 tok\/s/);
  // Judged before its values were recorded: the estimate, marked; never the start's value.
  const older = { ...run, attempts: [{ id: "a-4", values: null }] } as unknown as typeof run;
  assert.match(championCard(older), /<div class="v">≈14\.5<span class="u"> tok\/s<\/span>/);
  // No change promoted yet: the starting point's value.
  const seed = { ...run, champion: [run.champion[0]] } as unknown as typeof run;
  assert.match(championCard(seed), /7\.73.*the starting point: no change promoted yet/s);
  assert.equal(championCard({ ...run, mode: "goal" } as unknown as typeof run), "");
});
