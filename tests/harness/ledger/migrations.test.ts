import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, test } from "node:test";
import { copiesOf } from "../../../src/common/db-copy.ts";
import { Ledger } from "../../../src/harness/ledger/index.ts";
import { LEDGER_MIGRATIONS } from "../../../src/harness/ledger/migrations.ts";

const V010 = readFileSync(
  join(import.meta.dirname, "..", "..", "helpers", "data", "ledger-v0.1.0.sql"),
  "utf8",
);
const WIN = "a-3a5f77456cc84802";
const WRONG = "a-56250d316d99442d";

/** A ledger that v0.1.0 wrote, opened by this code. */
function migrated() {
  const path = join(mkdtempSync(join(tmpdir(), "thermite-ledger-")), "ledger.db");
  const old = new DatabaseSync(path);
  old.exec(V010);
  old.close();
  return { path, ledger: Ledger.open(path) };
}

describe("the ledger's migrations (goal 125, T6)", () => {
  test("a ledger that v0.1.0 wrote is copied, then migrated, and keeps its record", () => {
    const { path, ledger } = migrated();
    const version = ledger.db.prepare("select max(version) as v from schema_migrations").get();
    assert.equal(version?.v, LEDGER_MIGRATIONS.length);
    assert.deepEqual(ledger.champions.current("js-1"), {
      seq: 2,
      commit_sha: "acebca7c8a4298c1f1fbf74c8b9c586061cd2135",
      attempt: WIN,
    });
    assert.equal(ledger.verdicts.current(WIN)?.verdict, "win_confirmed");
    assert.equal(ledger.verdicts.current(WRONG)?.verdict, "invalid");
    assert.equal(ledger.latestEventId(), 37);
    ledger.close();
    assert.deepEqual(
      copiesOf(path).map((c) => c.version),
      [21],
      "the copy is the ledger as v0.1.0 left it",
    );
    Ledger.open(path).close();
    assert.equal(copiesOf(path).length, 1, "a ledger at this code's version is not copied again");
  });

  test("every event about the run names it; the rig's own events name none (goal 170)", () => {
    const { ledger } = migrated();
    const events = ledger.eventsAfter(0, 100).events;
    const none = events.filter((e) => e.run === null).map((e) => `${e.kind} ${e.subject}`);
    assert.deepEqual(none, [
      "import_verified repo_bundle",
      "import_verified kit_bundle",
      "contract_stored js-sum",
      "command 069dac74-c4d0-4258-a64f-228921502b5a",
      ...events
        .filter((e) => e.kind === "build_recorded")
        .map((e) => `build_recorded ${e.subject}`),
    ]);
    for (const e of events.filter((e) => e.run !== null))
      assert.equal(e.run, "js-1", `${e.id} ${e.kind}`);
    assert.equal(ledger.events.count("job_finished", { subject: "4" }), 1);
    ledger.close();
  });

  test("v0.1.0's names read as today's: the review panel, the merged by model", () => {
    const { ledger } = migrated();
    const target = ledger.db.prepare("select target from agent_message").get();
    assert.equal(target?.target, "review_panel");
    assert.equal(ledger.events.newest("agent_message")?.body.to, "review_panel");
    assert.equal(ledger.events.newest("model_call")?.body.agent, "merged_by");
    ledger.close();
  });
});
