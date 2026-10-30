import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ADMIN, controlOnly, signIn } from "../helpers/control-stack.ts";

const RIG_TOKEN = "rig-token-in-the-file-0001";

describe("retiring a rig that is gone", () => {
  test("any rig, even one from the tokens file: out of the lists and Needs you, its reports refused, back on request", async () => {
    const { store, control: api } = controlOnly({ tokens: { rigs: { "rig-a": RIG_TOKEN } } });
    // A rig that reported once, long ago: it shows as not reporting.
    store.db
      .prepare(
        "insert into rig (id, first_seen, last_seen, ledger_id, summary, report_at) values (?, ?, ?, null, '{}', ?)",
      )
      .run("rig-a", "2026-10-01T00:00:00Z", "2026-10-01T00:00:00Z", "2026-10-01T00:00:00Z");
    const { page, csrfOf, post: send } = await signIn(api);
    const csrf = csrfOf(await page("/ui/rigs/rig-a"));
    const post = async (path: string, form: Record<string, string>) =>
      decodeURIComponent(String((await send(path, { csrf, ...form })).headers.get("location")));
    assert.match(await page("/ui"), /rig-a stopped reporting/);
    assert.match(await page("/ui/rigs/rig-a"), /Retire it/);
    // A rig that never reported has no last report: "not yet", not days since 1970.
    store.db
      .prepare(
        "insert into rig (id, first_seen, last_seen, ledger_id, summary, report_at) values (?, ?, ?, null, '{}', ?)",
      )
      .run("rig-new", "2026-10-19T00:00:00Z", new Date(0).toISOString(), new Date(0).toISOString());
    assert.match(await page("/ui/rigs/rig-new"), /rig-new has not reported yet\./);
    assert.match(await page("/ui"), /rig-new has not reported yet/);
    assert.ok(!(await page("/ui/rigs/rig-new")).includes("days"));
    assert.match(
      await post("/ui/rigs/rig-a/retire", { confirm: "retire rig-b" }),
      /Type "retire rig-a"/,
    );
    assert.match(
      await post("/ui/rigs/rig-a/retire", { confirm: "retire rig-a" }),
      /rig-a is retired\./,
    );
    assert.ok(!(await page("/ui")).includes("rig-a stopped reporting"), "not in Needs you");
    const rigs = await page("/ui/rigs");
    assert.match(rigs, /1 rig ·/, "only rig-new is listed");
    assert.match(rigs, /<h2>Retired<\/h2><span class="n">1<\/span>/);
    assert.match(await page("/ui/rigs/rig-a"), /Retired .* ago by owner:ui/);
    // Its token, which control made when it enrolled the rig, has ended.
    const refused = await api.request("/v1/rigs/rig-a/commands/pending", {
      headers: { authorization: `Bearer ${RIG_TOKEN}` },
    });
    assert.equal(refused.status, 401);
    assert.ok(store.auditLog.list(20).some((a) => a.action === "rig_retired"));

    assert.match(await post("/ui/rigs/rig-a/bring-back", {}), /rig-a is back/);
    assert.match(await page("/ui"), /rig-a stopped reporting/);
    // Back in the lists, its old token stays ended: it is enrolled again for a new one.
    const back = await api.request("/v1/rigs/rig-a/commands/pending", {
      headers: { authorization: `Bearer ${RIG_TOKEN}` },
    });
    assert.equal(back.status, 401);

    // The REST API: any rig.
    const r = await api.request("/v1/rigs/rig-a/retire", {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    assert.deepEqual(await r.json(), { rig: "rig-a", retired: true });
    const missing = await api.request("/v1/rigs/nope/retire", {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    assert.equal(missing.status, 404);
  });
});
