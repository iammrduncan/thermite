import assert from "node:assert/strict";
import { test } from "node:test";
import { ADMIN, controlOnly, mcpClient, signIn } from "../helpers/control-stack.ts";

/**
 * The rule of goal 170 (CONVENTIONS.md, "A thing is addressed through what owns it"): a run hangs
 * from its campaign, and what a run owns (its attempts, trials, champions, paper and Live) from
 * the run, wherever the run ran. The rig a run ran on is a fact about it, never its parent: no
 * dashboard route, REST route or MCP tool addresses a run-scoped thing through its rig. Rig-level
 * things (the rig's page, its whole Live, settings, checks, the judge's queue, exports, resets)
 * keep the rig's address.
 */

/** A run-scoped thing in a path: a run, an attempt, a trial, a champion or a run's paper. */
const RUN_SCOPED = /:(run|attempt|trial)\b|\/(runs|attempts|trials|champions)\b|paper\.md/;
/** The addresses a run-scoped thing may hang from: its run, under its campaign or alone. */
const UNDER_RUN = /^(\/ui\/campaigns\/:campaign\/runs\/:run|\/v1\/runs\/:run)(\/|$)/;
/**
 * What a rig sends of its own run, with its own token: the rig is who sends it, not the run's
 * parent (the owner reads the patch under the run).
 */
const THE_RIGS_OWN = new Set(["POST /v1/rigs/:rig/champions/:run/:seq/patch"]);
/** Starts a new run of a campaign: the campaign's, and no run is named yet. */
const NEW_RUN = new Set(["POST /ui/campaigns/:campaign/runs", "POST /v1/campaigns/:campaign/runs"]);

test("no dashboard or REST route addresses a run-scoped thing through its rig", () => {
  const { control } = controlOnly();
  const routes = [...new Set(control.routes.map((r) => `${r.method} ${r.path}`))];
  assert.ok(routes.length > 150, "every route of control, the dashboard's too");
  const wrong = routes.filter((r) => {
    const path = r.slice(r.indexOf(" ") + 1);
    if (!RUN_SCOPED.test(path) || THE_RIGS_OWN.has(r) || NEW_RUN.has(r)) return false;
    return /\/rigs\/:rig\b/.test(path) || !UNDER_RUN.test(path);
  });
  assert.deepEqual(wrong, []);
  // And the run's own addresses are there.
  for (const r of [
    "GET /ui/campaigns/:campaign/runs/:run",
    "GET /ui/campaigns/:campaign/runs/:run/attempts/:attempt",
    "GET /ui/campaigns/:campaign/runs/:run/live",
    "GET /v1/runs/:run",
    "GET /v1/runs/:run/attempts/:attempt",
    "GET /v1/runs/:run/champions/:seq/patch",
  ])
    assert.ok(routes.includes(r), r);
});

test("no MCP tool takes a rig with a run, an attempt or a trial", async () => {
  const { control } = controlOnly();
  const client = await mcpClient(control, ADMIN);
  const tools = (await client.listTools()).tools;
  await client.close();
  const RIG = ["rig", "from_rig", "to_rig"];
  const RUN = ["run", "to_run", "attempt", "trial", "queue_from"];
  const wrong = tools
    .filter((t) => {
      const fields = Object.keys(t.inputSchema.properties ?? {});
      return fields.some((f) => RIG.includes(f)) && fields.some((f) => RUN.includes(f));
    })
    .map((t) => t.name)
    // Start a run names the rig the new run starts on; the run it copies from is named alone.
    .filter((name) => name !== "start_run");
  assert.deepEqual(wrong, []);
  const fields = (name: string) =>
    Object.keys(tools.find((t) => t.name === name)?.inputSchema.properties ?? {}).sort();
  assert.deepEqual(fields("get_attempt"), ["attempt", "run"]);
  assert.deepEqual(fields("propagate_champion"), ["run", "to_run"]);
  for (const name of ["get_run", "run_queue", "trial_session", "model_usage"])
    assert.ok(!fields(name).includes("rig"), name);
  // A command about one run may leave out the rig: control knows the run's.
  const issue = tools.find((t) => t.name === "issue_command");
  assert.ok(issue && !(issue.inputSchema.required ?? []).includes("rig"));
});

test("the old addresses through a rig are gone, with no redirect", async () => {
  const { control, api } = controlOnly();
  const { get } = await signIn(control);
  for (const path of [
    "/ui/rigs/rig-a/attempts/a-1",
    "/ui/rigs/rig-a/runs/r-1/paper.md",
    "/ui/rigs/rig-a/runs/r-1/champions/2.patch",
  ]) {
    const r = await get(path);
    assert.equal(r.status, 404, path);
    assert.equal(r.headers.get("location"), null, path);
  }
  for (const path of [
    "/v1/rigs/rig-a/runs/r-1",
    "/v1/rigs/rig-a/runs/r-1/untried",
    "/v1/rigs/rig-a/runs/r-1/directions",
    "/v1/rigs/rig-a/champions/r-1/2/patch",
  ])
    assert.equal((await api("GET", path)).status, 404, path);
  // A run's usage is asked for by the run alone.
  const usage = await api("GET", "/v1/usage?run=r-1&rig=rig-a");
  assert.equal(usage.status, 400);
});
