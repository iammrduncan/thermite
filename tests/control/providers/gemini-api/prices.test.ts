import assert from "node:assert/strict";
import { test } from "node:test";
import {
  GEMINI_INPUT_ALLOWANCE,
  GEMINI_OUTPUT_CEILING,
  GEMINI_PRICE_CHECKED,
  GEMINI_PRICE_SOURCE,
  GEMINI_PRICE_VALID_DAYS,
  GEMINI_PRICED_MODELS,
  geminiCost,
  geminiPricesFresh,
  geminiPricesValidUntil,
  geminiTariff,
  geminiUsage,
  geminiWorstCase,
} from "../../../../src/control/providers/gemini-api/prices.ts";

const at = (iso: string) => new Date(iso);
const tariffOf = (model: string, iso: string, raised = {}) => {
  const t = geminiTariff(model, at(iso), raised);
  assert.ok(t, `${model} has a price`);
  return t;
};

test("the price table names where and when its prices were read", () => {
  assert.match(GEMINI_PRICE_SOURCE, /^https:\/\/[a-z.]+\.google\.com\//u);
  assert.match(GEMINI_PRICE_CHECKED, /^\d{4}-\d{2}-\d{2}$/u);
  assert.ok(GEMINI_PRICED_MODELS.length > 0);
  for (const model of GEMINI_PRICED_MODELS) {
    const t = tariffOf(model, "2026-11-16T00:00:00Z");
    assert.ok(t.rates.input > 0 && t.rates.output >= t.rates.input, model);
    assert.ok(t.rates.cached > 0 && t.rates.cached <= t.rates.input, model);
  }
});

test("a model the table does not hold has no price, whatever the owner raised", () => {
  for (const model of ["gemini-9-unknown", "gemini-2.5-pro", "gemini-2.5-flash", "models"]) {
    assert.equal(geminiTariff(model, at("2026-11-16T00:00:00Z")), undefined);
    assert.equal(
      geminiTariff(model, at("2026-11-16T00:00:00Z"), {
        [model]: { input: 1, output: 1, cached: 1 },
      }),
      undefined,
    );
  }
});

test("a dated price rise counts from the day before its date, and stays after it", () => {
  // 2 / 10 / 0.10 through 30 November 2026; 4 / 20 / 0.20 from 1 December 2026.
  const before = tariffOf("gemini-4-carbon", "2026-11-29T23:59:59Z");
  assert.deepEqual(before.rates, { input: 2, output: 10, cached: 0.1 });
  for (const when of ["2026-11-30T00:00:00Z", "2026-12-01T00:00:00Z", "2027-03-01T00:00:00Z"])
    assert.deepEqual(tariffOf("gemini-4-carbon", when).rates, {
      input: 4,
      output: 20,
      cached: 0.2,
    });
});

test("the owner's price raises a figure and never lowers one", () => {
  const table = tariffOf("gemini-3.5-flash-lite", "2026-11-16T00:00:00Z").rates;
  const lowered = tariffOf("gemini-3.5-flash-lite", "2026-11-16T00:00:00Z", {
    "gemini-3.5-flash-lite": { input: 0, output: 0, cached: 0 },
  });
  assert.deepEqual(lowered.rates, table);
  const mixed = tariffOf("gemini-3.5-flash-lite", "2026-11-16T00:00:00Z", {
    "gemini-3.5-flash-lite": { input: 9, output: 0.01, cached: 0.5 },
  });
  assert.deepEqual(mixed.rates, { input: 9, output: table.output, cached: 0.5 });
});

test("a long prompt's prices are never under a short prompt's, also after a raise", () => {
  const raised = tariffOf("gemini-3.1-pro-preview", "2026-11-16T00:00:00Z", {
    "gemini-3.1-pro-preview": { input: 50, output: 1, cached: 1 },
  });
  assert.equal(raised.rates.input, 50);
  assert.equal(raised.long?.rates.input, 50);
  assert.equal(raised.long?.rates.output, 18);
});

test("the worst case prices all input uncached and the whole output limit", () => {
  const t = tariffOf("gemini-3.5-flash-lite", "2026-11-16T00:00:00Z");
  // 1,000,000 input tokens at $0.30 and 65,536 output tokens at $2.50, in micro-dollars.
  assert.equal(geminiWorstCase(t, 1_000_000, GEMINI_OUTPUT_CEILING), 300_000 + 163_840);
  // A fraction of a micro-dollar is rounded up, never down.
  assert.equal(geminiWorstCase(t, 1, 1), 1 + 3);
  assert.ok(GEMINI_INPUT_ALLOWANCE >= 1024);
});

test("the worst case takes the long prompt's prices once the input could pass their threshold", () => {
  const t = tariffOf("gemini-3.1-pro-preview", "2026-11-16T00:00:00Z");
  assert.equal(geminiWorstCase(t, 200_000, 1000), 200_000 * 2 + 1000 * 12);
  assert.equal(geminiWorstCase(t, 200_001, 1000), 200_001 * 4 + 1000 * 18);
});

test("a call's cost counts cached input, thinking, tool-use input and tokens only the total names", () => {
  const t = tariffOf("gemini-3.1-pro-preview", "2026-11-16T00:00:00Z");
  const usage = geminiUsage({
    promptTokenCount: 1000,
    cachedContentTokenCount: 400,
    candidatesTokenCount: 100,
    thoughtsTokenCount: 50,
    toolUsePromptTokenCount: 10,
    totalTokenCount: 1200,
  });
  assert.ok(usage);
  // 610 input at $2, 400 cached at $0.20, and 150 + 40 unnamed output at $12.
  assert.equal(geminiCost(t, usage), 610 * 2 + 80 + 190 * 12);
  // Thinking is charged though the response itself is empty.
  const thinking = geminiUsage({
    promptTokenCount: 10,
    thoughtsTokenCount: 500,
    totalTokenCount: 510,
  });
  assert.ok(thinking);
  assert.equal(geminiCost(t, thinking), 20 + 6000);
  // A prompt over the threshold pays the long prices for input and output.
  const long = geminiUsage({
    promptTokenCount: 200_001,
    candidatesTokenCount: 10,
    totalTokenCount: 200_011,
  });
  assert.ok(long);
  assert.equal(geminiCost(t, long), 200_001 * 4 + 10 * 18);
});

test("usage that does not say what a call used is no usage", () => {
  for (const bad of [
    undefined,
    null,
    "usage",
    {},
    { promptTokenCount: 5 },
    // Counts that contradict each other: a total under the prompt, a total under the prompt,
    // the response and its thinking, and more cached tokens than the prompt has.
    { promptTokenCount: 5, totalTokenCount: 4 },
    { promptTokenCount: 5, totalTokenCount: 6, candidatesTokenCount: 2 },
    { promptTokenCount: 5, totalTokenCount: 7, candidatesTokenCount: 1, thoughtsTokenCount: 2 },
    { promptTokenCount: 5, totalTokenCount: 5, cachedContentTokenCount: 6 },
    { totalTokenCount: 5 },
    { promptTokenCount: -1, totalTokenCount: 5 },
    { promptTokenCount: 1.5, totalTokenCount: 5 },
    { promptTokenCount: "5", totalTokenCount: 5 },
    { promptTokenCount: 5, totalTokenCount: 9, candidatesTokenCount: "4" },
    { promptTokenCount: 5, totalTokenCount: 9, thoughtsTokenCount: Number.NaN },
  ])
    assert.equal(geminiUsage(bad), undefined, JSON.stringify(bad));
});

test("the prices count for 30 days after the table's date or the owner's later review, and never on a clock without a time", () => {
  const day = (iso: string) => new Date(iso).toISOString().slice(0, 10);
  const until = (reviewed: string | undefined, now: string) =>
    day(new Date(geminiPricesValidUntil(reviewed, at(now))).toISOString());
  assert.equal(GEMINI_PRICE_VALID_DAYS, 30);
  const tableEnd = day(
    new Date(Date.parse(`${GEMINI_PRICE_CHECKED}T00:00:00Z`) + 30 * 86_400_000).toISOString(),
  );
  const last = `${day(new Date(Date.parse(`${tableEnd}T00:00:00Z`) - 1).toISOString())}T23:59:59Z`;
  assert.equal(until(undefined, last), tableEnd);
  assert.equal(geminiPricesFresh(undefined, at(last)), true);
  assert.equal(geminiPricesFresh(undefined, at(`${tableEnd}T00:00:00Z`)), false);
  // A review counts from its own day; one before the table's date, unreadable or dated after
  // now counts for nothing.
  assert.equal(until("2027-03-01", "2027-03-10T00:00:00Z"), "2027-03-31");
  assert.equal(geminiPricesFresh("2027-03-01", at("2027-03-30T23:59:59Z")), true);
  assert.equal(geminiPricesFresh("2027-03-01", at("2027-03-31T00:00:00Z")), false);
  for (const useless of ["2020-01-01", "soon", "2027-02-30x", "2099-01-01", ""]) {
    assert.equal(until(useless, "2027-03-10T00:00:00Z"), tableEnd, useless);
    assert.equal(geminiPricesFresh(useless, at("2027-03-10T00:00:00Z")), false, useless);
  }
  assert.equal(geminiPricesFresh("2027-03-01", new Date(Number.NaN)), false);
  assert.equal(geminiTariff("gemini-3.5-flash-lite", new Date(Number.NaN)), undefined);
});

test("a model named as a property every object has is no model of the table", () => {
  for (const model of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
    assert.equal(geminiTariff(model, at("2026-11-16T00:00:00Z")), undefined, model);
    // Nor does an entry so named among the raised prices change a real model's price.
    const raised = JSON.parse(`{"${model}":{"input":99,"output":99,"cached":99}}`) as Record<
      string,
      { input: number; output: number; cached: number }
    >;
    assert.deepEqual(tariffOf("gemini-3.5-flash-lite", "2026-11-16T00:00:00Z", raised).rates, {
      input: 0.3,
      output: 2.5,
      cached: 0.03,
    });
  }
});

test("raised cached prices and unknown token categories fit the reservation", () => {
  const t = tariffOf("gemini-3.5-flash-lite", "2026-11-16T00:00:00Z", {
    "gemini-3.5-flash-lite": { input: 0.3, output: 2.5, cached: 9 },
  });
  const bound = geminiWorstCase(t, 1000, 1);
  const cached = geminiUsage({
    promptTokenCount: 1000,
    cachedContentTokenCount: 1000,
    candidatesTokenCount: 1,
    totalTokenCount: 1001,
  });
  assert.ok(cached);
  assert.ok(bound >= geminiCost(t, cached));
  assert.equal(
    geminiCost(t, { prompt: 0, cached: 0, candidates: 0, thoughts: 0, toolUse: 0, total: 1 }),
    9,
  );
  assert.ok(geminiWorstCase(t, 0, 1) >= 9);
});
