import assert from "node:assert/strict";
import { test } from "node:test";
import { MODEL_ROUTE_PUT } from "../../../src/core/api/harness/supervisor.ts";
import { ControlRoute } from "../../../src/core/api/model-route.ts";
import { AdvisorRoutesValue, ModelRouteValue } from "../../../src/core/link/config.ts";
import { stack } from "../../control/rigs/model/stack.ts";

/**
 * The model route has one home (core/api/model-route.ts): control builds it, the supervisor reads
 * a little of it and passes it on, and the harness checks it whole. Every route control builds,
 * for every kind of provider and agent, is one the harness takes.
 */
test("every model route control builds is one its rig's harness takes (goal 125, T2)", async () => {
  const s = await stack();
  // The workers' model, then each other agent's, on each kind of provider.
  const given = [
    { provider: "lab", model: "wide-model" },
    { agent: "planner", provider: "lab", model: "strong-model", harness: "opencode" },
    { agent: "teachers", provider: "sub", model: "gpt-sol", harness: "codex" },
    { agent: "teachers", merged_by: { provider: "lab", model: "strong-model", harness: "codex" } },
    { agent: "auditor", provider: "zen", model: "big-pickle" },
    { agent: "review_panel", provider: "claude-sub", model: "opus-5.5" },
  ];
  for (const body of given) {
    const r = await s.give(body);
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
  const workers = await s.asRig("/v1/rigs/rig-a/model-route");
  assert.ok(ModelRouteValue.safeParse(workers).success, "what the supervisor reads of it");
  const advisors = await s.asRig("/v1/rigs/rig-a/advisor-routes");
  assert.ok(AdvisorRoutesValue.safeParse(advisors).success, "what the supervisor runs");
  const routes = [
    workers.route,
    workers.planner,
    ...((advisors.teacher_models ?? []) as unknown as Record<string, unknown>[]),
    advisors.merged_by,
    advisors.auditor,
    advisors.review_panel,
  ];
  assert.equal(routes.length, 6);
  for (const route of routes) {
    const read = ControlRoute.safeParse(route);
    assert.ok(read.success, `${JSON.stringify(route)}: ${read.error?.message}`);
  }
  // As the supervisor hands the workers' and the planner's to the harness.
  const handed = MODEL_ROUTE_PUT.body.safeParse({ route: workers.route, planner: workers.planner });
  assert.ok(handed.success, handed.error?.message);
});
