import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { GIB } from "../../src/common/disk.ts";
import { Loops } from "../../src/common/health.ts";
import { ControlDisk } from "../../src/control/disk.ts";
import { diskFree } from "../../src/control/ui/rigs/disk.ts";
import { ADMIN, controlOnly, RIG_TOKEN, signIn } from "../helpers/control-stack.ts";
import { ingestReport } from "../helpers/control-store.ts";

const DISK = {
  floor_gib: 5,
  low: true,
  since: "2026-10-29T08:00:00.000Z",
  checked_at: "2026-10-29T08:30:00.000Z",
  places: [
    { name: "state", free_gib: 40.2, total_gib: 100 },
    { name: "outbox", free_gib: 3.1, total_gib: 100 },
  ],
};

describe("control's health and the rigs' (goal 173)", () => {
  test("control answers its loops' ages, and 503 when one is late", async () => {
    let now = 0;
    const loops = new Loops(() => now);
    const { api } = controlOnly({ options: { loops } });
    loops.add("resets", 10_000);
    let res = await api("GET", "/v1/health");
    assert.equal(res.status, 200);
    let body = (await res.json()) as { ok: boolean; bus: unknown; loops: Record<string, unknown> };
    assert.equal(body.ok, true);
    assert.ok(body.bus);
    // The drain watch is one of control's loops too.
    assert.deepEqual(Object.keys(body.loops).sort(), ["drains", "resets"]);
    now = 31 * 60_000;
    loops.tick("drains");
    res = await api("GET", "/v1/health");
    assert.equal(res.status, 503);
    body = (await res.json()) as typeof body;
    assert.deepEqual(body.loops.resets, { age_seconds: 1860, limit_seconds: 1800, late: true });
  });

  test("a probe with no token learns only whether control is well, its bus and its disk", async () => {
    let now = 0;
    const loops = new Loops(() => now);
    const { store, control } = controlOnly({
      options: { loops },
      tokens: { read: "read-token-abcdef" },
    });
    loops.add("resets", 10_000);
    new ControlDisk({
      store,
      stateDir: "/var/lib/thermite-control",
      floorGib: 5,
      free: () => ({ free: 40 * GIB, total: 100 * GIB }),
    });
    const probe = async (token?: string) => {
      const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};
      const r = await control.request("/v1/health", { headers });
      return { status: r.status, body: (await r.json()) as Record<string, unknown> };
    };
    assert.deepEqual(await probe(), {
      status: 200,
      body: { ok: true, bus: "off", degraded: false },
    });
    assert.deepEqual(await probe("rig-token-abcdef"), await probe());
    // The reader's and the owner's tokens read each loop and the disk.
    for (const token of ["read-token-abcdef", ADMIN]) {
      const r = await probe(token);
      assert.equal(r.status, 200);
      assert.deepEqual(Object.keys(r.body.loops as object).sort(), ["drains", "resets"]);
      assert.equal((r.body.disk as { floor_gib: number }).floor_gib, 5);
    }
    now = 31 * 60_000;
    loops.tick("drains");
    assert.deepEqual(await probe(), {
      status: 503,
      body: { ok: false, bus: "off", degraded: false },
    });
  });

  test("/metrics gives each part's loops, a rig's free disk and its drain", async () => {
    const { store, api } = controlOnly();
    await ingestReport(store, {
      rig: "rig-a",
      ledger_id: "l-1",
      cursor: 0,
      next: 0,
      generated_at: new Date().toISOString(),
      events: [],
      summary: {
        loops: { scheduler: { age_seconds: 2, limit_seconds: 1800, late: false } },
        disk: DISK,
        work: {
          trials: 1,
          judge_jobs: 0,
          draining: { since: new Date(Date.now() - 600_000).toISOString(), reason: "r" },
        },
      },
    });
    const fig = await api(
      "POST",
      "/v1/rigs/rig-a/supervisor",
      {
        at: new Date().toISOString(),
        loops: { report: { age_seconds: 4500, limit_seconds: 1800, late: true } },
      },
      RIG_TOKEN,
    );
    assert.equal(fig.status, 200, await fig.clone().text());
    const text = await (await api("GET", "/metrics")).text();
    assert.match(text, /thermite_loop_age_seconds\{part="control",loop="drains"\} \d+/);
    assert.match(
      text,
      /thermite_loop_age_seconds\{part="harness",rig="rig-a",loop="scheduler"\} 2\n/,
    );
    assert.match(text, /thermite_loop_late\{part="supervisor",rig="rig-a",loop="report"\} 1\n/);
    assert.match(text, /thermite_rig_disk_free_bytes\{rig="rig-a",place="outbox"\} 3328599654\n/);
    assert.match(text, /thermite_rig_disk_low\{rig="rig-a"\} 1\n/);
    assert.match(text, /thermite_rig_drain_age_seconds\{rig="rig-a"\} (59\d|600)\n/);
    assert.match(text, /thermite_rig_drain_overdue\{rig="rig-a"\} 0\n/);
  });

  test("a rig at its disk floor says so on its page and under Needs you, with its free disk", async () => {
    const { store, control } = controlOnly();
    await ingestReport(store, {
      rig: "rig-a",
      ledger_id: "l-1",
      cursor: 0,
      next: 0,
      generated_at: new Date().toISOString(),
      events: [],
      summary: { disk: DISK },
    });
    const ui = await signIn(control);
    const page = await ui.page("/ui/rigs/rig-a");
    assert.match(page, /Its disk is at its floor for/);
    assert.match(page, /its outbox has 3\.1 GiB free/);
    // The rig's free disk as each report gives it, beside its hardware.
    assert.equal(
      diskFree({ summary: { disk: DISK }, hardware: null }),
      'state 40.2 of 100 GiB · outbox 3.1 of 100 GiB <span class="muted">· floor 5 GiB</span>',
    );
    const needs = await ui.page("/ui");
    assert.match(needs, /rig-a holds new work: its disk is at its floor/);
    assert.match(needs, /Open the rig/);
  });
});
