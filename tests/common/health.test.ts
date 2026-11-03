import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { every, Loops } from "../../src/common/health.ts";
import { LATE_AFTER_AT_LEAST_MS, loopLimitMs } from "../../src/core/health.ts";
import { createHarnessApi } from "../../src/harness/api/index.ts";
import { makeHarnessEnv } from "../helpers/harness-env.ts";

describe("loops that tick, and health that checks them (goal 173)", () => {
  test("a loop's limit follows its period: ten periods, never under 30 minutes", () => {
    assert.equal(loopLimitMs(2000), LATE_AFTER_AT_LEAST_MS);
    assert.equal(loopLimitMs(15 * 60_000), 150 * 60_000);
  });

  test("a loop that stops coming around is late; a busy one is not", () => {
    let now = 0;
    const loops = new Loops(() => now);
    let job: string | undefined;
    loops.add("scheduler", 2000);
    loops.add("judge:0", 1000, () => job);
    now = 29 * 60_000;
    loops.tick("judge:0");
    assert.equal(loops.health().ok, true);
    now = 30 * 60_000 + 1000;
    const h = loops.health();
    assert.equal(h.ok, false);
    assert.deepEqual(h.loops.scheduler, { age_seconds: 1801, limit_seconds: 1800, late: true });
    assert.equal(h.loops["judge:0"]?.late, false);
    // The scheduler comes around again; the judge goes into a job that lasts.
    loops.tick("scheduler");
    job = "job 12";
    now += 3 * 3_600_000;
    assert.equal(loops.health().loops["judge:0"]?.late, false);
    assert.equal(loops.health().loops["judge:0"]?.busy, "job 12");
    assert.equal(loops.health().loops.scheduler?.late, true);
  });

  test("every() ticks its loop each time a round ends, well or not", async () => {
    const loops = new Loops();
    let rounds = 0;
    const timer = every(loops, "control", "resets", 5, async () => {
      rounds++;
      if (rounds === 2) throw new Error("a round that fails");
    });
    for (let i = 0; i < 100 && rounds < 3; i++) await new Promise((r) => setTimeout(r, 5));
    clearInterval(timer);
    assert.ok(rounds >= 3);
    assert.equal(loops.health().loops.resets?.late, false);
  });

  test("the harness answers its health, each loop's age to the supervisor, and 503 for a hung loop", async () => {
    const env = makeHarnessEnv();
    let now = 0;
    env.service.loops = new Loops(() => now);
    env.service.loops.add("scheduler", 2000);
    env.service.loops.add("exports", 5000);
    const api = createHarnessApi(env.service, { supervisor: "s", proposer: "p" });
    // A probe, and a lane's token, get whether it is well; the supervisor's token, the rest.
    const asked = (token?: string) =>
      api.request("/v1/health", token ? { headers: { authorization: `Bearer ${token}` } } : {});
    assert.deepEqual(await (await asked()).json(), { ok: true });
    assert.deepEqual(await (await asked("p")).json(), { ok: true });
    let res = await asked("s");
    assert.equal(res.status, 200);
    let body = (await res.json()) as { ok: boolean; rig: string; loops: Record<string, unknown> };
    assert.equal(body.ok, true);
    assert.equal(body.rig, env.service.rig);
    assert.deepEqual(Object.keys(body.loops).sort(), ["exports", "scheduler"]);
    // The exports loop goes on; the scheduler hangs past its limit.
    now = 31 * 60_000;
    env.service.loops.tick("exports");
    assert.deepEqual(await (await asked()).json(), { ok: false });
    res = await asked("s");
    assert.equal(res.status, 503);
    body = (await res.json()) as typeof body;
    assert.equal(body.ok, false);
    assert.deepEqual(body.loops.scheduler, { age_seconds: 1860, limit_seconds: 1800, late: true });
    assert.equal((body.loops.exports as { late: boolean }).late, false);
  });
});
