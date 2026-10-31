import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, test } from "node:test";
import { Registry } from "../../../src/harness/agents/registry.ts";
import { Ledger } from "../../../src/harness/ledger/index.ts";
import { LEDGER_MIGRATIONS } from "../../../src/harness/ledger/migrations.ts";
import { eventRun } from "../../../src/harness/ledger/runs.ts";
import { makeJudgeEnv } from "../../helpers/judge-env.ts";

/**
 * Every run-scoped event names its run (goal 170): the ledger works it out when it records the
 * event, from the event's subject or body, and the rig's own events name none.
 */
describe("each event's run", () => {
  test("from the run, an attempt, a job, a trial, an experiment or the body; none for the rig's own", async () => {
    const env = makeJudgeEnv();
    await env.start();
    const run = (env.assign.envelope.payload as { run: string }).run;
    const ledger = env.ledger;
    const { attempt } = await env.service.submitAttempt(
      { run, patch_base64: env.patch("// a change\n"), hypothesis: "h", known_flaws: [] },
      "t",
    );
    new Registry(ledger).startTrial({
      id: "t-0123456789abcdef",
      run,
      lane: "lane-1",
      epoch: 1,
      family: "f",
      parent: "champion",
      token: "tok",
    });
    await env.service.applyCommand(env.sign("queue_add", { run, title: "Unroll the loop" }));
    const experiment = String(
      (ledger.db.prepare("select id from experiment where run = ?").get(run) as { id: string }).id,
    );
    const job = String(
      (ledger.db.prepare("select id from job where attempt = ?").get(attempt) as { id: number }).id,
    );
    const of = (kind: string, subject: string | null, body: unknown = {}) =>
      eventRun(ledger.db, kind, subject, body);
    assert.equal(of("run_status", run), run);
    assert.equal(of("verdict", attempt), run);
    assert.equal(of("job_leased", job), run);
    assert.equal(of("trial_stopped", "t-0123456789abcdef"), run);
    assert.equal(of("experiment_moved", experiment), run);
    assert.equal(of("audit_requested", "7", { run }), run, "the body names it");
    // The rig's own: a command, the model route, a contract (whose subject is its campaign).
    assert.equal(of("command", "0f1e2d3c-0000-4000-8000-000000000000"), null);
    assert.equal(of("model_route_set", null), null);
    assert.equal(of("contract_stored", run), null);
    // Every event the ledger holds now carries its run, as recorded.
    const events = ledger.eventsAfter(0, 10_000).events;
    for (const e of events.filter((x) => x.kind === "run_created" || x.kind === "job_queued"))
      assert.equal(e.run, run, `${e.kind} ${e.subject}`);
    for (const e of events.filter((x) => x.kind === "command")) assert.equal(e.run, null);
  });

  test("a ledger from before has its events' runs worked out once, by its migration", () => {
    const path = join(mkdtempSync(join(tmpdir(), "thermite-ledger-")), "ledger.db");
    const db = new DatabaseSync(path);
    db.exec("create table schema_migrations (version integer primary key)");
    LEDGER_MIGRATIONS.slice(0, 22).forEach((m, i) => {
      if (typeof m === "string") db.exec(m);
      else m(db);
      db.prepare("insert into schema_migrations (version) values (?)").run(i + 1);
    });
    const at = "2026-10-26T00:00:00.000Z";
    // A run without its contract's row, enough for its events.
    db.exec("pragma foreign_keys = off");
    db.prepare(
      `insert into run (id, campaign, version, contract_sha, mode, seed_repo, seed_commit, status,
         created_at, updated_at) values ('r-1', 'c', 1, 'sha', 'hill_climb', 'repo', ?, 'running', ?, ?)`,
    ).run("a".repeat(40), at, at);
    const event = db.prepare(
      "insert into event (at, actor, kind, subject, body) values (?, 'harness', ?, ?, ?)",
    );
    event.run(at, "run_status", "r-1", "{}");
    event.run(at, "audit_requested", "3", '{"run":"r-1"}');
    event.run(at, "model_route_set", null, "{}");
    db.close();
    const ledger = Ledger.open(path);
    assert.deepEqual(
      ledger.eventsAfter(0, 10).events.map((e) => [e.kind, e.run]),
      [
        ["run_status", "r-1"],
        ["audit_requested", "r-1"],
        ["model_route_set", null],
      ],
    );
    // Still append-only.
    assert.throws(() => ledger.db.exec("update event set run = 'x'"), /append-only/);
    ledger.close();
  });
});
