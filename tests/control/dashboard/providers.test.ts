import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { ModelSource } from "../../../src/harness/agents/model/source.ts";
import { handModelRoute } from "../../../src/supervisor/model-route.ts";
import { heldEvents } from "../../helpers/control-store.ts";
import { stack } from "./stack.ts";

/**
 * A provider with an API key on the settings page: its key sealed, its models listed, and its
 * route given only to the rig that uses one of them.
 */

describe("control dashboard", () => {
  test("a provider's key goes in once on the settings page, sealed; its models are listed; only its rig's harness gets the key", async () => {
    // A fake provider: an OpenAI-compatible one that takes only its key, and Anthropic's API.
    const key = "test-key-never-shown-0001";
    const providerFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const h = new Headers(init?.headers);
      if (url === "https://models.example/v1/models")
        return h.get("authorization") === `Bearer ${key}`
          ? Response.json({
              data: [{ id: "deepseek-v4.1-flash-free", context_length: 262144 }, { id: "other" }],
            })
          : new Response("no", { status: 401 });
      // OpenCode's own list (it needs no key).
      if (url === "https://opencode.ai/zen/v1/models")
        return Response.json({ data: [{ id: "free-model-free" }, { id: "paid-model" }] });
      if (
        url.startsWith("https://api.anthropic.com/v1/models") &&
        h.get("x-api-key") === "sk-ant-x"
      )
        return Response.json({ data: [{ id: "claude-test" }], has_more: false });
      return new Response("no", { status: 404 });
    }) as typeof fetch;
    const s = await stack("owner_approval", { providerFetch });
    const dir = mkdtempSync(join(tmpdir(), "thermite-route-"));
    s.env.service.models = new ModelSource(join(dir, "model-route.json"), undefined);
    await s.relay();
    let page = await (await s.get("/ui/settings")).text();
    assert.match(page, /No provider yet/);
    const csrf = s.csrfFrom(page);
    // A form without the session's token is refused.
    assert.equal((await s.post("/ui/settings/providers", { csrf: "0", name: "x" })).status, 403);
    const where = (r: Response) => decodeURIComponent(r.headers.get("location") ?? "");
    const added = await s.post("/ui/settings/providers", {
      csrf,
      name: "opencode",
      type: "openai",
      base_url: "https://models.example/v1/",
      api_key: key,
    });
    assert.match(where(added), /ok="opencode" is saved and lists 2 models/);
    // A wrong key is saved, and the page says why its models could not be listed.
    const wrong = await s.post("/ui/settings/providers", {
      csrf,
      name: "wrong",
      type: "openai",
      base_url: "https://models.example/v1",
      api_key: "sk-wrong-9999",
    });
    assert.match(where(wrong), /HTTP 401 \(is the key right\?\)/);
    // A new provider needs its key; a change without one keeps the sealed key and lists again.
    const keyless = await s.post("/ui/settings/providers", {
      csrf,
      name: "other",
      type: "openai",
      base_url: "https://models.example/v1",
    });
    assert.match(where(keyless), /needs its API key/);
    await s.post("/ui/settings/providers", {
      csrf,
      name: "opencode",
      type: "openai",
      base_url: "https://models.example/v1",
    });
    assert.equal(s.store.modelProviders.get("opencode")?.version, 2);
    assert.equal(s.store.modelProviders.get("opencode")?.models.length, 2);
    page = await (await s.get("/ui/settings")).text();
    assert.match(page, /key …0001/);
    assert.match(page, /deepseek-v4\.1-flash-free <span class="muted">· 262k<\/span>/);
    // The key is in no page, row or audit entry: only sealed, and as its last four characters.
    const everything = JSON.stringify([
      page,
      s.store.db.prepare("select * from model_provider").all(),
      s.store.db.prepare("select * from audit").all(),
    ]);
    assert.ok(!everything.includes(key));
    // Only the rig given one of its models receives the key, in its config on the bus.
    assert.deepEqual(await s.rigConfig("model-route"), { route: null, planner: null });
    const unlisted = await s.post("/ui/settings/rigs", {
      csrf,
      rig: "rig-a",
      choice: "opencode|nope",
    });
    assert.match(where(unlisted), /does not list that model/);
    await s.post("/ui/settings/rigs", {
      csrf,
      rig: "rig-a",
      choice: "opencode|deepseek-v4.1-flash-free",
    });
    const given = (await s.rigConfig("model-route")) as unknown as {
      route: { api_key: string; type: string; context_window: number; base_url: string };
    };
    assert.equal(given.route.api_key, key);
    assert.equal(given.route.type, "openai");
    assert.equal(given.route.context_window, 262144);
    // A model the provider does not list can be added by its name.
    await s.post("/ui/settings/providers/opencode/models", { csrf, model: "custom-model" });
    assert.ok(
      s.store.modelProviders
        .get("opencode")
        ?.models.some((m) => m.id === "custom-model" && m.added),
    );
    // The supervisor hands it to its harness once; its agents use it from then on.
    const sync = s.cfg;
    const handed = (await s.rigConfig("model-route")) as never;
    assert.equal(await handModelRoute(sync, handed), "set");
    assert.equal(await handModelRoute(sync, handed), "unchanged");
    const current = s.env.service.models.current();
    assert.equal(current?.apiKey, key);
    assert.equal(current?.model, "deepseek-v4.1-flash-free");
    assert.equal(current?.contextWindow, 262144);
    assert.equal(statSync(join(dir, "model-route.json")).mode & 0o777, 0o600);
    await s.relay();
    page = await (await s.get("/ui/settings")).text();
    assert.match(page, /Its agents run under Pi with deepseek-v4\.1-flash-free from opencode\./);
    const rig = await (await s.get("/ui/rigs/rig-a")).text();
    assert.match(rig, /The agents now use model route &quot;opencode&quot;/);
    // Nothing the rig reports or records carries the key: its row, its events on control's bus.
    assert.ok(
      !JSON.stringify([
        s.store.db.prepare("select * from rig").all(),
        await heldEvents(s.store, "rig-a"),
        s.env.service.ledger.db.prepare("select * from event").all(),
      ]).includes(key),
    );
    // An Anthropic provider: its base URL may be left empty, and its route says its API.
    const ant = await s.post("/ui/settings/providers", {
      csrf,
      name: "anthropic",
      type: "anthropic",
      base_url: "",
      api_key: "sk-ant-x",
    });
    assert.match(where(ant), /lists 1 model/);
    assert.equal(s.store.modelProviders.get("anthropic")?.base_url, "https://api.anthropic.com");
    await s.post("/ui/settings/rigs", { csrf, rig: "rig-a", choice: "anthropic|claude-test" });
    assert.equal(await handModelRoute(sync, (await s.rigConfig("model-route")) as never), "set");
    assert.equal(s.env.service.models.current()?.api, "anthropic");
    assert.equal(s.env.service.models.current()?.baseUrl, "https://api.anthropic.com");
    // OpenCode's own provider needs no key, and its models run only in the OpenCode harness.
    const oc = await s.post("/ui/settings/providers", {
      csrf,
      name: "zen",
      type: "opencode",
      base_url: "",
    });
    assert.match(where(oc), /lists 2 models/);
    assert.equal(s.store.modelProviders.get("zen")?.key_sealed, "");
    const underPi = await s.post("/ui/settings/rigs", {
      csrf,
      rig: "rig-a",
      choice: "zen|free-model-free",
      harness: "pi",
    });
    assert.match(where(underPi), /run only in the OpenCode harness/);
    await s.post("/ui/settings/rigs", {
      csrf,
      rig: "rig-a",
      choice: "zen|free-model-free",
      harness: "opencode",
    });
    assert.equal(await handModelRoute(sync, (await s.rigConfig("model-route")) as never), "set");
    const zen = s.env.service.models.current();
    assert.equal(zen?.harness, "opencode");
    assert.equal(zen?.api, "opencode");
    assert.equal(zen?.apiKey, "");
    await s.relay();
    page = await (await s.get("/ui/settings")).text();
    assert.match(page, /Its agents run under OpenCode v2 with free-model-free from zen\./);
    // A planner given OpenCode's own models runs through OpenCode too; cleared, it follows the workers.
    s.store.agentModels.assignRole("rig-a", "planner", {
      provider: "zen",
      model: "free-model-free",
    });
    assert.equal(await handModelRoute(sync, (await s.rigConfig("model-route")) as never), "set");
    assert.equal(s.env.service.models.planner()?.api, "opencode");
    assert.equal(s.env.service.models.planner()?.harness, "opencode");
    s.store.agentModels.assignRole("rig-a", "planner", null);
    assert.equal(await handModelRoute(sync, (await s.rigConfig("model-route")) as never), "set");
    assert.equal(s.env.service.models.planner(), undefined);
    // A provider added as OpenAI-compatible at OpenCode's own endpoint, with its key, is OpenCode's
    // own too: under OpenCode it runs through OpenCode's built-in provider (no key sent); under Pi,
    // its key serves its paid models, and its free models are refused there.
    await s.post("/ui/settings/providers", {
      csrf,
      name: "oc-key",
      type: "openai",
      base_url: "https://opencode.ai/zen/v1/models",
      api_key: "test-oc-key-0002",
    });
    assert.equal(s.store.modelProviders.get("oc-key")?.base_url, "https://opencode.ai/zen/v1");
    const freeUnderPi = await s.post("/ui/settings/rigs", {
      csrf,
      rig: "rig-a",
      choice: "oc-key|free-model-free",
      harness: "pi",
    });
    assert.match(where(freeUnderPi), /free models run only in the OpenCode harness/);
    await s.post("/ui/settings/rigs", {
      csrf,
      rig: "rig-a",
      choice: "oc-key|free-model-free",
      harness: "opencode",
    });
    const own = (await s.rigConfig("model-route")) as unknown as {
      route: { type: string; api_key: string; harness: string };
    };
    assert.deepEqual(
      [own.route.type, own.route.api_key, own.route.harness],
      ["opencode", "", "opencode"],
    );
    await s.post("/ui/settings/rigs", {
      csrf,
      rig: "rig-a",
      choice: "oc-key|paid-model",
      harness: "pi",
    });
    const paid = (await s.rigConfig("model-route")) as unknown as {
      route: { type: string; api_key: string };
    };
    assert.deepEqual([paid.route.type, paid.route.api_key], ["openai", "test-oc-key-0002"]);
    // Any other provider works under OpenCode too (through the harness's key-adding proxy).
    await s.post("/ui/settings/rigs", {
      csrf,
      rig: "rig-a",
      choice: "opencode|deepseek-v4.1-flash-free",
      harness: "opencode",
    });
    assert.equal(await handModelRoute(sync, (await s.rigConfig("model-route")) as never), "set");
    assert.equal(s.env.service.models.current()?.harness, "opencode");
    assert.equal(s.env.service.models.current()?.api, undefined);
    await s.post("/ui/settings/rigs", {
      csrf,
      rig: "rig-a",
      choice: "anthropic|claude-test",
      harness: "pi",
    });
    assert.equal(await handModelRoute(sync, (await s.rigConfig("model-route")) as never), "set");
    await s.post("/ui/settings/providers/zen/delete", { csrf });
    // Back to the rig's own settings; a provider in use cannot be deleted meanwhile.
    const busy = await s.post("/ui/settings/providers/anthropic/delete", { csrf });
    assert.match(where(busy), /still in use/);
    await s.post("/ui/settings/rigs", { csrf, rig: "rig-a", choice: "" });
    assert.equal(
      await handModelRoute(sync, (await s.rigConfig("model-route")) as never),
      "cleared",
    );
    assert.equal(s.env.service.models.current(), undefined);
    await s.post("/ui/settings/providers/anthropic/delete", { csrf });
    assert.equal(s.store.modelProviders.get("anthropic"), undefined);
  });
});
