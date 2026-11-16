import assert from "node:assert/strict";
import { test } from "node:test";
import { SecretBox } from "../../../src/control/secrets.ts";
import { ADMIN, controlOnly, RIG_TOKEN, signIn } from "../../helpers/control-stack.ts";
import { finalChunk, startGeminiStandIn } from "../../stand-ins/gemini-api/server.ts";

/** The owner's Gemini API key page, on control whole, with the loopback stand-in for Google. */

const PAGE = "/ui/settings/gemini-api";
/** A made-up value in a key's shape: not a key of any service. */
const KEY = "not-a-real-gemini-api-key-fixture";
const NAME = "gemini-api";
const MODEL = "gemini-3.5-flash-lite";
const FORMS = [
  "add",
  "test",
  "disconnect",
  "cap",
  "output",
  "price",
  "prices-reviewed",
  "prices-clear",
];

/** `cap: false` leaves the monthly cap unset, as on a control whose owner has set none. */
async function fixture(o: { cap?: boolean } = {}) {
  const google = await startGeminiStandIn();
  const stack = controlOnly({
    options: {
      secrets: SecretBox.ephemeral(),
      publicUrl: "http://localhost:8800",
      providerFetch: google.fetch,
    },
  });
  // Control runs on the real clock here: the owner has reviewed the prices today.
  stack.parts.geminiApi.reviewPrices("owner:ui");
  const owner = await signIn(stack.control);
  const csrf = owner.csrfOf(await owner.page(PAGE));
  assert.ok(csrf);
  /** Posts a form of the page and returns the page it leads back to. */
  const submit = async (verb: string, form: Record<string, string>) => {
    const response = await owner.post(`${PAGE}/${verb}`, { csrf, ...form });
    assert.equal(response.status, 303, verb);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    const location = response.headers.get("location") ?? "";
    assert.ok(location.startsWith(`${PAGE}?`), location);
    return {
      location,
      kind: location.includes("?ok=") ? "ok" : "error",
      html: await owner.page(location),
    };
  };
  const addKey = () => submit("add", { name: NAME, key: KEY, consent: "1" });
  if (o.cap !== false) assert.equal((await submit("cap", { usd: "10" })).kind, "ok");
  return {
    ...stack,
    google,
    owner,
    csrf,
    submit,
    addKey,
    keys: stack.parts.geminiApi,
    async close() {
      await google.close();
      stack.store.db.close();
    },
  };
}

test("the key page and each of its forms need the owner's session and its form token", async () => {
  const f = await fixture();
  try {
    const form = { name: NAME, key: KEY, consent: "1", usd: "1", tokens: "2048", model: MODEL };
    // No session: the page and the forms lead to the sign-in.
    for (const headers of [
      {},
      { authorization: `Bearer ${RIG_TOKEN}` },
      { authorization: `Bearer ${ADMIN}` },
      { "x-goog-api-key": KEY },
    ] as Record<string, string>[]) {
      const page = await f.control.request(PAGE, { headers });
      assert.equal(page.status, 303);
      assert.equal(page.headers.get("location"), "/ui/login");
      for (const verb of FORMS) {
        const response = await f.control.request(`${PAGE}/${verb}`, {
          method: "POST",
          body: new URLSearchParams({ csrf: f.csrf, ...form }),
          headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
        });
        assert.equal(response.status, 303, verb);
        assert.equal(response.headers.get("location"), "/ui/login");
      }
    }
    // A rig's token signs nobody in.
    const rig = await signIn(f.control, RIG_TOKEN);
    assert.equal((await rig.get(PAGE)).headers.get("location"), "/ui/login");
    assert.equal((await rig.post(`${PAGE}/add`, { csrf: f.csrf, ...form })).status, 303);
    // The owner's session without the page's token, or with another.
    for (const verb of FORMS)
      for (const token of [{}, { csrf: "" }, { csrf: "wrong" }] as Record<string, string>[]) {
        const response = await f.owner.post(`${PAGE}/${verb}`, { ...form, ...token });
        assert.equal(response.status, 403, verb);
        assert.equal(await response.text(), "bad form token");
      }
    assert.equal(f.store.modelProviders.get(NAME), undefined);
    assert.equal(f.keys.status().cap, 10_000_000);
    assert.equal(f.keys.status().outputLimit, 65_536);
    assert.deepEqual(f.google.calls, []);
  } finally {
    await f.close();
  }
});

test("the key is typed into a password field, and no page shows it again", async () => {
  const f = await fixture();
  try {
    const page = await f.owner.get(PAGE);
    assert.equal(page.headers.get("cache-control"), "no-store");
    assert.equal(page.headers.get("referrer-policy"), "no-referrer");
    const empty = await page.text();
    assert.match(empty, /<input name="key" type="password"[^>]*autocomplete="new-password"/u);
    assert.match(empty, /action="\/ui\/settings\/gemini-api\/add"[^>]*autocomplete="off"/u);
    assert.doesNotMatch(empty, /name="key"[^>]*value=/u);
    // The name's pattern is one a browser takes: it compiles it with the v flag, under which a
    // bare hyphen at the end of a character class is an error and the field would check nothing.
    const pattern = /<input name="name"[^>]*pattern="([^"]+)"/u.exec(empty)?.[1];
    assert.ok(pattern);
    const namePattern = new RegExp(`^(?:${pattern})$`, "v");
    assert.ok(namePattern.test("api-provider_2.x"));
    assert.equal(namePattern.test("Bad name"), false);
    const added = await f.addKey();
    assert.equal(added.kind, "ok");
    assert.ok(!added.location.includes(KEY));
    // A key in a shape that is refused is not said back either.
    const typed = "a refused key with spaces 0123456789";
    const refused = await f.submit("add", { name: "second", key: typed, consent: "1" });
    assert.equal(refused.kind, "error");
    assert.equal(f.store.modelProviders.get("second"), undefined);
    const unconsented = await f.submit("add", { name: "second", key: KEY });
    assert.equal(unconsented.kind, "error");
    for (const html of [
      added.html,
      refused.html,
      unconsented.html,
      await f.owner.page(PAGE),
      await f.owner.page("/ui/settings"),
      await f.owner.page("/ui/rigs/rig-a/edit"),
    ]) {
      assert.ok(!html.includes(KEY), "the key is on a page");
      assert.ok(!html.includes(typed), "a refused key is on a page");
    }
    assert.match(added.html, /Its key is sealed in control/u);
    // Adding made no call to Google.
    assert.deepEqual(f.google.calls, []);
  } finally {
    await f.close();
  }
});

test("Test the key asks Google for the model list alone, and keeps the listed models that have a price", async () => {
  const f = await fixture();
  try {
    await f.addKey();
    const generate = ["generateContent", "countTokens"];
    f.google.list.models = [
      { name: `models/${MODEL}`, inputTokenLimit: 1_048_576, supportedGenerationMethods: generate },
      {
        name: "models/gemini-4-argon",
        inputTokenLimit: 1_048_576,
        supportedGenerationMethods: generate,
      },
      { name: "models/gemini-9-unknown", supportedGenerationMethods: generate },
      { name: "models/gemini-embedding-2", supportedGenerationMethods: ["embedContent"] },
    ];
    const tested = await f.submit("test", { name: NAME });
    assert.equal(tested.kind, "ok");
    assert.match(tested.html, /2 of the models it lists have a price[^<]*1 have none/u);
    assert.deepEqual(
      f.google.calls.map((c) => [c.method, c.path, c.key]),
      [["GET", "/v1beta/models", KEY]],
    );
    assert.deepEqual(
      f.store.modelProviders.get(NAME)?.models.map((m) => [m.id, m.context_window]),
      [
        [MODEL, 1_048_576],
        ["gemini-4-argon", 1_048_576],
      ],
    );
    assert.equal(f.keys.status().ledger?.spent, 0);
    // A key Google refuses: said in Thermite's words, with the models kept as they were.
    f.google.list.status = 403;
    const failed = await f.submit("test", { name: NAME });
    assert.equal(failed.kind, "error");
    assert.match(failed.html, /was not confirmed\. Google(?:'|&#\w+;)s answer: HTTP 401/u);
    assert.ok(!failed.html.includes("stand-in refusal"));
    assert.equal(f.store.modelProviders.get(NAME)?.models.length, 2);
    assert.equal(f.google.content().length, 0);
    assert.deepEqual(f.google.elsewhere, []);
  } finally {
    await f.close();
  }
});

test("the cap is the owner's figure: none until it is set, no key before it, and no amount built in", async () => {
  const f = await fixture({ cap: false });
  try {
    const unset = await f.owner.page(PAGE);
    assert.equal(f.keys.status().cap, undefined);
    assert.match(unset, /No monthly cap is set/u);
    // The cap's field proposes no amount and has no upper bound of Thermite's.
    assert.match(unset, /<input name="usd" type="number" required min="0" step="0\.01" value=""/u);
    assert.doesNotMatch(unset, /name="usd"[^>]*max=/u);
    // No key form before a cap, and a key posted all the same is refused.
    assert.doesNotMatch(unset, /name="key"/u);
    const early = await f.addKey();
    assert.equal(early.kind, "error");
    assert.match(early.html, /Set the monthly spend cap first/u);
    assert.equal(f.store.modelProviders.get(NAME), undefined);
    for (const usd of ["-1", "1e3", "ten", "", "1.0000001", "12345678901"]) {
      assert.equal((await f.submit("cap", { usd })).kind, "error", usd);
      assert.equal(f.keys.status().cap, undefined, usd);
    }
    const set = await f.submit("cap", { usd: "2.50" });
    assert.equal(set.kind, "ok");
    assert.equal(f.keys.status().cap, 2_500_000);
    assert.match(set.html, /cap \$2\.5000/u);
    assert.match(set.html, /name="key"/u);
    assert.equal((await f.addKey()).kind, "ok");
    // Raised and lowered at will: any amount is the owner's to choose.
    for (const [usd, micros] of [
      ["250", 250_000_000],
      ["100000", 100_000_000_000],
      ["0", 0],
      ["10", 10_000_000],
    ] as const) {
      assert.equal((await f.submit("cap", { usd })).kind, "ok", usd);
      assert.equal(f.keys.status().cap, micros, usd);
    }
    const audit = f.store.auditLog.list(50).filter((a) => a.action === "gemini_api_cap_set");
    assert.equal(audit.length, 5);
    for (const tokens of ["1023", "65537", "many"])
      assert.equal((await f.submit("output", { tokens })).kind, "error", tokens);
    assert.equal((await f.submit("output", { tokens: "8192" })).kind, "ok");
    assert.equal(f.keys.status().outputLimit, 8192);
    assert.deepEqual(f.google.calls, []);
  } finally {
    await f.close();
  }
});

test("a price can be raised on the page, not lowered, and only for a model in the table", async () => {
  const f = await fixture();
  try {
    const priceOf = () => f.keys.status().prices.find((p) => p.model === MODEL)?.tariff.rates;
    const table = priceOf();
    assert.ok(table);
    const low = await f.submit("price", { model: MODEL, input: "0", output: "0", cached: "0" });
    assert.equal(low.kind, "ok");
    assert.deepEqual(priceOf(), table);
    await f.submit("price", { model: MODEL, input: "1", output: "9", cached: "0.5" });
    assert.deepEqual(priceOf(), { input: 1, output: 9, cached: 0.5 });
    assert.equal((await f.submit("price", { model: MODEL, input: "1" })).kind, "error");
    assert.equal(
      (await f.submit("price", { model: "gemini-9-unknown", input: "1", output: "1", cached: "1" }))
        .kind,
      "error",
    );
    await f.submit("price", { model: MODEL, clear: "1" });
    assert.deepEqual(priceOf(), table);
  } finally {
    await f.close();
  }
});

test("Providers' own forms can't make a Gemini API key, retype it or give it another address", async () => {
  const f = await fixture();
  try {
    await f.addKey();
    const before = f.store.modelProviders.get(NAME);
    assert.ok(before);
    const elsewhere = "https://elsewhere.example/v1";
    for (const [path, form] of [
      [
        "/ui/settings/add",
        { name: "made-here", type: "google-gemini-api", api_key: KEY, base_url: elsewhere },
      ],
      ["/ui/settings/providers", { name: NAME, type: "openai", base_url: elsewhere }],
      [
        "/ui/settings/providers",
        { name: NAME, type: "google-gemini-api", base_url: elsewhere, api_key: KEY },
      ],
      ["/ui/settings/add", { name: NAME, type: "anthropic", api_key: "another-made-up-key" }],
      [`/ui/settings/providers/${NAME}/models`, { model: "gemini-9-unknown" }],
    ] as const) {
      const response = await f.owner.post(path, { csrf: f.csrf, ...form });
      assert.equal(response.status, 303, path);
      assert.match(response.headers.get("location") ?? "", /\?error=/u, path);
    }
    assert.equal(f.store.modelProviders.get("made-here"), undefined);
    assert.deepEqual(f.store.modelProviders.get(NAME), before);
    assert.equal(before.type, "google-gemini-api");
    assert.equal(before.base_url, `http://localhost:8800/v1/google-gemini/${NAME}`);
    // Refresh models, on Providers, calls nobody for this kind and leaves its list as it is.
    const refresh = await f.owner.post(`/ui/settings/providers/${NAME}/refresh`, { csrf: f.csrf });
    assert.match(refresh.headers.get("location") ?? "", /\?error=/u);
    assert.deepEqual(f.store.modelProviders.get(NAME), before);
    assert.deepEqual(f.google.calls, []);
    assert.deepEqual(f.google.elsewhere, []);
  } finally {
    await f.close();
  }
});

test("the page shows what was spent, what is reserved and the cap", async () => {
  const f = await fixture();
  try {
    await f.addKey();
    const provider = f.store.modelProviders.get(NAME);
    assert.ok(provider);
    const body = { contents: [{ role: "user" as const, parts: [{ text: "fresh fixture" }] }] };
    f.google.answers.push({
      kind: "stream",
      chunks: [
        finalChunk({ promptTokenCount: 1000, candidatesTokenCount: 200, totalTokenCount: 1200 }),
      ],
    });
    for await (const _ of f.keys.generate(provider, MODEL, body, new AbortController().signal));
    // A call still open shows as reserved.
    f.google.answers.push({ kind: "hold", chunks: [{ candidates: [] }] });
    const controller = new AbortController();
    const open = f.keys.generate(provider, MODEL, body, controller.signal);
    await open.next();
    const running = await f.owner.page(PAGE);
    assert.match(
      running,
      /Spent \$0\.0008<\/b> · reserved by 1 open call \$0\.1\d{3} · cap \$10\.0000 · left \$9\.8\d{3}/u,
    );
    assert.match(running, new RegExp(`<td>${NAME}</td><td class="num">\\$0\\.0008</td>`, "u"));
    controller.abort();
    await assert.rejects(open.next());
    // Broken off: the whole reservation is charged, and the page counts it as such.
    const after = await f.owner.page(PAGE);
    assert.match(after, /reserved by 0 open calls \$0\.0000/u);
    assert.match(after, /2 calls counted this month; 1 of them charged their whole reservation/u);
    assert.match(after, /What the cap covers/u);
    // A ledger that can't be read is said, not shown as nothing spent.
    f.store.ownSettings.set("gemini_api_ledger", "not json", "test");
    assert.match(await f.owner.page(PAGE), /The spend ledger can(?:'|&#\w+;)t be read/u);
  } finally {
    await f.close();
  }
});

test("prices that stop every call are said at the top of the page, each with the owner's action that ends it", async () => {
  const f = await fixture();
  try {
    await f.addKey();
    const fine = await f.owner.page(PAGE);
    assert.doesNotMatch(
      fine,
      /The prices need your review|raised prices can(?:'|&#\w+;)t be read/u,
    );
    assert.match(fine, /These prices count until <b>\d{4}-\d{2}-\d{2}<\/b> \(UTC\)/u);
    // Raised prices that can't be read: said, with Clear, which is the owner's own act.
    await f.submit("price", { model: MODEL, input: "1", output: "9", cached: "0.5" });
    f.store.ownSettings.set("gemini_api_price_overrides", "not JSON", "test");
    const unreadable = await f.owner.page(PAGE);
    assert.match(unreadable, /<h2>The raised prices can(?:'|&#\w+;)t be read<\/h2>/u);
    assert.match(unreadable, /action="\/ui\/settings\/gemini-api\/prices-clear"/u);
    assert.equal((await f.submit("price", { model: MODEL, clear: "1" })).kind, "error");
    assert.equal(f.store.ownSettings.get("gemini_api_price_overrides")?.value, "not JSON");
    const cleared = await f.submit("prices-clear", {});
    assert.equal(cleared.kind, "ok");
    assert.doesNotMatch(cleared.html, /<h2>The raised prices can/u);
    assert.equal(f.keys.status().pricesReadable, true);
    // Prices last reviewed too long ago: said, with the review that makes them count again.
    f.store.ownSettings.set("gemini_api_prices_reviewed", "2020-01-01", "test");
    const old = new Date(Date.parse("2026-11-16T00:00:00Z") + 30 * 86_400_000);
    if (Date.now() >= old.getTime()) {
      const stale = await f.owner.page(PAGE);
      assert.match(stale, /<h2>The prices need your review<\/h2>/u);
      assert.equal(f.keys.status().pricesFresh, false);
    }
    const reviewed = await f.submit("prices-reviewed", {});
    assert.equal(reviewed.kind, "ok");
    assert.equal(f.keys.status().pricesFresh, true);
    assert.doesNotMatch(reviewed.html, /<h2>The prices need your review<\/h2>/u);
    const audit = f.store.auditLog.list(50).map((a) => a.action);
    assert.ok(audit.includes("gemini_api_prices_reviewed"));
    assert.ok(audit.includes("gemini_api_prices_cleared"));
    assert.deepEqual(f.google.calls, []);
  } finally {
    await f.close();
  }
});
