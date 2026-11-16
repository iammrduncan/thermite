import assert from "node:assert/strict";
import { test } from "node:test";
import { setLogLevel } from "../../../src/common/log.ts";
import { SecretBox } from "../../../src/control/secrets.ts";
import { ControlRoute } from "../../../src/core/api/model-route.ts";
import { CONFIG_KEYS } from "../../../src/core/link/config.ts";
import { classifyProviderError, stopsAgents } from "../../../src/harness/agents/provider-errors.ts";
import { ADMIN, controlOnly, RIG_TOKEN } from "../../helpers/control-stack.ts";
import { finalChunk, startGeminiStandIn } from "../../stand-ins/gemini-api/server.ts";

/**
 * A Gemini API key through control's own bridge, as a rig calls it: control whole, in this
 * process, and the loopback stand-in for Google (no network, no real key).
 */

/** A made-up value in a key's shape: not a key of any service. */
const KEY = "not-a-real-gemini-api-key-fixture";
const NAME = "gemini-api";
const MODEL = "gemini-3.5-flash-lite";
const BODY = { contents: [{ role: "user", parts: [{ text: "fresh fixture" }] }] };
const USAGE = { promptTokenCount: 1000, candidatesTokenCount: 200, totalTokenCount: 1200 };

async function fixture() {
  const google = await startGeminiStandIn();
  const stack = controlOnly({
    options: {
      secrets: SecretBox.ephemeral(),
      publicUrl: "http://localhost:8800",
      providerFetch: google.fetch,
    },
  });
  const keys = stack.parts.geminiApi;
  keys.setCap(10, "owner:ui");
  // Control runs on the real clock here: the owner has reviewed the prices today.
  keys.reviewPrices("owner:ui");
  keys.add(NAME, KEY, true, "owner:ui");
  stack.store.agentModels.assignRig("rig-a", { provider: NAME, model: MODEL, harness: "pi" });
  const route = async () => {
    const config = await stack.rigConfig("model-route");
    return ControlRoute.parse(config.route);
  };
  /** A rig's call to the bridge, with the capability its route carries unless given another. */
  const call = async (
    capability?: string,
    model = MODEL,
    o: { path?: string; body?: unknown; headers?: Record<string, string> } = {},
  ) => {
    const path =
      o.path ?? `/v1/google-gemini/${NAME}/models/${model}:streamGenerateContent?alt=sse`;
    return await stack.control.request(path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": capability ?? (await route()).api_key,
        ...o.headers,
      },
      body: JSON.stringify(o.body ?? BODY),
    });
  };
  return {
    ...stack,
    google,
    keys,
    route,
    call,
    async close() {
      await google.close();
      stack.store.db.close();
    },
  };
}

test("a rig's route is control's bridge and a capability; its call streams Google's chunks", async () => {
  const f = await fixture();
  try {
    const route = await f.route();
    // The rig's route names the kind, control's bridge and a capability: never the key.
    assert.equal(route.type, "google-gemini-api");
    assert.equal(route.harness, "pi");
    assert.equal(route.base_url, `http://localhost:8800/v1/google-gemini/${NAME}`);
    assert.notEqual(route.api_key, KEY);
    assert.ok(!JSON.stringify(route).includes(KEY));
    const thought = {
      candidates: [
        {
          content: {
            role: "model",
            parts: [{ functionCall: { name: "answer", args: { n: 7 } }, thoughtSignature: "c2ln" }],
          },
        },
      ],
    };
    f.google.answers.push({ kind: "stream", chunks: [thought, finalChunk(USAGE)] });
    const response = await f.call();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(
      await response.text(),
      `data: ${JSON.stringify(thought)}\n\ndata: ${JSON.stringify(finalChunk(USAGE))}\n\n`,
    );
    assert.equal(f.google.content()[0]?.key, KEY);
    assert.equal(f.keys.status().ledger?.spent, 800);
  } finally {
    await f.close();
  }
});

test("the bridge takes only the route's capability: no token and no Google key opens it", async () => {
  const f = await fixture();
  try {
    for (const wrong of ["", "wrong", KEY, RIG_TOKEN, ADMIN]) {
      const response = await f.call(wrong);
      assert.equal(response.status, 401, wrong);
      assert.ok(!(await response.text()).includes(KEY));
    }
    // The capability sent as a bearer token or in the address opens nothing either.
    const capability = (await f.route()).api_key;
    assert.equal(
      (await f.call("", MODEL, { headers: { authorization: `Bearer ${capability}` } })).status,
      401,
    );
    const inQuery = `/v1/google-gemini/${NAME}/models/${MODEL}:streamGenerateContent?alt=sse&key=${capability}`;
    assert.equal((await f.call("", MODEL, { path: inQuery })).status, 400);
    // A capability of an earlier key stops when the key is replaced.
    f.keys.add(NAME, `${KEY}-next`, true, "owner:ui");
    assert.equal((await f.call(capability)).status, 401);
    assert.equal(f.google.calls.length, 0);
    assert.equal(f.keys.status().ledger?.spent, 0);
  } finally {
    await f.close();
  }
});

test("the bridge takes one method and one checked body: nothing else reaches Google", async () => {
  const f = await fixture();
  try {
    const base = `/v1/google-gemini/${NAME}/models/${MODEL}`;
    for (const path of [
      `${base}:generateContent?alt=sse`,
      `${base}:streamGenerateContent`,
      `${base}:streamGenerateContent?alt=json`,
      `${base}:streamGenerateContent?alt=sse&alt=sse`,
      `${base}:countTokens?alt=sse`,
      `/v1/google-gemini/Not%20A%20Name/models/${MODEL}:streamGenerateContent?alt=sse`,
    ])
      assert.equal((await f.call(undefined, MODEL, { path })).status, 400, path);
    for (const body of [
      { ...BODY, tools: [{ codeExecution: {} }] },
      { ...BODY, tools: [{ googleSearch: {} }] },
      { ...BODY, cachedContent: "cachedContents/fixture" },
      { ...BODY, serviceTier: "priority" },
      { contents: [{ parts: [{ fileData: { fileUri: "https://example.invalid/x" } }] }] },
      { contents: [{ parts: [{ inlineData: { mimeType: "image/png", data: "AA==" } }] }] },
      "not an object",
    ])
      assert.equal((await f.call(undefined, MODEL, { body })).status, 400, JSON.stringify(body));
    assert.equal(f.google.calls.length, 0);
    assert.equal(f.keys.status().ledger?.spent, 0);
  } finally {
    await f.close();
  }
});

test("a rate limit is answered as one before the stream's headers, and the agent waits instead of stopping", async () => {
  const f = await fixture();
  try {
    f.google.answers.push({ kind: "status", status: 429 });
    const response = await f.call();
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("retry-after"), "60");
    const read = classifyProviderError(await response.text(), {
      status: response.status,
      headers: { "retry-after": "60" },
    });
    assert.equal(read.kind, "rate_limit");
    assert.equal(stopsAgents(read.kind), false);
    assert.ok(read.retryAt);
    // A rate limit is no proof that nothing was billed: its reservation is kept.
    const ledger = f.keys.status().ledger;
    assert.ok(ledger && ledger.spent > 0 && ledger.uncertain === 1 && ledger.reserved === 0);
  } finally {
    await f.close();
  }
});

test("at the cap the bridge answers no credits, the agents stop, and no other provider is called", async () => {
  const f = await fixture();
  try {
    // Other providers control could reach, were it to look for one.
    f.store.modelProviders.put({
      name: "other-lab",
      type: "openai",
      base_url: "https://models.example.com/v1",
      key: { sealed: f.parts.secrets.seal("another-made-up-key"), hint: "…-key" },
    });
    f.store.modelProviders.setModels("other-lab", [{ id: MODEL }]);
    f.keys.setCap(0.000001, "owner:ui");
    for (let i = 0; i < 3; i++) {
      const response = await f.call();
      assert.equal(response.status, 402);
      assert.equal(response.headers.get("retry-after"), null);
      const words = await response.text();
      assert.match(words, /spend cap/u);
      assert.match(words, /No other provider is tried/u);
      const read = classifyProviderError(words, { status: response.status, headers: {} });
      assert.equal(read.kind, "credits");
      assert.equal(stopsAgents(read.kind), true);
      // The words alone read the same, as Pi gives them without the status.
      assert.equal(classifyProviderError(words).kind, "credits");
    }
    assert.deepEqual(f.google.calls, []);
    assert.deepEqual(f.google.elsewhere, []);
    assert.equal(f.keys.status().ledger?.spent, 0);
    // With the cap's setting gone the answer is the same kind, in its own words.
    f.store.ownSettings.set("gemini_api_cap_micro_usd", null, "test");
    const uncapped = await f.call();
    assert.equal(uncapped.status, 402);
    const words = await uncapped.text();
    assert.match(words, /no monthly spend cap is set/u);
    assert.equal(classifyProviderError(words).kind, "credits");
    assert.deepEqual(f.google.calls, []);
    // So is the answer while the prices wait for the owner: raised prices that can't be read.
    f.keys.setCap(10, "owner:ui");
    f.store.ownSettings.set("gemini_api_price_overrides", "not JSON", "test");
    const unpriced = await f.call();
    assert.equal(unpriced.status, 402);
    const said = await unpriced.text();
    assert.match(said, /prices need the owner(?:'|\\u0027)s review/u);
    const kind = classifyProviderError(said, { status: 402, headers: {} }).kind;
    assert.equal(kind, "credits");
    assert.equal(stopsAgents(kind), true);
    assert.deepEqual(f.google.calls, []);
  } finally {
    await f.close();
  }
});

test("a call Google fails is answered as failed, once: no retry and no other provider", async () => {
  const f = await fixture();
  try {
    f.store.modelProviders.put({
      name: "other-lab",
      type: "openai",
      base_url: "https://models.example.com/v1",
      key: { sealed: f.parts.secrets.seal("another-made-up-key"), hint: "…-key" },
    });
    const cases = [
      [500, 502, "server"],
      [503, 502, "server"],
      [429, 429, "rate_limit"],
      [401, 401, "auth"],
      [402, 402, "credits"],
      [404, 404, "route"],
    ] as const;
    for (const [google, bridge, kind] of cases) {
      f.google.answers.push({ kind: "status", status: google });
      const response = await f.call();
      assert.equal(response.status, bridge);
      const words = await response.text();
      assert.equal(
        classifyProviderError(words, { status: response.status, headers: {} }).kind,
        kind,
      );
    }
    assert.equal(f.google.content().length, cases.length);
    assert.deepEqual(f.google.elsewhere, []);
    // A model with no price reads as a model this key does not serve: the agents stop.
    f.store.modelProviders.addModel(NAME, "gemini-9-unknown");
    const unpriced = await f.call(undefined, "gemini-9-unknown");
    assert.equal(unpriced.status, 404);
    const read = classifyProviderError(await unpriced.text(), { status: 404, headers: {} });
    assert.equal(read.kind, "route");
    assert.equal(stopsAgents(read.kind), true);
    assert.equal(f.google.content().length, cases.length);
  } finally {
    await f.close();
  }
});

test("a rig that hangs up mid-answer leaves its call settled in full", async () => {
  const f = await fixture();
  try {
    f.google.answers.push({ kind: "hold", chunks: [{ candidates: [], usageMetadata: USAGE }] });
    const closed = f.google.connectionClosed();
    const response = await f.call();
    assert.equal(response.status, 200);
    const reader = response.body?.getReader();
    assert.ok(reader);
    await reader.read();
    const open = f.keys.status().ledger;
    assert.ok(open && open.reserved > 0 && open.spent === 0);
    await reader.cancel();
    await closed;
    const settled = f.keys.status().ledger;
    assert.deepEqual(
      [settled?.spent, settled?.reserved, settled?.uncertain],
      [open.reserved, 0, 1],
    );
  } finally {
    await f.close();
  }
});

test("the key is in no bridge answer, log line, audit entry, rig config or stored row", async (t) => {
  const f = await fixture();
  const lines: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  // Control's log lines are kept; anything else on standard output goes on as it was.
  t.mock.method(process.stdout, "write", (chunk: string | Uint8Array, ...rest: unknown[]) => {
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    if (text.startsWith('{"at":')) {
      lines.push(text);
      return true;
    }
    return (write as (...a: unknown[]) => boolean)(chunk, ...rest);
  });
  const level = setLogLevel("control", "debug");
  try {
    const answers: string[] = [];
    const echo = { error: { code: 400, message: `API key not valid: ${KEY}`, status: KEY } };
    f.google.answers.push(
      { kind: "stream", chunks: [finalChunk(USAGE)] },
      { kind: "status", status: 400, body: echo },
      { kind: "status", status: 401, body: echo },
      { kind: "status", status: 500, body: echo },
      { kind: "stream", chunks: [{ error: { message: KEY } }] },
      { kind: "cut", chunks: [] },
    );
    for (let i = 0; i < 6; i++) {
      const response = await f.call();
      answers.push(
        `${response.status} ${JSON.stringify([...response.headers])} ${await response.text().catch(() => "")}`,
      );
    }
    f.keys.setCap(0, "owner:ui");
    answers.push(await (await f.call()).text());
    f.keys.setCap(10, "owner:ui");
    f.google.list.status = 403;
    await assert.rejects(f.keys.test(NAME, "owner:ui"), (e) => !String(e).includes(KEY));
    // What a rig is given, on every key of its config: its workers', planner's and advisors' routes.
    f.keys.add(NAME, KEY, true, "owner:ui");
    for (const role of ["planner", "teachers", "auditor"] as const)
      f.store.agentModels.assignRole("rig-a", role, { provider: NAME, model: MODEL });
    const config: unknown[] = [];
    for (const key of CONFIG_KEYS) config.push(await f.rigConfig(key));
    const rows = f.store.db
      .prepare("select * from model_provider")
      .all()
      .concat(f.store.db.prepare("select * from control_setting").all());
    const audit = f.store.auditLog.list(500);
    assert.ok(audit.length >= 4 && lines.length >= 4 && rows.length >= 2);
    // The config does hold the key provider's routes, for the workers and for three other roles.
    assert.equal(JSON.stringify(config).split(`/v1/google-gemini/${NAME}`).length - 1, 4);
    for (const [where, text] of [
      ["a bridge answer", answers.join("\n")],
      ["a log line", lines.join("")],
      ["the audit log", JSON.stringify(audit)],
      ["a rig's config", JSON.stringify(config)],
      ["a stored row", JSON.stringify(rows)],
    ] as const)
      assert.ok(!text.includes(KEY), `the key is in ${where}`);
    // The search would have found it: Google's stand-in did receive this very key.
    assert.ok(f.google.calls.length >= 7);
    assert.ok(f.google.calls.every((c) => c.key === KEY));
    assert.equal(f.store.modelProviders.get(NAME)?.key_hint, "Gemini API key");
  } finally {
    setLogLevel("control", level.was);
    await f.close();
  }
});
