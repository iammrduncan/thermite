import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { handModelRoute } from "../../src/supervisor/model-route.ts";

/** A fake harness, which records what it is handed. */
function fakes(harness: {
  source: string;
  revision?: string;
  planner_revision?: string;
  awaiting?: boolean;
}) {
  const handed: unknown[] = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    if (init?.method === "PUT") {
      handed.push(JSON.parse(String(init.body)));
      return Response.json({});
    }
    return Response.json(harness);
  };
  const cfg = { harnessUrl: "http://harness", harnessToken: "h", fetchImpl };
  return { cfg, handed };
}

describe("the supervisor's model route, from the rig's config on the bus", () => {
  test("a changed route is handed over; control's explicit none hands the rig back", async () => {
    const route = { name: "r", version: 2, revision: "bbbbbbbb" };
    const changed = fakes({ source: "control", revision: "aaaaaaaa" });
    assert.equal(await handModelRoute(changed.cfg, { route }), "set");
    assert.deepEqual(changed.handed, [{ route, planner: null }]);
    const none = fakes({ source: "control", revision: "aaaaaaaa" });
    assert.equal(await handModelRoute(none.cfg, { route: null }), "cleared");
    assert.deepEqual(none.handed, [{ route: null, planner: null }]);
    const own = fakes({ source: "environment" });
    assert.equal(await handModelRoute(own.cfg, { route: null }), "unchanged");
  });

  test("the planner's own route is handed over when only it changed, and cleared when control drops it", async () => {
    const route = { name: "r", version: 2, revision: "bbbbbbbb" };
    const planner = { name: "claude-max", version: 1, revision: "cccccccc" };
    const given = fakes({ source: "control", revision: "bbbbbbbb" });
    assert.equal(await handModelRoute(given.cfg, { route, planner }), "set");
    assert.deepEqual(given.handed, [{ route, planner }]);
    const same = fakes({ source: "control", revision: "bbbbbbbb", planner_revision: "cccccccc" });
    assert.equal(await handModelRoute(same.cfg, { route, planner }), "unchanged");
    const dropped = fakes({
      source: "control",
      revision: "bbbbbbbb",
      planner_revision: "cccccccc",
    });
    assert.equal(await handModelRoute(dropped.cfg, { route, planner: null }), "set");
    assert.deepEqual(dropped.handed, [{ route, planner: null }]);
  });

  test("a harness that restarted awaits its routes, which it keeps in memory only: they go again", async () => {
    const route = { name: "r", version: 2, revision: "bbbbbbbb" };
    const planner = { name: "claude-max", version: 1, revision: "cccccccc" };
    const restarted = fakes({ source: "control", awaiting: true });
    assert.equal(await handModelRoute(restarted.cfg, { route, planner }), "set");
    assert.deepEqual(restarted.handed, [{ route, planner }]);
    // Even where what it reports matches the bus's: control's none goes again too.
    const own = fakes({ source: "environment", planner_revision: "cccccccc", awaiting: true });
    assert.equal(await handModelRoute(own.cfg, { route: null, planner }), "cleared");
    assert.deepEqual(own.handed, [{ route: null, planner }]);
  });
});
