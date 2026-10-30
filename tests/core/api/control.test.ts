import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { tunnelRouteAllowed } from "../../../src/control/runpod/tunnel.ts";
import * as owner from "../../../src/core/api/control/owner.ts";
import * as rigs from "../../../src/core/api/control/rigs.ts";
import { pathOf, type Route } from "../../../src/core/api/route.ts";
import { REPORT_MAX_CHARS, RIG_ASKS } from "../../../src/core/link/asks.ts";
import { ADMIN, controlOnly, RIG_TOKEN } from "../../helpers/control-stack.ts";

/** The routes a contract module names: each export that is a route. */
function routesOf(module: Record<string, unknown>): [string, Route][] {
  return Object.entries(module).filter(
    (e): e is [string, Route] =>
      typeof e[1] === "object" && e[1] !== null && "method" in e[1] && "path" in e[1],
  );
}

const RIG_ROUTES = routesOf(rigs);
const OWNER_ROUTES = routesOf(owner);
/** Each parameter a path may have, filled as the tunnel's allow-list takes it. */
const PARAMS = {
  rig: "rig-a",
  id: "c-1",
  run: "r-1",
  attempt: "a-1",
  seq: 3,
  name: "20261020T120000Z-0123abcd",
  campaign: "sort-speed",
};

describe("control's API has one contract (core/api/control/)", () => {
  test("each route is named once, and control serves every route a rig and the command line call", async () => {
    const seen = new Set<string>();
    for (const [name, r] of [...RIG_ROUTES, ...OWNER_ROUTES]) {
      const key = `${r.method} ${r.path}`;
      assert.ok(!seen.has(key), `${name}: ${key} is named twice`);
      seen.add(key);
    }
    const { control } = controlOnly({ tokens: { admin: ADMIN, rigs: { "rig-a": RIG_TOKEN } } });
    for (const [list, token] of [
      [RIG_ROUTES, RIG_TOKEN],
      [OWNER_ROUTES, ADMIN],
    ] as const)
      for (const [name, r] of list) {
        const path = pathOf(r, PARAMS);
        const res = await control.request(path, {
          method: r.method,
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          ...(r.method === "GET" ? {} : { body: "{}" }),
        });
        // Hono's own answer to a path it has no route for; any other is the route's.
        assert.notEqual(await res.text(), "404 Not Found", `${name}: ${r.method} ${path}`);
      }
  });

  test("pull mode's tunnel lets every route of a rig's through, and no route of the owner's", () => {
    // The allow-list repeats the routes on purpose (what it does not list, it refuses): it agrees.
    for (const [name, r] of RIG_ROUTES)
      assert.ok(tunnelRouteAllowed("rig-a", r.method, pathOf(r, PARAMS)), name);
    assert.ok(
      tunnelRouteAllowed("rig-a", "GET", `${rigs.gitRepoPath("rig-a", "kits/lab-kit")}/info/refs`),
    );
    for (const [name, r] of OWNER_ROUTES)
      assert.ok(!tunnelRouteAllowed("rig-a", r.method, pathOf(r, PARAMS)), name);
  });

  test("a body past its route's limit is answered 413, the code its sender acts on", async () => {
    const { control } = controlOnly({ tokens: { admin: ADMIN, rigs: { "rig-a": RIG_TOKEN } } });
    const res = await control.request(pathOf(rigs.REGISTER, PARAMS), {
      method: "POST",
      headers: { authorization: `Bearer ${RIG_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ at: "x".repeat(rigs.REGISTER.maxBytes) }),
    });
    assert.equal(res.status, 413);
  });

  test("its bodies take what a rig's supervisor sends today", () => {
    const at = new Date().toISOString();
    // A newer supervisor's figures (control's versions test): fields it does not know are dropped.
    const figures = {
      at,
      relay: { cursor: 3 },
      uptime_s: 4000,
      export: {
        remote: false,
        to: "control",
        exports: 1,
        pushed: [],
        last_push_at: null,
        uploaded: Array.from({ length: rigs.FIGURE_EXPORTS_MAX }, (_, i) => `e-${i}`),
        last_error: "x".repeat(rigs.FIGURE_TEXT_MAX),
      },
      models: [],
      advisors: null,
    };
    assert.ok(RIG_ASKS.figures.body.safeParse(figures).success);
    const keys = { bus_key: "U".repeat(56), bus_seal_key: "k".repeat(44) };
    assert.ok(rigs.REGISTER.body.safeParse({ ...figures, ...keys }).success);
    assert.ok(!rigs.REGISTER.body.safeParse(figures).success, "the registration names its keys");
    // One past the limits the supervisor cuts to is refused: so it cuts to them.
    const over = { ...figures, export: { ...figures.export, last_error: "x".repeat(1001) } };
    assert.ok(!RIG_ASKS.figures.body.safeParse(over).success);
    assert.ok(
      RIG_ASKS.daily.body.safeParse({ kind: "daily", body: "x".repeat(REPORT_MAX_CHARS) }).success,
    );
    assert.ok(
      rigs.EXPORT_BEGIN.body.safeParse({
        manifest: {
          rig: "rig-a",
          created_at: at,
          from_event: 0,
          through_event: 4,
          files: { "events.jsonl": "a".repeat(64) },
        },
        files: { "events.jsonl": 120 },
      }).success,
    );
  });
});
