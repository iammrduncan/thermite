import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  GEMINI_CAP_MAX,
  GeminiApiError,
  GeminiApiKeys,
} from "../../../../src/control/providers/gemini-api/index.ts";
import {
  GEMINI_INPUT_ALLOWANCE,
  GEMINI_OUTPUT_CEILING,
} from "../../../../src/control/providers/gemini-api/prices.ts";
import { ControlStore } from "../../../../src/control/store/index.ts";
import { finalChunk } from "../../../stand-ins/gemini-api/server.ts";
import { BODY, CAP, KEY, type KeysFixture, keysFixture, MODEL, NAME } from "./fixture.ts";

/** gemini-3.5-flash-lite on the fixture's day: $0.30 in, $2.50 out, $0.03 cached per million. */
const IN = 0.3;
const OUT = 2.5;
/** The worst case of the fixture's call at an output limit, in micro-dollars. */
const worstOf = (limit = GEMINI_OUTPUT_CEILING, body = BODY) =>
  Math.ceil(
    (Buffer.byteLength(
      JSON.stringify({
        ...body,
        generationConfig: { ...body.generationConfig, maxOutputTokens: limit },
      }),
    ) +
      GEMINI_INPUT_ALLOWANCE) *
      IN,
  ) + Math.ceil(limit * OUT);
const reasonOf = (error: unknown) => {
  assert.ok(error instanceof GeminiApiError, `a Gemini API error, not ${String(error)}`);
  return error.reason;
};
const add = (f: KeysFixture, name = NAME) => f.keys.add(name, KEY, true, "owner:ui");
const USAGE = { promptTokenCount: 1000, candidatesTokenCount: 200, totalTokenCount: 1200 };

test("a call goes to Google alone with the key, under an output limit, and is settled to its reported cost", async () => {
  const f = await keysFixture();
  try {
    add(f);
    const partial = { candidates: [{ content: { role: "model", parts: [{ text: "one" }] } }] };
    f.google.answers.push({ kind: "stream", chunks: [partial, finalChunk(USAGE)] });
    const r = await f.call();
    assert.equal(r.error, undefined);
    assert.deepEqual(r.chunks, [partial, finalChunk(USAGE)]);
    const [sent] = f.google.content();
    assert.ok(sent);
    assert.equal(sent.path, `/v1beta/models/${MODEL}:streamGenerateContent`);
    assert.equal(sent.search, "?alt=sse");
    assert.equal(sent.key, KEY);
    assert.deepEqual(sent.body, {
      ...BODY,
      generationConfig: { maxOutputTokens: GEMINI_OUTPUT_CEILING },
    });
    assert.deepEqual(f.google.elsewhere, []);
    const l = f.ledger();
    // 1000 input tokens at $0.30 and 200 output tokens at $2.50 per million.
    assert.deepEqual([l.spent, l.reserved, l.calls, l.uncertain], [300 + 500, 0, 1, 0]);
    assert.deepEqual(l.by, [{ provider: NAME, spent: 800 }]);
  } finally {
    await f.close();
  }
});

test("control lowers a call's output limit to the owner's, and never raises the agent's own", async () => {
  const f = await keysFixture();
  try {
    add(f);
    f.keys.setOutputLimit(4096, "owner:ui");
    await f.call(f.keys, { ...BODY, generationConfig: { maxOutputTokens: 1_000_000 } });
    await f.call(f.keys, { ...BODY, generationConfig: { maxOutputTokens: 100, temperature: 0 } });
    assert.deepEqual(
      f.google.content().map((c) => (c.body as { generationConfig: unknown }).generationConfig),
      [{ maxOutputTokens: 4096 }, { maxOutputTokens: 100, temperature: 0 }],
    );
    for (const bad of [1023, 65_537, 2.5, Number.NaN])
      assert.throws(() => f.keys.setOutputLimit(bad, "owner:ui"));
  } finally {
    await f.close();
  }
});

test("a call is reserved at its worst case while it runs", async () => {
  const f = await keysFixture();
  try {
    add(f);
    f.google.answers.push({ kind: "hold", chunks: [{ candidates: [] }] });
    const controller = new AbortController();
    const running = f.keys.generate(f.provider(), MODEL, BODY, controller.signal);
    await running.next();
    assert.deepEqual([f.ledger().spent, f.ledger().reserved], [0, worstOf()]);
    controller.abort();
    await assert.rejects(running.next());
  } finally {
    await f.close();
  }
});

test("a call whose worst case reaches the cap exactly is sent; one micro-dollar over is refused unsent", async () => {
  const f = await keysFixture();
  try {
    add(f);
    f.keys.setCap((worstOf() - 1) / 1e6, "owner:ui");
    const refused = await f.call();
    assert.equal(reasonOf(refused.error), "cap");
    assert.equal(f.google.content().length, 0);
    assert.deepEqual([f.ledger().spent, f.ledger().reserved], [0, 0]);
    f.keys.setCap(worstOf() / 1e6, "owner:ui");
    assert.equal((await f.call()).error, undefined);
    assert.equal(f.google.content().length, 1);
    const refusal = f.store.auditLog.list(50).find((a) => a.action === "gemini_api_call_refused");
    assert.ok(refusal, "the refusal is in the audit log");
  } finally {
    await f.close();
  }
});

test("once the cap is spent every call is refused unsent until the next month", async () => {
  const f = await keysFixture({ start: "2026-11-30T23:00:00Z" });
  try {
    add(f);
    // One call's cost is unknown: its whole reservation is charged. The cap leaves no second.
    f.keys.setCap((worstOf() + 10) / 1e6, "owner:ui");
    f.google.answers.push({ kind: "cut", chunks: [{ candidates: [] }] });
    assert.equal(reasonOf((await f.call()).error), "server");
    assert.equal(f.ledger().spent, worstOf());
    for (let i = 0; i < 3; i++) assert.equal(reasonOf((await f.call()).error), "cap");
    assert.equal(f.google.content().length, 1);
    f.clock.now = new Date("2026-12-01T00:00:00Z");
    assert.equal((await f.call()).error, undefined);
    assert.equal(f.google.content().length, 2);
    assert.equal(f.ledger().month, "2026-12");
  } finally {
    await f.close();
  }
});

test("calls started together cannot spend past the cap", async () => {
  const f = await keysFixture();
  try {
    add(f);
    // Room for two worst cases, not three.
    f.keys.setCap((2 * worstOf() + 5) / 1e6, "owner:ui");
    for (let i = 0; i < 5; i++)
      f.google.answers.push({ kind: "hold", chunks: [{ candidates: [] }] });
    const controller = new AbortController();
    const runs = Array.from({ length: 5 }, () =>
      f.keys.generate(f.provider(), MODEL, BODY, controller.signal),
    );
    const firsts = await Promise.allSettled(runs.map((r) => r.next()));
    assert.equal(firsts.filter((r) => r.status === "fulfilled").length, 2);
    // The other three would fit beside what is spent, but not beside the open reservations: they
    // are told to wait, as for a rate limit, not that the month's cap is reached.
    for (const r of firsts)
      if (r.status === "rejected") assert.equal(reasonOf(r.reason), "rate_limit");
    assert.equal(f.google.content().length, 2);
    assert.equal(f.ledger().reserved, 2 * worstOf());
    controller.abort();
    await Promise.allSettled(runs.map((r) => r.next()));
    // Broken off: their cost is not known, so both reservations are charged whole.
    assert.deepEqual([f.ledger().spent, f.ledger().reserved], [2 * worstOf(), 0]);
    assert.ok(f.ledger().spent <= (f.keys.status().cap ?? 0));
    // Now the charges themselves leave no room: the cap is reached, and nothing more is sent.
    assert.equal(reasonOf((await f.call()).error), "cap");
    assert.equal(f.google.content().length, 2);
  } finally {
    await f.close();
  }
});

test("an answer without usage, or with usage that can't be read, is charged its whole reservation", async () => {
  const f = await keysFixture();
  try {
    add(f);
    const whole = { candidates: [{ content: { parts: [{ text: "x" }] }, finishReason: "STOP" }] };
    f.google.answers.push(
      { kind: "stream", chunks: [whole] },
      { kind: "stream", chunks: [{ ...whole, usageMetadata: { promptTokenCount: "many" } }] },
      { kind: "stream", chunks: [{ ...whole, usageMetadata: { promptTokenCount: 5 } }] },
    );
    for (let i = 1; i <= 3; i++) {
      const r = await f.call();
      // The answer is the agent's all the same.
      assert.equal(r.error, undefined);
      assert.equal(r.chunks.length, 1);
      assert.deepEqual([f.ledger().spent, f.ledger().uncertain], [i * worstOf(), i]);
    }
  } finally {
    await f.close();
  }
});

test("a stream that is cut, never finishes or is not Google's keeps its whole reservation", async () => {
  const f = await keysFixture();
  try {
    add(f);
    f.google.answers.push(
      { kind: "cut", chunks: [finalChunk(USAGE)] },
      // It ends without a finish reason.
      { kind: "stream", chunks: [{ candidates: [], usageMetadata: USAGE }] },
      { kind: "stream", chunks: ["not an object"] },
      { kind: "stream", chunks: [{ error: { message: `refused for ${KEY}` } }] },
    );
    for (let i = 1; i <= 4; i++) {
      const r = await f.call();
      assert.equal(reasonOf(r.error), "server");
      assert.equal(f.ledger().spent, i * worstOf());
    }
    assert.equal(f.ledger().uncertain, 4);
  } finally {
    await f.close();
  }
});

test("a model without a price is refused unsent, also one the provider's list was given by name", async () => {
  const f = await keysFixture();
  try {
    add(f);
    assert.equal(reasonOf((await f.call(f.keys, BODY, "gemini-9-unknown")).error), "route");
    f.store.modelProviders.addModel(NAME, "gemini-9-unknown");
    f.store.modelProviders.addModel(NAME, "gemini-2.5-pro");
    for (const model of ["gemini-9-unknown", "gemini-2.5-pro"])
      assert.equal(reasonOf((await f.call(f.keys, BODY, model)).error), "unpriced");
    assert.throws(() =>
      f.keys.raisePrice("gemini-9-unknown", { input: 1, output: 1, cached: 1 }, "o"),
    );
    assert.equal(f.google.calls.length, 0);
    assert.deepEqual([f.ledger().spent, f.ledger().reserved, f.ledger().calls], [0, 0, 0]);
  } finally {
    await f.close();
  }
});

test("breaking a call off settles its reservation in full: the caller's cancel and an abort", async () => {
  const f = await keysFixture();
  try {
    add(f);
    const partial = { candidates: [], usageMetadata: USAGE };
    // The caller stops reading.
    f.google.answers.push({ kind: "hold", chunks: [partial] });
    let closed = f.google.connectionClosed();
    const stopped = f.keys.generate(f.provider(), MODEL, BODY, new AbortController().signal);
    await stopped.next();
    await stopped.return();
    await closed;
    assert.deepEqual([f.ledger().spent, f.ledger().reserved], [worstOf(), 0]);
    // Its signal aborts.
    f.google.answers.push({ kind: "hold", chunks: [partial] });
    closed = f.google.connectionClosed();
    const controller = new AbortController();
    const aborted = f.keys.generate(f.provider(), MODEL, BODY, controller.signal);
    await aborted.next();
    controller.abort();
    await assert.rejects(aborted.next(), (e) => reasonOf(e) === "timeout");
    await closed;
    assert.deepEqual([f.ledger().spent, f.ledger().reserved], [2 * worstOf(), 0]);
    assert.equal(f.ledger().uncertain, 2);
    // An aborted signal before the call: nothing is sent and nothing charged.
    const before = new AbortController();
    before.abort();
    await assert.rejects(f.keys.generate(f.provider(), MODEL, BODY, before.signal).next());
    assert.equal(f.google.content().length, 2);
    assert.equal(f.ledger().spent, 2 * worstOf());
  } finally {
    await f.close();
  }
});

test("only the statuses Google documents as not charged (400 and 500) release the reservation; every status is named in Thermite's words", async () => {
  const f = await keysFixture();
  try {
    add(f);
    const cases = [
      [400, "request", { error: { message: "bad field" } }],
      [400, "context", { error: { message: "The input token count exceeds the maximum" } }],
      [401, "auth", { error: { message: `API key not valid: ${KEY}` } }],
      [402, "credits", undefined],
      [403, "auth", undefined],
      [404, "route", undefined],
      [429, "rate_limit", undefined],
      [500, "server", undefined],
      [503, "server", undefined],
      [504, "timeout", undefined],
    ] as const;
    for (const [status, reason, body] of cases) {
      f.google.answers.push({ kind: "status", status, body });
      const r = await f.call();
      assert.equal(reasonOf(r.error), reason, String(status));
      assert.ok(!String((r.error as Error).message).includes(KEY));
      assert.ok(!String((r.error as Error).message).includes("bad field"));
    }
    assert.equal(f.google.content().length, cases.length);
    // The two 400s and the 500 cost nothing. The other seven keep their whole reservation: no
    // status but those is proof that nothing was generated and billed.
    assert.deepEqual(
      [f.ledger().spent, f.ledger().reserved, f.ledger().uncertain, f.ledger().calls],
      [7 * worstOf(), 0, 7, cases.length],
    );
  } finally {
    await f.close();
  }
});

test("a connection never made costs nothing; any other failure before an answer keeps the reservation", async () => {
  const f = await keysFixture();
  try {
    add(f);
    for (const [code, spent] of [
      ["ECONNREFUSED", 0],
      ["ENOTFOUND", 0],
      ["ECONNRESET", worstOf()],
      ["UND_ERR_SOCKET", 2 * worstOf()],
    ] as const) {
      // Control on the same store, whose calls fail before any answer with this system code.
      const keys = new GeminiApiKeys(
        f.store,
        f.secrets,
        "http://localhost:8800",
        async () => {
          throw new TypeError("fetch failed", { cause: { code } });
        },
        () => f.clock.now,
      );
      assert.equal(reasonOf((await f.call(keys)).error), "server", code);
      assert.equal(f.ledger(keys).spent, spent, code);
    }
  } finally {
    await f.close();
  }
});

test("a redirect is not followed: the key reaches no other address", async () => {
  const f = await keysFixture();
  try {
    add(f);
    f.google.answers.push({ kind: "redirect", to: "https://elsewhere.example/v1beta/models" });
    const r = await f.call();
    assert.equal(reasonOf(r.error), "server");
    assert.deepEqual(f.google.elsewhere, []);
    assert.equal(f.google.calls.length, 1);
    // A redirect says nothing about the bill: its reservation is kept.
    assert.deepEqual([f.ledger().spent, f.ledger().uncertain], [worstOf(), 1]);
  } finally {
    await f.close();
  }
});

test("the ledger is on disk: a control started again counts what was spent and charges what was open", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-ledger-"));
  const path = join(dir, "control.db");
  const first = new ControlStore(path);
  const f = await keysFixture({ store: first });
  try {
    add(f);
    f.google.answers.push({ kind: "stream", chunks: [finalChunk(USAGE)] });
    await f.call();
    f.google.answers.push({ kind: "hold", chunks: [{ candidates: [] }] });
    const open = f.keys.generate(f.provider(), MODEL, BODY, new AbortController().signal);
    await open.next();
    assert.deepEqual([f.ledger().spent, f.ledger().reserved], [800, worstOf()]);
    // Control starts again on the same file while that call was open.
    const second = new ControlStore(path);
    const restarted = f.make(second);
    assert.deepEqual(
      [f.ledger(restarted).spent, f.ledger(restarted).reserved, f.ledger(restarted).uncertain],
      [800 + worstOf(), 0, 1],
    );
    // The old process's call ending later charges nothing twice.
    await open.return();
    assert.equal(f.ledger(restarted).spent, 800 + worstOf());
    second.db.close();
  } finally {
    await f.close();
    first.db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a new key and a new provider name do not reset what was spent", async () => {
  const f = await keysFixture();
  try {
    add(f);
    f.keys.setCap((worstOf() + 10) / 1e6, "owner:ui");
    f.google.answers.push({ kind: "cut", chunks: [] });
    await f.call();
    assert.equal(f.ledger().spent, worstOf());
    // A new key under the same name.
    f.keys.add(NAME, `${KEY}-rotated`, true, "owner:ui");
    assert.equal(reasonOf((await f.call()).error), "cap");
    // Another provider under a new name.
    f.keys.add("another-name", KEY, true, "owner:ui");
    assert.equal(reasonOf((await f.call(f.keys, BODY, MODEL, "another-name")).error), "cap");
    assert.equal(f.google.content().length, 1);
    assert.equal(f.ledger().spent, worstOf());
  } finally {
    await f.close();
  }
});

test("there is no cap until the owner sets one: no key is added and no call is sent without it", async () => {
  const f = await keysFixture({ cap: null });
  try {
    assert.equal(f.keys.status().cap, undefined);
    assert.throws(() => add(f), /Set the monthly spend cap first/u);
    assert.equal(f.store.modelProviders.get(NAME), undefined);
    assert.equal(f.store.ownSettings.get("gemini_api_keys"), undefined);
    // The owner's figure is the cap: no amount is built in, above or under it.
    for (const usd of [0, 0.5, 10, 250, 100_000]) {
      f.keys.setCap(usd, "owner:ui");
      assert.equal(f.keys.status().cap, usd * 1e6);
    }
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, GEMINI_CAP_MAX / 1e6 + 1])
      assert.throws(() => f.keys.setCap(bad, "owner:ui"), /0 or more/u);
    assert.equal(f.keys.status().cap, 100_000 * 1e6);
    add(f);
    // A cap of 0 refuses every call.
    f.keys.setCap(0, "owner:ui");
    assert.equal(reasonOf((await f.call()).error), "cap");
    // The setting gone or unreadable: no cap, and every call is refused unsent, in its own words.
    for (const stored of [null, "1e12", "plenty", "-3", "2.5", "", "99999999999999999"]) {
      f.store.ownSettings.set("gemini_api_cap_micro_usd", stored, "test");
      assert.equal(f.keys.status().cap, undefined, String(stored));
      assert.equal(reasonOf((await f.call()).error), "no_cap", String(stored));
    }
    assert.equal(f.google.calls.length, 0);
    assert.deepEqual([f.ledger().spent, f.ledger().reserved, f.ledger().calls], [0, 0, 0]);
    const refusal = f.store.auditLog.list(50).find((a) => a.action === "gemini_api_call_refused");
    assert.ok(refusal, "the refusal is in the audit log");
    f.keys.setCap(CAP / 1e6, "owner:ui");
    assert.equal((await f.call()).error, undefined);
  } finally {
    await f.close();
  }
});

test("a provider's row seals only the bridge capability: reading it as an ordinary provider's key gives no Google key", async () => {
  const f = await keysFixture();
  try {
    add(f);
    // What a route, a model list or an older control would open as "the provider's key".
    const opened = f.secrets.open(f.provider().key_sealed);
    assert.ok(!opened.includes(KEY));
    assert.deepEqual(Object.keys(JSON.parse(opened) as object), ["capability"]);
    assert.equal(
      f.keys.route(f.provider())?.key,
      (JSON.parse(opened) as { capability: string }).capability,
    );
    // The key is sealed apart, in control's settings, and is nowhere in the clear.
    const kept = JSON.parse(f.store.ownSettings.get("gemini_api_keys")?.value ?? "{}") as Record<
      string,
      string
    >;
    assert.deepEqual(Object.keys(kept), [NAME]);
    assert.ok(kept[NAME]?.startsWith("s1:"));
    assert.equal(f.secrets.open(kept[NAME] ?? ""), KEY);
    const rows = JSON.stringify([
      f.store.modelProviders.list(),
      f.store.ownSettings.get("gemini_api_keys"),
    ]);
    assert.ok(!rows.includes(KEY));
    assert.equal(f.google.calls.length, 0);
  } finally {
    await f.close();
  }
});

test("a failure whose bill is not known counts toward the cap, and at the cap the next call is not sent", async () => {
  const f = await keysFixture();
  try {
    add(f);
    // Room for two worst cases, not three.
    f.keys.setCap((2 * worstOf() + 5) / 1e6, "owner:ui");
    f.google.answers.push({ kind: "status", status: 504 }, { kind: "status", status: 503 });
    assert.equal(reasonOf((await f.call()).error), "timeout");
    assert.equal(reasonOf((await f.call()).error), "server");
    assert.equal(f.ledger().spent, 2 * worstOf());
    assert.equal(reasonOf((await f.call()).error), "cap");
    assert.equal(f.google.content().length, 2);
  } finally {
    await f.close();
  }
});

test("usage on an earlier chunk does not settle an answer whose last chunk has none, or none that reads", async () => {
  const f = await keysFixture();
  try {
    add(f);
    const early = { candidates: [], usageMetadata: USAGE };
    const terminals = [
      { candidates: [{ finishReason: "STOP" }] },
      { candidates: [{ finishReason: "STOP" }], usageMetadata: { promptTokenCount: "invalid" } },
      // Counts that contradict each other: a total under its parts, and more cached than prompt.
      {
        candidates: [{ finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 200, totalTokenCount: 900 },
      },
      {
        candidates: [{ finishReason: "STOP" }],
        usageMetadata: {
          promptTokenCount: 1000,
          cachedContentTokenCount: 1001,
          totalTokenCount: 1000,
        },
      },
    ];
    for (const terminal of terminals) {
      f.google.answers.push({ kind: "stream", chunks: [early, terminal] });
      // The answer is the agent's all the same.
      assert.equal((await f.call()).error, undefined);
    }
    assert.deepEqual(
      [f.ledger().spent, f.ledger().uncertain],
      [terminals.length * worstOf(), terminals.length],
    );
    // With usage on its last chunk the call settles to its cost, at each count's highest report.
    f.google.answers.push({ kind: "stream", chunks: [early, finalChunk(USAGE)] });
    assert.equal((await f.call()).error, undefined);
    assert.equal(f.ledger().spent, terminals.length * worstOf() + 800);
  } finally {
    await f.close();
  }
});

test("a caller that goes, or a key replaced, after the last chunk and before the stream's end keeps the whole reservation", async () => {
  const f = await keysFixture();
  try {
    add(f);
    // The caller's signal aborts after it has the final chunk.
    f.google.answers.push({ kind: "stream", chunks: [finalChunk(USAGE)] });
    const controller = new AbortController();
    const running = f.keys.generate(f.provider(), MODEL, BODY, controller.signal);
    assert.equal((await running.next()).done, false);
    controller.abort();
    await assert.rejects(running.next(), (e) => reasonOf(e) === "timeout");
    assert.deepEqual([f.ledger().spent, f.ledger().uncertain], [worstOf(), 1]);
    // The key is replaced after the final chunk.
    f.google.answers.push({ kind: "stream", chunks: [finalChunk(USAGE)] });
    const rotated = f.keys.generate(f.provider(), MODEL, BODY, new AbortController().signal);
    assert.equal((await rotated.next()).done, false);
    f.keys.add(NAME, `${KEY}-rotated`, true, "owner:ui");
    await assert.rejects(rotated.next());
    assert.deepEqual([f.ledger().spent, f.ledger().uncertain], [2 * worstOf(), 2]);
  } finally {
    await f.close();
  }
});

test("a provider named as a property every object has corrupts no ledger and no key", async () => {
  const f = await keysFixture();
  try {
    for (const name of ["constructor", "tostring", "valueof", "hasownproperty"]) add(f, name);
    add(f);
    for (const name of ["constructor", NAME, "constructor"]) {
      f.google.answers.push({ kind: "stream", chunks: [finalChunk(USAGE)] });
      assert.equal((await f.call(f.keys, BODY, MODEL, name)).error, undefined, name);
    }
    assert.deepEqual(f.ledger().by, [
      { provider: "constructor", spent: 1600 },
      { provider: NAME, spent: 800 },
    ]);
    // The ledger reads again after a restart, and the other provider is not blocked.
    assert.equal(f.ledger(f.make()).spent, 2400);
    assert.equal(f.keys.state(f.provider("constructor")), "connected");
    assert.equal(f.google.content().at(-1)?.key, KEY);
    // A model named so is no model of the table.
    assert.equal(reasonOf((await f.call(f.keys, BODY, "constructor")).error), "route");
    f.store.modelProviders.addModel(NAME, "constructor");
    assert.equal(reasonOf((await f.call(f.keys, BODY, "constructor")).error), "unpriced");
  } finally {
    await f.close();
  }
});

test("raised prices that can't be read refuse every call, unsent, until the owner clears them: never counted at the table's lower prices", async () => {
  const f = await keysFixture();
  try {
    add(f);
    f.keys.raisePrice(MODEL, { input: 9, output: 10, cached: 1 }, "owner:ui");
    const models = f.provider().models;
    for (const damaged of ["not JSON", JSON.stringify({ [MODEL]: { input: 9 } })]) {
      f.store.ownSettings.set("gemini_api_price_overrides", damaged, "test");
      assert.equal(f.keys.status().pricesReadable, false);
      assert.equal(reasonOf((await f.call()).error), "prices");
      // Nothing changes a price or empties a model list meanwhile.
      assert.throws(() => f.keys.raisePrice(MODEL, null, "owner:ui"), /can't be read/u);
      f.keys.setOutputLimit(4096, "owner:ui");
      await assert.rejects(f.keys.test(NAME, "owner:ui"), /can't be read/u);
      assert.deepEqual(
        f.provider().models.map((m) => m.id),
        models.map((m) => m.id),
      );
      assert.equal(f.store.ownSettings.get("gemini_api_price_overrides")?.value, damaged);
    }
    assert.equal(f.google.calls.length, 0);
    assert.equal(f.ledger().spent, 0);
    // The owner's own act ends it, and is in the audit log.
    f.keys.clearRaisedPrices("owner:ui");
    assert.equal(f.keys.status().pricesReadable, true);
    assert.equal((await f.call()).error, undefined);
    assert.ok(f.store.auditLog.list(50).some((a) => a.action === "gemini_api_prices_cleared"));
    // No raised prices stored at all is not "unreadable": the dated table counts.
    assert.equal(f.store.ownSettings.get("gemini_api_price_overrides"), undefined);
  } finally {
    await f.close();
  }
});

test("prices last checked more than 30 days ago refuse every call, unsent, until the owner has reviewed them", async () => {
  // The table was checked on 2026-11-16: it counts through 2026-12-15 (UTC).
  const f = await keysFixture({ start: "2026-12-15T23:59:59Z" });
  try {
    add(f);
    assert.equal(f.keys.status().pricesValidUntil, "2026-12-16");
    assert.equal((await f.call()).error, undefined);
    f.clock.now = new Date("2026-12-16T00:00:00Z");
    assert.equal(f.keys.status().pricesFresh, false);
    for (let i = 0; i < 2; i++) assert.equal(reasonOf((await f.call()).error), "prices");
    assert.equal(f.google.content().length, 1);
    const refusal = f.store.auditLog
      .list(50)
      .find((a) => (a.body as { why?: string }).why === "prices_stale");
    assert.ok(refusal, "the refusal is in the audit log");
    // A stored review that does not read, or is dated after today, counts for nothing.
    for (const stored of ["yesterday", "2026-13-45", "2027-01-01", ""]) {
      f.store.ownSettings.set("gemini_api_prices_reviewed", stored, "test");
      assert.equal(f.keys.status().pricesFresh, false, stored);
    }
    // The owner's review counts for 30 days from its day.
    f.keys.reviewPrices("owner:ui");
    assert.equal(f.keys.status().pricesValidUntil, "2027-01-15");
    assert.equal((await f.call()).error, undefined);
    f.clock.now = new Date("2027-01-14T23:59:59Z");
    assert.equal((await f.call()).error, undefined);
    f.clock.now = new Date("2027-01-15T00:00:00Z");
    assert.equal(reasonOf((await f.call()).error), "prices");
    // A clock that gives no time refuses too.
    f.clock.now = new Date(Number.NaN);
    assert.equal(reasonOf((await f.call()).error), "prices");
    assert.equal(f.google.content().length, 3);
  } finally {
    await f.close();
  }
});
