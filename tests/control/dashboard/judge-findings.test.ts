import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { KitRepos } from "../../../src/control/kits/repos.ts";
import { type GoalContract, parseContract } from "../../../src/core/contract.ts";
import { goalChecks } from "../../../src/core/goal/index.ts";
import { KitSchema } from "../../../src/core/kit.ts";
import { assigned } from "../../helpers/assignments.ts";
import { seedDemo } from "../../helpers/control-demo.ts";
import { ADMIN, controlOnly, mcpClient, signIn } from "../../helpers/control-stack.ts";
import { applied, ingestReport } from "../../helpers/control-store.ts";

/**
 * Goal 082 on control's side: what the judge found about an attempt, from the rig's events, on
 * the attempt's page, in History, over REST and over MCP.
 */

async function control(kits?: KitRepos) {
  const { store, control: api } = controlOnly({
    tokens: { rigs: { "rig-a": "t-a-abcdef" } },
    options: kits ? { kits } : {},
  });
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
  return { store, page, rest, mcp, ingest };
}

const runCreated = {
  kind: "run_created",
  subject: "sum-1",
  body: {
    campaign: "sum-speed",
    version: 1,
    mode: "hill_climb",
    seed: { repo: "proj", commit: "a".repeat(40) },
  },
};

describe("a refused change's violations on control (goal 082)", () => {
  test("the attempt's page, History, REST and get_run say why the static checks refused it", async () => {
    const c = await control();
    const violations = [
      "binary change: assets/table.bin",
      ...Array.from({ length: 19 }, (_, i) => `path not editable: bench/file-${i}.c`),
    ];
    await c.ingest([
      runCreated,
      {
        kind: "attempt_recorded",
        subject: "a-0000000000000001",
        body: {
          run: "sum-1",
          lane: "lane-2",
          lifecycle: "rejected_v0",
          commit: "b".repeat(40),
          parent: "a".repeat(40),
          hypothesis: "precomputed table",
          known_flaws: [],
          violations,
          violations_total: 23,
        },
      },
    ]);
    const page = await c.page("/ui/campaigns/sum-speed/runs/sum-1/attempts/a-0000000000000001");
    assert.match(page, /<h2>Refused before building<\/h2><span class="n">23<\/span>/);
    assert.match(page, /<div class="fw">binary change: assets\/table\.bin<\/div>/);
    assert.match(page, /and 3 more: the rig's record of the attempt keeps them all/);
    const history = await c.page("/ui/campaigns/sum-speed/runs/sum-1/history");
    assert.match(
      history,
      /The static checks refused it: binary change: assets\/table\.bin, and 22 more\./,
    );
    const view = (await c.rest("/v1/rigs/rig-a/view")) as {
      runs: { attempts: { violations: string[]; violations_total: number }[] }[];
    };
    assert.deepEqual(view.runs[0]?.attempts[0]?.violations, violations);
    assert.equal(view.runs[0]?.attempts[0]?.violations_total, 23);
    const run = await c.mcp("get_run", { run: "sum-1" });
    assert.deepEqual(run.attempts[0].violations, violations);
    assert.equal(run.attempts[0].violations_total, 23);
  });

  test("an attempt from an older harness, with no violations in its event, shows none", async () => {
    const c = await control();
    await c.ingest([
      runCreated,
      {
        kind: "attempt_recorded",
        subject: "a-0000000000000002",
        body: { run: "sum-1", lane: "lane-1", lifecycle: "rejected_v0", hypothesis: "old" },
      },
    ]);
    const page = await c.page("/ui/campaigns/sum-speed/runs/sum-1/attempts/a-0000000000000002");
    assert.doesNotMatch(page, /Refused before building/);
    const run = await c.mcp("get_run", { run: "sum-1" });
    assert.deepEqual(run.attempts[0].violations, []);
    assert.equal(run.attempts[0].violations_total, 0);
  });
});

// ------------------------------------------------------------ each goal's real check

const KIT_JSON = {
  schema_version: 1,
  name: "sum-kit",
  target: "cpu",
  build: { command: ["make"], outputs: ["out"] },
  cells: {
    small: { n: 128, flags: "--fast --check", work: 1 },
    diag: { params: { n: 8192, flags: "--full" }, timeout_s: 1800 },
    hidden: { n: 4096, secret: "HIDDEN-INPUT", work: 2 },
  },
  run: { command: ["{build:out/bench}", "{params}", "{out}"], timeout_s: 60 },
  metrics: { ops: { unit: "op/s", work: "work" } },
  check: { command: ["node", "{kit:check.mjs}"] },
  verifiers: { correct: { cells: ["small", "diag", "hidden"] } },
};

function goalContract(kitCommit: string): { contract: GoalContract; sha: string } {
  const p = parseContract({
    schema_version: 1,
    campaign: "sum-goals",
    version: 1,
    title: "Sum goals",
    mode: "goal",
    project: { repo: "proj", commit: "a".repeat(40), kit: { repo: "sum-kit", commit: kitCommit } },
    target: { type: "cpu", class: "test" },
    goals: [
      {
        id: "correct",
        description: "still correct",
        verify: { type: "code", verifier: "correct" },
      },
      {
        id: "fast",
        description: "fast enough",
        verify: { type: "metric_threshold", metric: "ops", op: ">=", value: 5e7, cells: ["small"] },
      },
    ],
    deliverable: "a commit",
    editable_paths: ["src/**"],
    held_out_cells: ["hidden"],
  });
  assert.ok(p.ok && p.contract.mode === "goal", JSON.stringify(p));
  return { contract: p.contract as GoalContract, sha: p.sha };
}

const goalRun = {
  kind: "run_created",
  subject: "sum-1",
  body: {
    campaign: "sum-goals",
    version: 1,
    mode: "goal",
    seed: { repo: "proj", commit: "a".repeat(40) },
  },
};

describe("each goal's real check on control (goal 082)", () => {
  test("a run's Goals block: how each goal is checked, as its rig's kit runs it", async () => {
    const c = await control();
    const { contract } = goalContract("b".repeat(40));
    const checks = goalChecks(contract, {
      kit: KitSchema.parse(KIT_JSON),
      repo: "sum-kit",
      commit: "b".repeat(40),
    });
    await c.ingest([
      goalRun,
      { kind: "goal_checks", subject: "sum-1", body: checks as unknown as Record<string, unknown> },
    ]);
    // Before the judge checked any goal, the goals and their checks show.
    const before = await c.page("/ui/campaigns/sum-goals/runs/sum-1");
    assert.match(before, /The judge has not checked the goals yet\./);
    assert.match(before, /<summary>How it is checked<\/summary>/);
    await c.ingest([
      {
        kind: "goal_report",
        subject: "sum-1",
        body: {
          run: "sum-1",
          champion_seq: 1,
          goals: [
            { goal: "correct", description: "still correct", status: "met", reasons: "ok" },
            { goal: "fast", description: "fast enough", status: "unmet", reasons: "slow" },
          ],
          complete: false,
        },
      },
    ]);
    const run = await c.page("/ui/campaigns/sum-goals/runs/sum-1");
    assert.equal((run.match(/<summary>How it is checked<\/summary>/g) ?? []).length, 2);
    assert.match(
      run,
      /The kit's verifier <b>correct<\/b>: the goal is met when the kit's check passes/,
    );
    assert.match(
      run,
      /<td><code>small<\/code><\/td><td><code>n=128 flags=--fast --check work=1<\/code><\/td><td>60 s<\/td>/,
    );
    assert.match(
      run,
      /<td><code>diag<\/code><\/td><td><code>n=8192 flags=--full<\/code><\/td><td>1800 s <span class="muted small">\(its own\)<\/span><\/td>/,
    );
    assert.match(run, /<td><code>hidden<\/code><\/td><td><span class="chip">held out<\/span>/);
    assert.match(
      run,
      /<code>ops &gt;= 5\.000e7<\/code> op\/s on each case below: the judge runs each case 5 times/,
    );
    assert.match(run, /Each run: <code>\{build:out\/bench\} \{params\} \{out\}<\/code>/);
    assert.match(
      run,
      /As rig-a's kit runs it: sum-kit at <code>bbbbbbbbbbbb<\/code>, reported when the run started\./,
    );
    assert.ok(!run.includes("HIDDEN-INPUT"), "a held-out case's input is never shown");
    // Over MCP and REST too, with the held-out case by name only.
    const viaMcp = await c.mcp("get_run", { run: "sum-1" });
    assert.equal(viaMcp.goal_checks.goals[0].cells[2].name, "hidden");
    assert.equal(viaMcp.goal_checks.goals[0].cells[2].params, undefined);
    assert.ok(!JSON.stringify(await c.rest("/v1/rigs/rig-a/view")).includes("HIDDEN-INPUT"));
  });

  test("a campaign's page: from the kit control keeps, else what the contract says", async () => {
    const dir = mkdtempSync(join(tmpdir(), "thermite-kits-"));
    try {
      const kits = new KitRepos(dir);
      const commit = kits.commit(
        "sum-kit",
        { "kit.json": Buffer.from(JSON.stringify(KIT_JSON)) },
        "the kit",
      );
      const c = await control(kits);
      const { contract, sha } = goalContract(commit);
      c.store.campaigns.put({
        campaign: "sum-goals",
        version: 1,
        contract,
        sha,
        sources: { kit: { control: "kits/sum-kit" } },
        by: "owner",
      });
      // Saved, with no run yet.
      const saved = await c.page("/ui/campaigns/sum-goals");
      assert.match(saved, /<h2>Goals<\/h2><span class="n">2<\/span>/);
      assert.match(saved, /From the kit control keeps: sum-kit at <code>[0-9a-f]{12}<\/code>\./);
      assert.match(
        saved,
        /<td><code>diag<\/code><\/td><td><code>n=8192 flags=--full<\/code><\/td>/,
      );
      assert.ok(!saved.includes("HIDDEN-INPUT"));
      // With a run control assigned, on the campaign's own page.
      assigned(c.store, "rig-a", "sum-1", "sum-goals");
      await c.ingest([goalRun]);
      const withRun = await c.page("/ui/campaigns/sum-goals");
      assert.match(withRun, /<summary>How each goal is checked<\/summary>/);
      assert.match(withRun, /From the kit control keeps/);

      // A kit only in its repository: what the contract says, and why no more.
      const other = await control();
      const plain = goalContract("c".repeat(40));
      other.store.campaigns.put({
        campaign: "sum-goals",
        version: 1,
        contract: plain.contract,
        sha: plain.sha,
        sources: { kit: { git: "https://git.example.com/sum-kit.git" } },
        by: "owner",
      });
      const page = await other.page("/ui/campaigns/sum-goals");
      assert.match(
        page,
        /Control keeps no copy of this campaign's kit, which is in its repository/,
      );
      assert.match(page, /Its cases are in the kit, which control can't read here\./);
      // A threshold names its cases in the contract: their names show.
      assert.match(page, /<td><code>small<\/code><\/td><td><span class="muted">·<\/span><\/td>/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the dashboard demo's goal checks (goal 082)", () => {
  test("a goal run reported by its rig: its Goals block and its campaign's page show how each goal is checked", async () => {
    const c = await control();
    await seedDemo(c.store);
    await applied(c.store);
    const run = await c.page("/ui/campaigns/opus-simd/runs/dec-2");
    assert.match(run, /<summary>How it is checked<\/summary>/);
    assert.match(
      run,
      /<td><code>conformance-held<\/code><\/td><td><span class="chip">held out<\/span>/,
    );
    assert.match(
      run,
      /<td><code>conformance<\/code><\/td><td><code>set=rfc8251 mode=bit-exact<\/code><\/td><td>900 s <span class="muted small">\(its own\)<\/span><\/td>/,
    );
    assert.match(run, /<code>frame_ms &lt; 20<\/code> ms on each case below/);
    const campaign = await c.page("/ui/campaigns/opus-simd");
    assert.match(campaign, /<summary>How each goal is checked<\/summary>/);
    assert.match(campaign, /As rig-b's kit runs it: opus-kit at <code>0ddba11c0ffe<\/code>/);
  });
});
