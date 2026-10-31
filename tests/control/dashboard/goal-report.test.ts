import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ADMIN, controlOnly, mcpClient, signIn } from "../../helpers/control-stack.ts";
import { ingestReport } from "../../helpers/control-store.ts";

/**
 * Goal 086 on control's side, from a rig's events: a goal report's values on the run's Goals
 * block, over REST and MCP; and, while the judge confirms a champion that met every required
 * goal, why the run starts no new trial.
 */

async function control() {
  const { store, control: api } = controlOnly({ tokens: { rigs: { "rig-a": "t-a-abcdef" } } });
  const { page } = await signIn(api);
  const rest = async (path: string) =>
    (await api.request(path, { headers: { authorization: `Bearer ${ADMIN}` } })).json();
  const mcp = async (tool: string, args: Record<string, unknown>) => {
    const client = await mcpClient(api);
    const r = (await client.callTool({ name: tool, arguments: args })) as {
      content: { text: string }[];
    };
    await client.close();
    return JSON.parse(r.content[0]?.text ?? "null");
  };
  let id = 0;
  const ingest = async (
    events: { kind: string; subject: string; body: Record<string, unknown> }[],
  ) => {
    await ingestReport(store, {
      rig: "rig-a",
      ledger_id: "ledger-a",
      cursor: id,
      next: id + events.length,
      events: events.map((e) => ({
        id: ++id,
        at: new Date().toISOString(),
        actor: "harness",
        ...e,
      })),
      summary: {},
    });
  };
  return { page, rest, mcp, ingest };
}

const goalRun = {
  kind: "run_created",
  subject: "q-1",
  body: {
    campaign: "quality",
    version: 1,
    mode: "goal",
    seed: { repo: "proj", commit: "a".repeat(40) },
  },
};

/** A goal report on champion 2: a met code goal with its values, a met threshold goal. */
const report = (o: { complete: boolean; confirming?: boolean }) => ({
  kind: "goal_report",
  subject: "q-1",
  body: {
    run: "q-1",
    champion_seq: 2,
    goals: [
      {
        goal: "quality",
        description: "no worse than the reference",
        status: "met",
        reasons: "verifier quality passed on wiki: wiki: ppl_ratio 1.00213, tok_per_s 4512.30",
        values: [{ cell: "wiki", ok: true, metrics: { ppl_ratio: 1.00213, tok_per_s: 4512.3 } }],
      },
      {
        goal: "fast",
        description: "fast enough",
        status: "met",
        reasons: "tok_per_s >= 4000: wiki: 4512.30 [4498.10, 4526.50]",
      },
    ],
    complete: o.complete,
    ...(o.confirming ? { confirming: true } : {}),
  },
});

const RUN = "/ui/campaigns/quality/runs/q-1";
const WAIT =
  /Champion #2 met every required goal, and the judge is checking it a second time: no new trial starts until that check is done\. If it agrees, the run closes; if not, the lanes go on\./;

describe("a goal report's values and its confirmation on control (goal 086)", () => {
  test("the Goals block shows a met goal's values beside its reasons; REST and get_run give them", async () => {
    const c = await control();
    await c.ingest([goalRun, report({ complete: false })]);
    const run = await c.page(RUN);
    assert.match(
      run,
      /<b>quality<\/b><\/span><div class="muted">no worse than the reference<\/div><div class="gl-why ok">verifier quality passed on wiki: wiki: ppl_ratio 1\.00213, tok_per_s 4512\.30<\/div>/,
    );
    assert.match(
      run,
      /<div class="gl-why ok">tok_per_s &gt;= 4000: wiki: 4512\.30 \[4498\.10, 4526\.50\]<\/div>/,
    );
    assert.doesNotMatch(run, WAIT);
    const view = (await c.rest("/v1/rigs/rig-a/view")) as {
      runs: { id: string; goals: { goal: string; values: unknown }[]; goals_confirming: boolean }[];
    };
    const r = view.runs.find((x) => x.id === "q-1");
    assert.deepEqual(r?.goals.map((g) => [g.goal, g.values]) ?? [], [
      ["quality", [{ cell: "wiki", ok: true, metrics: { ppl_ratio: 1.00213, tok_per_s: 4512.3 } }]],
      ["fast", null],
    ]);
    assert.equal(r?.goals_confirming, false);
    const viaMcp = (await c.mcp("get_run", { run: "q-1" })) as {
      goals: { values: { metrics: Record<string, number> }[] | null }[];
    };
    assert.equal(viaMcp.goals[0]?.values?.[0]?.metrics.ppl_ratio, 1.00213);
  });

  test("while the judge confirms a champion that met every goal: why no new trial starts, until the check is done or fails", async () => {
    const c = await control();
    await c.ingest([goalRun, report({ complete: true, confirming: true })]);
    const waiting = await c.page(RUN);
    assert.match(waiting, WAIT);
    assert.match(
      await c.page(`${RUN}/history`),
      /The judge checked champion #2: 2 of 2 goals met, every required goal\. It checks the champion a second time before the run closes; no new trial starts until then\./,
    );
    const view = (await c.rest("/v1/rigs/rig-a/view")) as {
      runs: { id: string; goals_confirming: boolean }[];
    };
    assert.equal(view.runs.find((x) => x.id === "q-1")?.goals_confirming, true);
    const viaMcp = (await c.mcp("get_run", { run: "q-1" })) as {
      goals_confirming: boolean;
    };
    assert.equal(viaMcp.goals_confirming, true);

    // The confirming validation failed: no completion is left to confirm, and the lanes go on.
    await c.ingest([
      { kind: "job_queued", subject: "41", body: { attempt: null, kind: "validate" } },
      { kind: "job_leased", subject: "41", body: { fence: 1 } },
      { kind: "job_finished", subject: "41", body: { state: "failed", result: {} } },
    ]);
    assert.doesNotMatch(await c.page(RUN), WAIT);

    // The next report that leaves nothing to confirm ends the wait too.
    await c.ingest([report({ complete: true, confirming: true })]);
    assert.match(await c.page(RUN), WAIT);
    await c.ingest([report({ complete: false })]);
    assert.doesNotMatch(await c.page(RUN), WAIT);

    // A confirming validation blocked after too many lost leases will not run: the wait ends.
    await c.ingest([report({ complete: true, confirming: true })]);
    assert.match(await c.page(RUN), WAIT);
    await c.ingest([
      { kind: "job_queued", subject: "42", body: { attempt: null, kind: "validate" } },
      { kind: "job_leased", subject: "42", body: { fence: 1 } },
      { kind: "crash_infra", subject: "42", body: { fence: 1, expiries: 3, state: "blocked" } },
    ]);
    assert.doesNotMatch(await c.page(RUN), WAIT);

    // The same when the lease ran out a third time (job_lease_expired, blocked).
    await c.ingest([report({ complete: true, confirming: true })]);
    assert.match(await c.page(RUN), WAIT);
    await c.ingest([
      { kind: "job_queued", subject: "43", body: { attempt: null, kind: "validate" } },
      { kind: "job_leased", subject: "43", body: { fence: 1 } },
      {
        kind: "job_lease_expired",
        subject: "43",
        body: { fence: 1, expiries: 3, state: "blocked" },
      },
    ]);
    assert.doesNotMatch(await c.page(RUN), WAIT);
  });
});
