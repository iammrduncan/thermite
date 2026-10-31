import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { controlOnly, mcpClient, signIn } from "../../helpers/control-stack.ts";
import { ingestReport } from "../../helpers/control-store.ts";

/**
 * Goal 115 on control's side, from a rig's events: a hill climb that waits for the judge's
 * baseline, one in setup, and one with its baseline, on the run's page (its status line, its
 * Overview's "Where the run started" and its History), over REST and in get_run.
 */

async function control() {
  const { store, control, api } = controlOnly({ tokens: { rigs: { "rig-a": "t-a-abcdef" } } });
  const { page } = await signIn(control);
  const rest = async (path: string) => (await api("GET", path)).json();
  const mcp = async (tool: string, args: Record<string, unknown>) => {
    const client = await mcpClient(control);
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

const SEED = "a".repeat(40);
const FIX = "b".repeat(40);
const created = {
  kind: "run_created",
  subject: "s-1",
  body: {
    campaign: "speed",
    version: 1,
    mode: "hill_climb",
    seed: { repo: "proj", commit: SEED },
  },
};
const queued = {
  kind: "job_queued",
  subject: "7",
  body: { attempt: null, kind: "baseline", run: "s-1" },
};
const failed = {
  kind: "baseline_failed",
  subject: "s-1",
  body: {
    run: "s-1",
    job: 7,
    champion_seq: 1,
    commit: SEED,
    reasons: "cell small: exit 3: Error: no kernel yet",
    summary: "the judge could not measure champion #1 (aaaaaaaa): cell small: exit 3",
  },
};
const baseline = {
  kind: "baseline",
  subject: "s-1",
  body: {
    run: "s-1",
    job: 9,
    champion_seq: 2,
    commit: FIX,
    attempt: "a-fix",
    blocks: 3,
    runs_per_cell: 1,
    primary: { metric: "tok_per_s", direction: "max" },
    guards: [{ metric: "ppl_ratio", direction: "min", max_total_regression: 0.01 }],
    units: { tok_per_s: "tok/s", ppl_ratio: "ratio", rss_mib: "MiB" },
    cells: {
      wiki: {
        tok_per_s: { median: 4512.3, mad: 9.1, n: 3 },
        ppl_ratio: { median: 1.0021, mad: 0.0001, n: 3 },
        rss_mib: { median: 812, mad: 2, n: 3 },
      },
      code: {
        tok_per_s: { median: 3999.5, mad: 20.2, n: 3 },
        ppl_ratio: { median: 1.0013, mad: 0.0002, n: 3 },
        rss_mib: { median: 790, mad: 1, n: 3 },
      },
    },
    files: [{ path: "ref/wiki.json", bytes: 2048, sha256: "c".repeat(64) }],
    bytes: 2048,
    summary:
      "tok_per_s wiki 4512 ±0.20%, code 4000 ±0.51% (median of 3 blocks; the check kept 1 file)",
  },
};
const RUN = "/ui/campaigns/speed/runs/s-1";

describe("a hill climb's baseline on control (goal 115)", () => {
  test("waiting: the status line and Overview say the judge measures the starting point first", async () => {
    const c = await control();
    await c.ingest([created, queued]);
    const html = await c.page(RUN);
    assert.match(
      html,
      /The judge measures the starting point on every case first: no round or trial starts until it has\./,
    );
    assert.match(
      html,
      /<h2>Where the run started<\/h2><span class="right">waiting for the judge<\/span>/,
    );
    const run = await c.mcp("get_run", { run: "s-1" });
    assert.equal(run.baseline_waiting, true);
    assert.equal(run.baseline, null);
    assert.equal(run.setup, null);
  });

  test("setup: the reasons on the Overview and in History; a setup round; get_run's setup", async () => {
    const c = await control();
    await c.ingest([
      created,
      queued,
      failed,
      {
        kind: "epoch_started",
        subject: "s-1",
        body: {
          n: 1,
          source: "fallback",
          plan: "setup",
          planner_tries: 0,
          planner_valid: false,
          raw_violations: 0,
          assignments: [{ lane: "lane-1", family: "setup", parent: "champion" }],
        },
      },
    ]);
    const html = await c.page(RUN);
    assert.match(
      html,
      /The judge could not measure the starting point \(champion #1\): the run is in setup, and the lanes work to make it build and run its cases\./,
    );
    assert.match(html, /<span class="right">the run is in setup<\/span>/);
    assert.match(html, /cell small: exit 3: Error: no kernel yet/);
    const history = await c.page(`${RUN}/history`);
    assert.match(
      history,
      /The judge could not measure the starting point, champion #1: cell small: exit 3: Error: no kernel yet\. The run is in setup: the lanes work to make it build and run its cases\./,
    );
    assert.match(
      history,
      /Round 1 is a setup round: lane-1 works to make the starting point build and run its cases\./,
    );
    const run = await c.mcp("get_run", { run: "s-1" });
    assert.equal(run.baseline_waiting, false);
    assert.equal(run.setup.champion_seq, 1);
    assert.equal(run.setup.reasons, "cell small: exit 3: Error: no kernel yet");
    // A setup round is not a fallback of the planner.
    assert.equal(run.agents.fallbacks, 0);
  });

  test("measured: Where the run started shows each case's main metric and guards with the noise; History and get_run have it", async () => {
    const c = await control();
    await c.ingest([
      created,
      queued,
      failed,
      {
        kind: "attempt_recorded",
        subject: "a-fix",
        body: { run: "s-1", lane: "lane-1", lifecycle: "queued", commit: FIX, parent: SEED },
      },
      {
        kind: "verdict",
        subject: "a-fix",
        body: { id: 1, verdict: "starting_point", delta: null, reasons: "measured" },
      },
      {
        kind: "champion_promoted",
        subject: "s-1",
        body: { seq: 2, attempt: "a-fix", commit: FIX, setup: true },
      },
      baseline,
      {
        kind: "calibration",
        subject: "s-1",
        body: { sigma: 0.0042, summary: "A/A" },
      },
    ]);
    const html = await c.page(RUN);
    // The status line no longer waits, nor says setup.
    assert.doesNotMatch(html, /The judge measures the starting point on every case first/);
    assert.doesNotMatch(
      html,
      /The judge could not measure the starting point \(champion #1\): the run is in setup/,
    );
    const block = html.slice(html.indexOf('data-part="baseline"'));
    assert.match(block, /<h2>Where the run started<\/h2>/);
    // Its main metric and guard, not the other metric, with each value's spread.
    assert.match(
      block,
      /<th>tok_per_s <span class="muted small">tok\/s<\/span><div class="muted xs">main, higher is better<\/div><\/th>/,
    );
    assert.match(
      block,
      /<th>ppl_ratio <span class="muted small">ratio<\/span><div class="muted xs">guard: at most 1% worse in all<\/div><\/th>/,
    );
    assert.match(
      block,
      /<tr><td>wiki<\/td><td><b class="fig">4512<\/b> <span class="muted small">±0\.20%<\/span><\/td><td><b class="fig">1.002<\/b>/,
    );
    assert.match(
      block,
      /Champion #2 \(<code>bbbbbbbb<\/code>\), the setup change <a [^>]*><code>a-fix<\/code><\/a>, measured alone: the median of 3 blocks, each of 1 run a case/,
    );
    assert.match(
      block,
      /The rig&#39;s noise \(A\/A\): ±0\.42% per block\.|The rig's noise \(A\/A\): ±0\.42% per block\./,
    );
    assert.match(block, /kept 1 file \(2\.0 KiB\) in the baseline/);
    assert.match(block, /1 more metric in get_run\./);
    const history = await c.page(`${RUN}/history`);
    assert.match(
      history,
      /a-fix<\/a> became champion #2, the run(&#39;|')s new starting point: the judge could measure it\. The gain counts from here\./,
    );
    assert.match(
      history,
      /The judge measured the starting point, champion #2 \(setup change <a [^>]*>a-fix<\/a>\), on every case: tok_per_s wiki 4512 ±0\.20%/,
    );
    const run = await c.mcp("get_run", { run: "s-1" });
    assert.equal(run.setup, null);
    assert.equal(run.baseline.champion_seq, 2);
    assert.equal(run.baseline.attempt, "a-fix");
    assert.deepEqual(run.baseline.files, baseline.body.files);
    assert.deepEqual(
      [...run.baseline.cells.find((x: { cell: string }) => x.cell === "code").metrics].sort(
        (x: { metric: string }, y: { metric: string }) => x.metric.localeCompare(y.metric),
      ),
      [
        { metric: "ppl_ratio", median: 1.0013, mad: 0.0002, n: 3 },
        { metric: "rss_mib", median: 790, mad: 1, n: 3 },
        { metric: "tok_per_s", median: 3999.5, mad: 20.2, n: 3 },
      ],
    );
    // The gain counts from the new starting point.
    const champ = run.champion.find((x: { seq: number }) => x.seq === 2);
    assert.equal(champ.setup, true);
    assert.equal(champ.cumulative, 1);
    const viaRest = (await c.rest("/v1/rigs/rig-a/view")) as {
      runs: { id: string; baseline: { summary: string } }[];
    };
    assert.match(
      viaRest.runs.find((r) => r.id === "s-1")?.baseline.summary ?? "",
      /^tok_per_s wiki/,
    );
  });
});
