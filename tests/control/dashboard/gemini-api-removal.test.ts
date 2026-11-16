import assert from "node:assert/strict";
import { test } from "node:test";
import { SecretBox } from "../../../src/control/secrets.ts";
import { ControlRoute } from "../../../src/core/api/model-route.ts";
import { ADMIN, controlOnly, RIG_TOKEN, signIn } from "../../helpers/control-stack.ts";
import { startGeminiStandIn } from "../../stand-ins/gemini-api/server.ts";

/**
 * Removing a Gemini API key as the owner does it: Disconnect on the key page and Disconnect and
 * delete on Providers, on control whole, with the loopback stand-in for Google. Each state a
 * provider can be in has a notice that says what it is and the actions that end it.
 */

const PAGE = "/ui/settings/gemini-api";
const PROVIDERS = "/ui/settings";
/** A made-up value in a key's shape: not a key of any service. */
const KEY = "not-a-real-gemini-api-key-fixture";
const NAME = "gemini-api";
const MODEL = "gemini-3.5-flash-lite";
const BODY = { contents: [{ role: "user" as const, parts: [{ text: "fresh fixture" }] }] };
const DELETE = `/ui/settings/providers/${NAME}/delete`;

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
  const owner = await signIn(stack.control);
  const csrf = owner.csrfOf(await owner.page(PAGE));
  assert.ok(csrf);
  /** Posts a form and returns the page it leads back to, and whether it said done or not done. */
  const submit = async (path: string, form: Record<string, string> = {}) => {
    const response = await owner.post(path, { csrf, ...form });
    assert.equal(response.status, 303, path);
    const location = response.headers.get("location") ?? "";
    return {
      location,
      kind: location.includes("?ok=") ? "ok" : "error",
      html: await owner.page(location),
    };
  };
  const provider = () => {
    const p = stack.store.modelProviders.get(NAME);
    assert.ok(p, "the provider is listed");
    return p;
  };
  /** A rig's call to the bridge with a capability. */
  const bridge = (capability: string) =>
    stack.control.request(
      `/v1/google-gemini/${NAME}/models/${MODEL}:streamGenerateContent?alt=sse`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": capability },
        body: JSON.stringify(BODY),
      },
    );
  /** The capability the rig's route carries now; undefined when control gives the rig no route. */
  const routed = async () => {
    const config = await stack.rigConfig("model-route");
    return config.route ? ControlRoute.parse(config.route).api_key : undefined;
  };
  /** The provider's card on the key page: from its heading to the next card's. */
  const cardOf = (html: string) => {
    const from = html.indexOf(`<h2>${NAME}`);
    assert.ok(from >= 0, "the provider has a card");
    const to = html.indexOf("<section", from);
    return html.slice(from, to < 0 ? undefined : to);
  };
  /** The provider's row on Providers. */
  const rowOf = (html: string) => {
    const from = html.indexOf(`data-k="provider-${NAME}"`);
    assert.ok(from >= 0, "the provider has a row");
    return html.slice(from, html.indexOf("</details>", from));
  };
  const sealedKeys = () =>
    Object.keys(
      JSON.parse(stack.store.ownSettings.get("gemini_api_keys")?.value ?? "{}") as object,
    );
  return {
    ...stack,
    google,
    keys,
    owner,
    csrf,
    submit,
    provider,
    bridge,
    routed,
    cardOf,
    rowOf,
    sealedKeys,
    async close() {
      await google.close();
      stack.store.db.close();
    },
  };
}

test("Disconnect on the key page says what it did, stops the rig's route, and leaves a card that says disconnected with its next actions", async () => {
  const f = await fixture();
  try {
    f.store.agentModels.assignRig("rig-a", { provider: NAME, model: MODEL, harness: "pi" });
    const capability = await f.routed();
    assert.ok(capability);
    assert.equal((await f.bridge(capability)).status, 200);
    const connected = f.cardOf(await f.owner.page(PAGE));
    assert.match(connected, /Its key is sealed in control/u);
    assert.match(connected, /action="\/ui\/settings\/gemini-api\/disconnect"/u);
    const done = await f.submit(`${PAGE}/disconnect`, { name: NAME });
    assert.equal(done.kind, "ok");
    assert.match(done.html, /is disconnected: Thermite holds no key for it/u);
    assert.match(done.html, /Its rigs keep their models for a new key/u);
    // The card changed shape: it says disconnected, offers a new key, and no Disconnect or Test.
    const card = f.cardOf(done.html);
    assert.match(card, new RegExp(`<h2>${NAME}: disconnected</h2>`, "u"));
    assert.match(card, /Add a key under this name/u);
    assert.doesNotMatch(card, /gemini-api\/disconnect|gemini-api\/test/u);
    // The rig keeps its model, gets no route, and its old capability opens nothing.
    assert.equal(f.store.agentModels.byRig()["rig-a"]?.provider, NAME);
    assert.equal(await f.routed(), undefined);
    assert.equal((await f.bridge(capability)).status, 401);
    assert.equal(f.provider().key_sealed, "");
    assert.deepEqual(f.sealedKeys(), []);
    // In use: deleting waits for the rig to get another model, and says which rig.
    assert.match(card, /In use by rig-a/u);
    assert.doesNotMatch(card, /providers\/gemini-api\/delete/u);
    const row = f.rowOf(await f.owner.page(PROVIDERS));
    assert.match(row, /Disconnected: no key/u);
    assert.match(row, /In use by rig-a/u);
    // Providers and the page never show the key.
    for (const html of [done.html, await f.owner.page(PROVIDERS)]) assert.ok(!html.includes(KEY));
    // The link's name fills the form, and a key added under it connects the provider again.
    const prefilled = await f.owner.page(`${PAGE}?name=${NAME}`);
    assert.match(prefilled, new RegExp(`<input name="name"[^>]*value="${NAME}"`, "u"));
    assert.doesNotMatch(
      await f.owner.page(`${PAGE}?name=%22%3E%3Cscript%3E`),
      /<input name="name"[^>]*value="[^"]/u,
    );
    const again = await f.submit(`${PAGE}/add`, { name: NAME, key: KEY, consent: "1" });
    assert.equal(again.kind, "ok");
    const next = await f.routed();
    assert.ok(next && next !== capability);
    assert.equal((await f.bridge(next)).status, 200);
    assert.equal((await f.bridge(capability)).status, 401);
  } finally {
    await f.close();
  }
});

test("Disconnect pressed again is answered as already done, not as an error", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.submit(`${PAGE}/disconnect`, { name: NAME })).kind, "ok");
    for (let i = 0; i < 2; i++) {
      const again = await f.submit(`${PAGE}/disconnect`, { name: NAME });
      assert.equal(again.kind, "ok");
      assert.match(again.html, /was already disconnected/u);
      assert.match(f.cardOf(again.html), /: disconnected<\/h2>/u);
    }
    const entries = f.store.auditLog.list(100).filter((a) => a.action === "gemini_api_key_removed");
    assert.equal(entries.length, 1);
    // A name that is no Gemini API key is refused, and a provider of another kind is untouched.
    f.store.modelProviders.put({ name: "other", type: "openai", base_url: "http://m.example/v1" });
    for (const name of ["other", "never-added", ""]) {
      const refused = await f.submit(`${PAGE}/disconnect`, { name });
      assert.equal(refused.kind, "error", name);
    }
    assert.ok(f.store.modelProviders.get("other"));
  } finally {
    await f.close();
  }
});

test("Disconnect says how many calls in flight it broke off, and they stay charged", async () => {
  const f = await fixture();
  try {
    f.google.answers.push({ kind: "hold", chunks: [{ candidates: [] }] });
    const closed = f.google.connectionClosed();
    const running = f.keys.generate(f.provider(), MODEL, BODY, new AbortController().signal);
    await running.next();
    const reserved = f.keys.status().ledger?.reserved ?? 0;
    assert.ok(reserved > 0);
    const done = await f.submit(`${PAGE}/disconnect`, { name: NAME });
    assert.equal(done.kind, "ok");
    assert.match(
      done.html,
      /1 call in flight was broken off, and is charged its whole reservation/u,
    );
    await assert.rejects(running.next());
    await closed;
    const ledger = f.keys.status().ledger;
    assert.deepEqual([ledger?.spent, ledger?.reserved, ledger?.uncertain], [reserved, 0, 1]);
  } finally {
    await f.close();
  }
});

test("a removal the store could not save is said, shows as not finished with the action that finishes it, and that action finishes it", async () => {
  const f = await fixture();
  try {
    const capability = (() => {
      const route = f.keys.route(f.provider());
      assert.ok(route);
      return route.key;
    })();
    // The store's next write of the sealed keys fails, as a full or locked disk does.
    const settings = f.store.ownSettings;
    const set = settings.set.bind(settings);
    settings.set = (key, value, by) => {
      if (key === "gemini_api_keys") {
        settings.set = set;
        throw new Error("database or disk is full");
      }
      set(key, value, by);
    };
    const failed = await f.submit(`${PAGE}/disconnect`, { name: NAME });
    assert.equal(failed.kind, "error");
    assert.match(failed.html, /The removal could not be saved/u);
    assert.ok(!failed.html.includes("database or disk is full"), "the store's own words are shown");
    const card = f.cardOf(failed.html);
    assert.match(card, new RegExp(`<h2>${NAME}: removal not finished</h2>`, "u"));
    assert.match(card, /Finish removing the key/u);
    assert.match(card, /action="\/ui\/settings\/gemini-api\/disconnect"/u);
    assert.match(f.rowOf(await f.owner.page(PROVIDERS)), /Removal not finished/u);
    // Its calls are refused from that moment, though the store still holds the key.
    assert.equal((await f.bridge(capability)).status, 401);
    assert.deepEqual(f.sealedKeys(), [NAME]);
    assert.equal(f.google.calls.length, 0);
    const finished = await f.submit(`${PAGE}/disconnect`, { name: NAME });
    assert.equal(finished.kind, "ok");
    assert.match(f.cardOf(finished.html), /: disconnected<\/h2>/u);
    assert.deepEqual(f.sealedKeys(), []);
    assert.equal((await f.bridge(capability)).status, 401);
  } finally {
    await f.close();
  }
});

test("a key that can't be opened shows as such, and Disconnect ends it", async () => {
  const f = await fixture();
  try {
    f.store.ownSettings.set("gemini_api_keys", JSON.stringify({ [NAME]: "s1:damaged" }), "test");
    const card = f.cardOf(await f.owner.page(PAGE));
    assert.match(card, /its key can(?:'|&#\w+;)t be opened<\/h2>/u);
    assert.match(card, /action="\/ui\/settings\/gemini-api\/disconnect"/u);
    assert.match(card, /Add a key under this name/u);
    assert.match(f.rowOf(await f.owner.page(PROVIDERS)), /Its key can(?:'|&#\w+;)t be opened/u);
    const done = await f.submit(`${PAGE}/disconnect`, { name: NAME });
    assert.equal(done.kind, "ok");
    assert.match(f.cardOf(done.html), /: disconnected<\/h2>/u);
    assert.deepEqual(f.sealedKeys(), []);
  } finally {
    await f.close();
  }
});

test("Disconnect and delete on Providers removes a provider from each state, with its key, and keeps what it spent", async () => {
  const f = await fixture();
  try {
    f.google.answers.push({ kind: "cut", chunks: [] });
    await assert.rejects(async () => {
      for await (const _ of f.keys.generate(
        f.provider(),
        MODEL,
        BODY,
        new AbortController().signal,
      ));
    });
    const spent = f.keys.status().ledger?.spent ?? 0;
    assert.ok(spent > 0);
    /** Brings the provider back, connected, then into the state under test. */
    const states: Record<string, () => void> = {
      connected: () => {},
      disconnected: () => void f.keys.disconnect(NAME, "owner:ui"),
      unusable: () => f.store.modelProviders.setKey(NAME, "s1:damaged"),
      "removal not finished": () => f.store.modelProviders.setKey(NAME, ""),
    };
    for (const [state, enter] of Object.entries(states)) {
      f.keys.add(NAME, KEY, true, "owner:ui");
      enter();
      const row = f.rowOf(await f.owner.page(PROVIDERS));
      assert.match(row, /Key and spend/u, state);
      assert.match(row, new RegExp(`action="${DELETE}"`, "u"), state);
      // The button says what it does: a disconnected provider has nothing left to disconnect.
      assert.match(
        row,
        state === "disconnected" ? />Delete this provider</u : />Disconnect and delete</u,
        state,
      );
      const done = await f.submit(DELETE);
      assert.equal(done.kind, "ok", state);
      assert.match(done.html, /is disconnected and deleted/u, state);
      assert.equal(f.store.modelProviders.get(NAME), undefined, state);
      assert.deepEqual(f.sealedKeys(), [], state);
      assert.ok(!done.html.includes(KEY));
    }
    // What it spent stays counted, by its name, on the key page.
    assert.equal(f.keys.status().ledger?.spent, spent);
    assert.match(await f.owner.page(PAGE), new RegExp(`<td>${NAME}</td>`, "u"));
    // Gone: a second delete says so and changes nothing.
    const gone = await f.submit(DELETE);
    assert.equal(gone.kind, "error");
    const deleted = f.store.auditLog.list(100).filter((a) => a.action === "model_provider_deleted");
    assert.equal(deleted.length, 4);
    assert.ok(deleted.every((a) => (a.body as { key_removed?: boolean }).key_removed === true));
  } finally {
    await f.close();
  }
});

test("Disconnect and delete is refused whole while a rig uses the provider, and its calls go on", async () => {
  const f = await fixture();
  try {
    f.store.agentModels.assignRole("rig-a", "planner", { provider: NAME, model: MODEL });
    const row = f.rowOf(await f.owner.page(PROVIDERS));
    assert.match(row, /In use by rig-a: give that rig another model before deleting it/u);
    assert.doesNotMatch(row, new RegExp(DELETE, "u"));
    const refused = await f.submit(DELETE);
    assert.equal(refused.kind, "error");
    assert.match(refused.html, /is still in use/u);
    const route = f.keys.route(f.provider());
    assert.ok(route, "its key and capability are as they were");
    assert.equal((await f.bridge(route.key)).status, 200);
    assert.deepEqual(f.sealedKeys(), [NAME]);
  } finally {
    await f.close();
  }
});

test("only the owner's session with its form token disconnects or deletes", async () => {
  const f = await fixture();
  try {
    const form = { csrf: f.csrf, name: NAME };
    for (const path of [`${PAGE}/disconnect`, DELETE]) {
      for (const headers of [
        {},
        { authorization: `Bearer ${RIG_TOKEN}` },
        { authorization: `Bearer ${ADMIN}` },
      ] as Record<string, string>[]) {
        const response = await f.control.request(path, {
          method: "POST",
          body: new URLSearchParams(form),
          headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
        });
        assert.equal(response.status, 303, path);
        assert.equal(response.headers.get("location"), "/ui/login", path);
      }
      for (const token of [{}, { csrf: "" }, { csrf: "wrong" }] as Record<string, string>[]) {
        const response = await f.owner.post(path, { name: NAME, ...token });
        assert.equal(response.status, 403, path);
      }
    }
    assert.equal(f.keys.state(f.provider()), "connected");
    assert.deepEqual(f.sealedKeys(), [NAME]);
  } finally {
    await f.close();
  }
});
