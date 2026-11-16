import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GeminiApiError } from "../../../../src/control/providers/gemini-api/index.ts";
import {
  GEMINI_INPUT_ALLOWANCE,
  GEMINI_OUTPUT_CEILING,
} from "../../../../src/control/providers/gemini-api/prices.ts";
import { ControlStore } from "../../../../src/control/store/index.ts";
import { BODY, KEY, type KeysFixture, keysFixture, MODEL, NAME } from "./fixture.ts";

/**
 * Removing a Gemini API key: Disconnect (the key goes, the provider stays listed) and Disconnect
 * and delete, from every state a provider can be in, with the store failing, with a call in
 * flight and across a restart. What was spent is never given back.
 */

/** The fixture call's worst case at the default output limit, in micro-dollars. */
const WORST =
  Math.ceil(
    (Buffer.byteLength(
      JSON.stringify({ ...BODY, generationConfig: { maxOutputTokens: GEMINI_OUTPUT_CEILING } }),
    ) +
      GEMINI_INPUT_ALLOWANCE) *
      0.3,
  ) + Math.ceil(GEMINI_OUTPUT_CEILING * 2.5);

const add = (f: KeysFixture, name = NAME) => f.keys.add(name, KEY, true, "owner:ui");
const reasonOf = (error: unknown) => {
  assert.ok(error instanceof GeminiApiError, `a Gemini API error, not ${String(error)}`);
  return error.reason;
};
/** The sealed keys control holds, by provider name. */
const held = (f: KeysFixture) =>
  Object.keys(
    JSON.parse(f.store.ownSettings.get("gemini_api_keys")?.value ?? "{}") as Record<string, string>,
  );
const audited = (f: KeysFixture, action: string) =>
  f.store.auditLog.list(200).filter((a) => a.action === action);
/** The capability a rig's route carries for the provider now. */
const capability = (f: KeysFixture) => f.keys.route(f.provider())?.key;

/** Makes the store's next write of the sealed keys fail, as a full or locked disk does. */
function failNextKeyWrite(f: KeysFixture): void {
  const settings = f.store.ownSettings;
  const set = settings.set.bind(settings);
  settings.set = (key, value, by) => {
    if (key === "gemini_api_keys") {
      settings.set = set;
      throw new Error("database or disk is full");
    }
    set(key, value, by);
  };
}

test("Disconnect removes the key and the capability at once, keeps the provider listed, and says so in the audit log", async () => {
  const f = await keysFixture();
  try {
    add(f);
    const before = capability(f);
    assert.ok(before);
    assert.equal(f.keys.state(f.provider()), "connected");
    assert.ok(f.keys.authorized(NAME, before));
    assert.deepEqual(f.keys.disconnect(NAME, "owner:ui"), { was: "connected", stopped: 0 });
    assert.equal(f.keys.state(f.provider()), "disconnected");
    // The provider and its models stay, for the rigs that have one and for the next key.
    assert.equal(f.provider().key_sealed, "");
    assert.ok(f.provider().models.length > 0);
    assert.deepEqual(held(f), []);
    // Its route is gone and its old capability opens nothing.
    assert.equal(f.keys.route(f.provider()), undefined);
    assert.equal(f.keys.authorized(NAME, before), undefined);
    assert.equal(f.keys.authorized(NAME, ""), undefined);
    assert.equal(reasonOf((await f.call()).error), "auth");
    assert.equal(f.google.calls.length, 0);
    const [entry] = audited(f, "gemini_api_key_removed");
    assert.deepEqual(entry?.body, { name: NAME, was: "connected", calls_stopped: 0 });
    assert.ok(!JSON.stringify(f.store.auditLog.list(200)).includes(KEY));
  } finally {
    await f.close();
  }
});

test("Disconnect again changes nothing and fails nothing", async () => {
  const f = await keysFixture();
  try {
    add(f);
    f.keys.disconnect(NAME, "owner:ui");
    for (let i = 0; i < 3; i++)
      assert.deepEqual(f.keys.disconnect(NAME, "owner:ui"), { was: "disconnected", stopped: 0 });
    assert.equal(f.keys.state(f.provider()), "disconnected");
    assert.equal(audited(f, "gemini_api_key_removed").length, 1);
  } finally {
    await f.close();
  }
});

test("Disconnect works when the capability or the key can't be opened", async () => {
  const f = await keysFixture();
  try {
    // The row's sealed capability is damaged.
    add(f);
    f.store.modelProviders.setKey(NAME, "s1:damaged");
    assert.equal(f.keys.state(f.provider()), "unusable");
    assert.equal(f.keys.route(f.provider()), undefined);
    assert.equal(f.keys.disconnect(NAME, "owner:ui").was, "unusable");
    assert.equal(f.keys.state(f.provider()), "disconnected");
    assert.deepEqual(held(f), []);
    // The sealed key is damaged: the capability still reads, the key does not.
    add(f);
    f.store.ownSettings.set("gemini_api_keys", JSON.stringify({ [NAME]: "s1:damaged" }), "test");
    assert.equal(f.keys.state(f.provider()), "unusable");
    assert.equal(reasonOf((await f.call()).error), "auth");
    assert.equal(f.keys.disconnect(NAME, "owner:ui").was, "unusable");
    assert.deepEqual(held(f), []);
    // A wholly unreadable map cannot be erased to pretend cleanup succeeded.
    add(f);
    f.store.ownSettings.set("gemini_api_keys", "{not json", "test");
    assert.equal(f.keys.state(f.provider()), "unusable");
    assert.throws(() => f.keys.disconnect(NAME, "owner:ui"), /removal could not be saved/u);
    assert.equal(f.keys.state(f.provider()), "removal_pending");
    assert.equal(f.store.ownSettings.get("gemini_api_keys")?.value, "{not json");
    assert.equal(f.google.calls.length, 0);
  } finally {
    await f.close();
  }
});

test("a key left sealed beside a provider without a capability is a removal to finish, and Disconnect finishes it", async () => {
  const f = await keysFixture();
  try {
    add(f);
    // The state a removal interrupted between its two writes would leave.
    f.store.modelProviders.setKey(NAME, "");
    assert.deepEqual(held(f), [NAME]);
    assert.equal(f.keys.state(f.provider()), "removal_pending");
    assert.equal(reasonOf((await f.call()).error), "auth");
    assert.equal(f.keys.disconnect(NAME, "owner:ui").was, "removal_pending");
    assert.equal(f.keys.state(f.provider()), "disconnected");
    assert.deepEqual(held(f), []);
    assert.equal(f.google.calls.length, 0);
  } finally {
    await f.close();
  }
});

test("a removal the store refuses stops the provider at once, changes nothing in the store, and is finished by asking again", async () => {
  const f = await keysFixture();
  try {
    add(f);
    const before = capability(f);
    assert.ok(before);
    f.google.answers.push({ kind: "hold", chunks: [{ candidates: [] }] });
    const closed = f.google.connectionClosed();
    const running = f.keys.generate(f.provider(), MODEL, BODY, new AbortController().signal);
    await running.next();
    failNextKeyWrite(f);
    assert.throws(() => f.keys.disconnect(NAME, "owner:ui"), /remove it again to finish/u);
    // The store kept all of it: the transaction took neither the row's change nor an audit entry.
    assert.notEqual(f.provider().key_sealed, "");
    assert.deepEqual(held(f), [NAME]);
    assert.equal(audited(f, "gemini_api_key_removed").length, 0);
    // But the provider is stopped here: its call is broken off and no new one is taken.
    await assert.rejects(running.next());
    await closed;
    assert.equal(f.keys.state(f.provider()), "removal_pending");
    assert.equal(f.keys.route(f.provider()), undefined);
    assert.equal(f.keys.authorized(NAME, before), undefined);
    assert.equal(reasonOf((await f.call()).error), "auth");
    assert.equal(f.google.content().length, 1);
    // The call broken off is charged its whole reservation.
    assert.deepEqual([f.ledger().spent, f.ledger().reserved], [WORST, 0]);
    // Asked again, the removal finishes, with one audit entry.
    assert.deepEqual(f.keys.disconnect(NAME, "owner:ui"), { was: "removal_pending", stopped: 0 });
    assert.equal(f.keys.state(f.provider()), "disconnected");
    assert.deepEqual(held(f), []);
    assert.equal(audited(f, "gemini_api_key_removed").length, 1);
    // A key added again works, under a new capability; the old one stays refused.
    add(f);
    assert.equal(f.keys.state(f.provider()), "connected");
    assert.notEqual(capability(f), before);
    assert.equal(f.keys.authorized(NAME, before), undefined);
    assert.equal((await f.call()).error, undefined);
  } finally {
    await f.close();
  }
});

test("a delete the store refuses leaves the provider stopped and listed, and deleting again finishes", async () => {
  const f = await keysFixture();
  try {
    add(f);
    failNextKeyWrite(f);
    assert.throws(() => f.keys.remove(NAME, "owner:ui"), /remove it again to finish/u);
    assert.ok(f.store.modelProviders.get(NAME), "the row's delete was rolled back");
    assert.deepEqual(held(f), [NAME]);
    assert.equal(f.keys.state(f.provider()), "removal_pending");
    assert.equal(reasonOf((await f.call()).error), "auth");
    assert.equal(f.keys.remove(NAME, "owner:ui"), "deleted");
    assert.equal(f.store.modelProviders.get(NAME), undefined);
    assert.deepEqual(held(f), []);
    assert.equal(audited(f, "model_provider_deleted").length, 1);
    assert.equal(f.google.calls.length, 0);
  } finally {
    await f.close();
  }
});

test("Disconnect and delete removes the provider and its key from every state, and is refused whole while a rig uses it", async () => {
  const f = await keysFixture();
  try {
    // While a rig has one of its models: nothing changes, and its calls go on.
    add(f);
    f.store.agentModels.assignRig("rig-1", { provider: NAME, model: MODEL });
    assert.equal(f.keys.remove(NAME, "owner:ui"), "in_use");
    assert.equal(f.keys.state(f.provider()), "connected");
    assert.deepEqual(held(f), [NAME]);
    assert.equal((await f.call()).error, undefined);
    assert.equal(audited(f, "model_provider_deleted").length, 0);
    f.store.agentModels.assignRig("rig-1", null);
    // Connected.
    assert.equal(f.keys.remove(NAME, "owner:ui"), "deleted");
    assert.equal(f.store.modelProviders.get(NAME), undefined);
    assert.deepEqual(held(f), []);
    assert.deepEqual(audited(f, "model_provider_deleted")[0]?.body, {
      name: NAME,
      type: "google-gemini-api",
      key_removed: true,
      calls_stopped: 0,
    });
    // Already disconnected.
    add(f);
    f.keys.disconnect(NAME, "owner:ui");
    assert.equal(f.keys.remove(NAME, "owner:ui"), "deleted");
    // Unusable, and a removal to finish.
    add(f);
    f.store.modelProviders.setKey(NAME, "s1:damaged");
    assert.equal(f.keys.remove(NAME, "owner:ui"), "deleted");
    add(f);
    f.store.modelProviders.setKey(NAME, "");
    assert.equal(f.keys.remove(NAME, "owner:ui"), "deleted");
    assert.deepEqual(held(f), []);
    // Gone already, and a provider of another kind.
    assert.equal(f.keys.remove(NAME, "owner:ui"), "missing");
    f.store.modelProviders.put({ name: "other", type: "openai", base_url: "http://m.example/v1" });
    assert.throws(() => f.keys.remove("other", "owner:ui"), /No Gemini API key/u);
    assert.throws(() => f.keys.disconnect("other", "owner:ui"), /No Gemini API key/u);
    assert.throws(() => f.keys.disconnect("never-added", "owner:ui"), /No Gemini API key/u);
    assert.ok(f.store.modelProviders.get("other"));
  } finally {
    await f.close();
  }
});

test("removing the key breaks off its call in flight, which keeps its whole reservation", async () => {
  const f = await keysFixture();
  try {
    for (const removal of ["disconnect", "remove"] as const) {
      add(f);
      f.google.answers.push({
        kind: "hold",
        chunks: [{ candidates: [], usageMetadata: { promptTokenCount: 5, totalTokenCount: 5 } }],
      });
      const closed = f.google.connectionClosed();
      const cut = f.keys.generate(f.provider(), MODEL, BODY, new AbortController().signal);
      await cut.next();
      const spent = f.ledger().spent;
      if (removal === "disconnect")
        assert.deepEqual(f.keys.disconnect(NAME, "owner:ui"), { was: "connected", stopped: 1 });
      else assert.equal(f.keys.remove(NAME, "owner:ui"), "deleted");
      await assert.rejects(cut.next());
      await closed;
      // Its cost is not known: all of its reservation is charged, none of it given back.
      assert.deepEqual([f.ledger().spent, f.ledger().reserved], [spent + WORST, 0]);
    }
    assert.equal(f.ledger().uncertain, 2);
  } finally {
    await f.close();
  }
});

test("a removed key, a deleted provider and one added again under the same or another name do not reset what was spent", async () => {
  const f = await keysFixture();
  try {
    add(f);
    f.keys.setCap((WORST + 10) / 1e6, "owner:ui");
    f.google.answers.push({ kind: "cut", chunks: [] });
    await f.call();
    assert.equal(f.ledger().spent, WORST);
    // The key removed and a new one added under the same name.
    f.keys.disconnect(NAME, "owner:ui");
    assert.equal(f.ledger().spent, WORST);
    add(f);
    assert.equal(reasonOf((await f.call()).error), "cap");
    // The provider deleted and added again, under the same name and under another.
    assert.equal(f.keys.remove(NAME, "owner:ui"), "deleted");
    assert.equal(f.ledger().spent, WORST);
    add(f);
    assert.equal(reasonOf((await f.call()).error), "cap");
    add(f, "another-name");
    assert.equal(reasonOf((await f.call(f.keys, BODY, MODEL, "another-name")).error), "cap");
    assert.equal(f.google.content().length, 1);
    assert.deepEqual(f.ledger().by, [{ provider: NAME, spent: WORST }]);
  } finally {
    await f.close();
  }
});

test("a removal holds across a restart, and a sealed key left without its provider is removed at start", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-removal-"));
  const path = join(dir, "control.db");
  const first = new ControlStore(path);
  const f = await keysFixture({ store: first });
  try {
    add(f);
    add(f, "kept");
    f.keys.disconnect(NAME, "owner:ui");
    // A sealed key whose provider row is gone, and one whose provider holds no capability.
    add(f, "row-gone");
    first.db.prepare("delete from model_provider where name = ?").run("row-gone");
    add(f, "no-capability");
    first.modelProviders.setKey("no-capability", "");
    assert.deepEqual(held(f).sort(), ["kept", "no-capability", "row-gone"]);
    const second = new ControlStore(path);
    const restarted = f.make(second);
    const sealedNow = Object.keys(
      JSON.parse(second.ownSettings.get("gemini_api_keys")?.value ?? "{}") as object,
    );
    assert.deepEqual(sealedNow, ["kept"]);
    const p = second.modelProviders.get(NAME);
    assert.ok(p);
    assert.equal(restarted.state(p), "disconnected");
    assert.equal(restarted.route(p), undefined);
    const kept = second.modelProviders.get("kept");
    assert.ok(kept);
    assert.equal(restarted.state(kept), "connected");
    const swept = second.auditLog
      .list(200)
      .filter((a) => a.action === "gemini_api_key_removed" && a.actor === "control");
    assert.deepEqual(swept.map((a) => (a.body as { name: string }).name).sort(), [
      "no-capability",
      "row-gone",
    ]);
    second.db.close();
  } finally {
    await f.close();
    first.db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a key removed after a call's last chunk and before its stream's end still keeps the whole reservation", async () => {
  const f = await keysFixture();
  try {
    const final = {
      candidates: [{ content: { role: "model", parts: [{ text: "done" }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 200, totalTokenCount: 1200 },
    };
    for (const removal of ["disconnect", "remove"] as const) {
      add(f);
      const spent = f.ledger().spent;
      f.google.answers.push({ kind: "stream", chunks: [final] });
      const running = f.keys.generate(f.provider(), MODEL, BODY, new AbortController().signal);
      // The agent has the whole answer, usage and all, and then the owner removes the key.
      assert.equal((await running.next()).done, false);
      if (removal === "disconnect") f.keys.disconnect(NAME, "owner:ui");
      else assert.equal(f.keys.remove(NAME, "owner:ui"), "deleted");
      await assert.rejects(running.next());
      // Not settled to its reported usage: a call whose key went under it is not a known cost.
      assert.deepEqual([f.ledger().spent, f.ledger().reserved], [spent + WORST, 0]);
    }
    assert.equal(f.ledger().uncertain, 2);
  } finally {
    await f.close();
  }
});

test("one damaged key-map entry cannot erase another provider's key", async () => {
  const f = await keysFixture();
  try {
    add(f);
    add(f, "second");
    const keys = JSON.parse(f.store.ownSettings.get("gemini_api_keys")?.value ?? "{}");
    keys.damaged = { keep: "unknown evidence" };
    f.store.ownSettings.set("gemini_api_keys", JSON.stringify(keys), "owner:fixture");
    assert.equal(f.keys.state(f.provider()), "connected");
    f.keys.disconnect("second", "owner:ui");
    const after = JSON.parse(f.store.ownSettings.get("gemini_api_keys")?.value ?? "{}");
    assert.equal(after[NAME], keys[NAME]);
    assert.deepEqual(after.damaged, keys.damaged);
    assert.equal(Object.hasOwn(after, "second"), false);
    assert.equal(f.keys.state(f.provider()), "connected");
  } finally {
    await f.close();
  }
});
