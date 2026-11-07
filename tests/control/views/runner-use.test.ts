import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { RunnerUseSample } from "../../../src/control/store/index.ts";
import { runnerUse } from "../../../src/control/views/runner-use.ts";
import { controlOnly, mcpClient, signIn } from "../../helpers/control-stack.ts";
import { controlStore, ingestReport } from "../../helpers/control-store.ts";

/**
 * Goal 231 on control's side: a sample of a rig core's running totals at most once a minute,
 * kept 8 days; each runner's share of a window, across a restart of the core; and the Runners
 * block, MCP's runner_use and REST's `GET /v1/rigs/<rig>/runner-use` that show it.
 */

const T = Date.parse("2026-11-07T08:00:00Z");
const at = (min: number) => new Date(T + min * 60_000).toISOString();
const m = (n: number) => n * 60_000;

/** A sample of one runner's totals. */
function sample(
  min: number,
  since: number,
  t: { judge: number; lane1?: number; free: number; away?: number },
  gpu?: { busy: number; read: number },
): RunnerUseSample {
  return {
    at: at(min),
    runners: {
      "box-2-0": {
        pool: "shared",
        use: {
          since: at(since),
          judge_ms: m(t.judge),
          lanes_ms: t.lane1 ? { "lane-1": m(t.lane1) } : {},
          free_ms: m(t.free),
          away_ms: m(t.away ?? 0),
        },
        ...(gpu
          ? {
              gpu: {
                util_pct: 50,
                mem_used_mib: null,
                mem_total_mib: null,
                at: at(min),
                busy_ms: m(gpu.busy),
                read_ms: m(gpu.read),
              },
            }
          : {}),
      },
    },
    waited: { judge: { count: 2, ms: m(4) } },
    waited_since: at(since),
  };
}

/** A rig's report whose runner says its totals since `since` minutes ago. */
const reportOf = (sinceMin: number) => ({
  runners: {
    processes: [
      {
        name: "box-2",
        pools: ["shared"],
        up: true,
        answered_at: new Date().toISOString(),
        away_since: null,
        runners: [
          {
            name: "box-2-0",
            pool: "shared",
            holder: null,
            use: {
              since: new Date(Date.now() - m(sinceMin)).toISOString(),
              judge_ms: m(18),
              lanes_ms: { "lane-1": m(6) },
              free_ms: m(6),
              away_ms: 0,
            },
            gpu: {
              util_pct: 0,
              mem_used_mib: null,
              mem_total_mib: null,
              at: new Date().toISOString(),
              busy_ms: m(3),
              read_ms: m(10),
            },
          },
        ],
      },
    ],
    waiting: [],
    waits: [],
    waited: { judge: { count: 3, ms: m(9) }, "lane-1": { count: 1, ms: 30_000 } },
    waited_since: new Date(Date.now() - m(sinceMin)).toISOString(),
  },
});

describe("how a rig's runners spent their time, on control (goal 231)", () => {
  test("a window's shares: each span against the one before of the same life, across a restart", () => {
    const samples = [
      sample(0, 0, { judge: 0, free: 0 }),
      sample(10, 0, { judge: 6, free: 4 }, { busy: 1, read: 4 }),
      sample(20, 0, { judge: 10, lane1: 4, free: 6 }, { busy: 3, read: 8 }),
      // The core restarted at 25: its totals began again then.
      sample(30, 25, { judge: 0, lane1: 2, free: 3 }, { busy: 1, read: 2 }),
    ];
    // From 15 on: half of the span 10 to 20 (4 of judge, 4 of lane-1, 2 free, halved), then
    // the new life's 5 minutes whole.
    const v = runnerUse(samples, "hour", at(15), at(30));
    assert.deepEqual(v.runners, [
      {
        runner: "box-2-0",
        pool: "shared",
        judge_ms: m(2),
        lanes_ms: { "lane-1": m(2) + m(2) },
        free_ms: m(1) + m(3),
        away_ms: 0,
        gpu: {
          // Busy (2 halved) + 1 over read (4 halved) + 2.
          mean_pct: 50,
          read_ms: m(4),
          now_pct: 50,
          at: at(30),
          mem_used_mib: null,
          mem_total_mib: null,
        },
      },
    ]);
    assert.equal(v.first, at(20), "control's first sample in the window");
    // The waits: none added from 10 to 20 in the first life; the new life's 2, whole.
    assert.deepEqual(v.waited, { judge: { count: 2, ms: m(4) } });
  });

  test("control keeps a sample a minute, for 8 days, and gives the one before a window with it", () => {
    const store = controlStore();
    const summary = reportOf(30);
    store.runnerUse.note("rig-a", summary, at(0));
    store.runnerUse.note("rig-a", summary, at(0.5));
    store.runnerUse.note("rig-a", summary, at(1));
    store.runnerUse.note("rig-a", { runners: { processes: [] } }, at(2));
    assert.deepEqual(
      store.runnerUse.samples("rig-a", at(-60)).map((s) => s.at),
      [at(0), at(1)],
      "one a minute; a report with no totals keeps none",
    );
    assert.deepEqual(
      store.runnerUse.samples("rig-a", at(0.5)).map((s) => s.at),
      [at(0), at(1)],
      "with the newest one before the window",
    );
    // Eight days later, the old ones go.
    store.runnerUse.note("rig-a", summary, at(8 * 24 * 60 + 2));
    assert.deepEqual(
      store.runnerUse.samples("rig-a", at(-60)).map((s) => s.at),
      [at(8 * 24 * 60 + 2)],
    );
  });

  test("the Runners block, runner_use and REST show the shares and who waited", async () => {
    const { store, control, api } = controlOnly();
    const { page } = await signIn(control);
    await ingestReport(store, {
      rig: "rig-a",
      ledger_id: "ledger-a",
      cursor: 0,
      next: 0,
      events: [],
      summary: reportOf(30),
    });
    const html = await page("/ui/rigs/rig-a");
    assert.match(html, /How they spent the last hour/);
    assert.match(html, /the judge 60% \(18m\) · lane 1 20% \(6m\) · idle 20% \(6m\)/);
    assert.match(html, /GPU busy 30% of the 10m it was read, 0% at its last read/);
    assert.match(
      html,
      /The judge(&#39;|')s jobs waited 3 times, 9m in all; Lane 1(&#39;|')s runs waited 1 time, 30s in all\./,
    );
    assert.match(html, /href="\/ui\/rigs\/rig-a\?use=day#runners"/);
    const rest = await api("GET", "/v1/rigs/rig-a/runner-use?window=day");
    assert.equal(rest.status, 200);
    const read = (await rest.json()) as {
      window: string;
      runners: { runner: string; shares: unknown; reported_ms: number }[];
    };
    assert.equal(read.window, "day");
    assert.deepEqual(read.runners[0]?.shares, {
      judge: 60,
      lanes: { "lane-1": 20 },
      idle: 20,
      away: 0,
    });
    assert.equal(read.runners[0]?.reported_ms, m(30));
    assert.equal((await api("GET", "/v1/rigs/rig-a/runner-use?window=week")).status, 400);
    assert.equal(
      (await api("GET", "/v1/rigs/rig-a/runner-use?window=run")).status,
      404,
      "no run on the rig",
    );
    const mcp: Client = await mcpClient(control);
    const r = (await mcp.callTool({ name: "runner_use", arguments: { rig: "rig-a" } })) as {
      content: { text: string }[];
    };
    const got = JSON.parse(r.content[0]?.text ?? "{}") as {
      window: string;
      waited: Record<string, unknown>;
    };
    assert.equal(got.window, "hour");
    assert.deepEqual(got.waited, {
      judge: { count: 3, ms: m(9) },
      "lane-1": { count: 1, ms: 30_000 },
    });
    await mcp.close();
  });
});
