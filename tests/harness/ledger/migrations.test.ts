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

/**
 * The rows and events a v0.1.0 rig wrote under the old names (the guide's questions 11 and 23):
 * an approach family, a run's note in `direction`, a field note of kind `note`, a rule of kind
 * `note`, a research note.
 */
const OLD_NAMES = `
update run set direction = 'memory first' where id = 'js-1';
insert into family (run, id, description, status, created_by, created_at)
  values ('js-1', 'tiling', 'tile the loops', 'live', 'planner', '2026-10-27T22:00:00.000Z');
insert into lane (id, run, family, status, created_at)
  values ('js-1:lane-1', 'js-1', 'tiling', 'active', '2026-10-27T22:00:00.000Z');
update attempt set family = 'tiling' where id = '${WIN}';
insert into trial (id, run, lane, epoch, family, parent_commit, started_at)
  values ('0123456789abcdef', 'js-1', 'lane-1', 1, 'tiling', 'f34374b5a2b3fb71dd7da851d3273d1a0357a803', '2026-10-27T22:00:00.000Z');
insert into experiment (id, run, title, family, added_by, state, created_at, updated_at)
  values ('x-000000000001', 'js-1', 'tile it', 'tiling', 'planner', 'queued', '2026-10-27T22:00:00.000Z', '2026-10-27T22:00:00.000Z');
insert into directive (run, author, body, created_at) values
  ('js-1', 'control:owner', '{"citations":[],"family":"tiling","kind":"try","rationale":"won elsewhere"}', '2026-10-27T22:00:00.000Z'),
  ('js-1', 'control:owner', '{"citations":[],"kind":"note","rationale":"r","value":"memory first"}', '2026-10-27T22:00:00.000Z');
insert into epoch (run, n, source, planner_tries, planner_valid, assignments, started_at)
  values ('js-1', 1, 'planner', 1, 1, '[{"family":"tiling","focus":"f","lane":"lane-1","parent":"champion"}]', '2026-10-27T22:00:00.000Z');
insert into conclusion (run, kind, evidence, proposed_at)
  values ('js-1', 'not_possible', '{"approaches":[{"attempts":3,"family":"tiling"}]}', '2026-10-27T22:00:00.000Z');
insert into journal_note (run, by, kind, text, about_type, about_id, at)
  values ('js-1', 'lane-1', 'note', 'an aside', 'run', 'js-1', '2026-10-27T22:00:00.000Z');
insert into note (run, lane, text, sources, created_at)
  values ('js-1', 'lane-1', 'the guide says so', '["s-1"]', '2026-10-27T22:00:00.000Z');
insert into event (at, actor, kind, subject, body) values
  ('2026-10-27T22:00:01.000Z', 'planner', 'family_added', 'js-1', '{"description":"tile the loops","family":"tiling"}'),
  ('2026-10-27T22:00:02.000Z', 'harness', 'trial_started', 'js-1', '{"epoch":1,"family":"tiling","lane":"lane-1","trial":"0123456789abcdef"}'),
  ('2026-10-27T22:00:03.000Z', 'control:owner', 'directive', 'js-1', '{"body":{"kind":"note","rationale":"r","value":"memory first"},"id":2}'),
  ('2026-10-27T22:00:04.000Z', 'lane-1', 'journal_note', 'js-1', '{"about":{"id":"js-1","type":"run"},"by":"lane-1","id":1,"kind":"note","text":"an aside"}'),
  ('2026-10-27T22:00:05.000Z', 'lane-1', 'research_note', 'js-1', '{"by":"lane-1","note":1,"sources":["s-1"],"text":"the guide says so"}');
`;

/** A v0.1.0 ledger with rows and events under the old names, opened by this code. */
function migratedWithOldNames() {
  const path = join(mkdtempSync(join(tmpdir(), "thermite-ledger-")), "ledger.db");
  const old = new DatabaseSync(path);
  old.exec(V010);
  old.exec(OLD_NAMES);
  old.close();
  return Ledger.open(path);
}

describe("the public names in a ledger v0.1.0 wrote (goal 125, the guide's questions 11 and 23)", () => {
  test("the rows a ledger may change are migrated: directions, a run's note, the kinds, source notes", () => {
    const ledger = migratedWithOldNames();
    const columns = (table: string) =>
      (ledger.db.prepare(`pragma table_info(${table})`).all() as { name: string }[]).map(
        (c) => c.name,
      );
    const tables = (
      ledger.db.prepare("select name from sqlite_master where type = 'table'").all() as {
        name: string;
      }[]
    ).map((t) => t.name);
    assert.ok(!tables.includes("family") && !tables.includes("note"), tables.join(", "));
    assert.ok(tables.includes("direction") && tables.includes("source_note"));
    for (const table of ["trial", "lane", "attempt", "experiment"]) {
      assert.ok(columns(table).includes("direction"), table);
      assert.ok(!columns(table).includes("family"), table);
    }
    assert.ok(columns("run").includes("note") && !columns("run").includes("direction"));
    // Each reads the same, under the new names.
    assert.equal(ledger.runs.get("js-1")?.note, "memory first");
    assert.deepEqual(ledger.trials.directions("js-1"), [
      { id: "tiling", description: "tile the loops", status: "live" },
    ]);
    assert.deepEqual(ledger.attempts.directions("js-1"), ["tiling"]);
    assert.equal(ledger.experiments.get("x-000000000001")?.direction, "tiling");
    assert.deepEqual(
      ledger.directives.active("js-1").map((d) => d.body),
      [
        { citations: [], direction: "tiling", kind: "try", rationale: "won elsewhere" },
        { citations: [], kind: "planner_note", rationale: "r", value: "memory first" },
      ],
    );
    const epoch = ledger.db.prepare("select assignments from epoch where run = 'js-1'").get();
    assert.deepEqual(JSON.parse(String(epoch?.assignments)), [
      { direction: "tiling", focus: "f", lane: "lane-1", parent: "champion" },
    ]);
    const conclusion = ledger.db.prepare("select evidence from conclusion").get();
    assert.deepEqual(JSON.parse(String(conclusion?.evidence)), {
      approaches: [{ attempts: 3, direction: "tiling" }],
    });
    assert.deepEqual(
      ledger.journal.newest("js-1", 5, {}).map((n) => [n.kind, n.text]),
      [["other", "an aside"]],
    );
    assert.deepEqual(
      ledger.claims.sourceNotes("js-1").map((n) => n.text),
      ["the guide says so"],
    );
    // A field note's kind is still checked, and field notes stay append-only.
    assert.throws(
      () =>
        ledger.db
          .prepare(
            "insert into journal_note (run, by, kind, text, about_type, about_id, at) values ('js-1', 'x', 'note', 't', 'run', 'js-1', 'now')",
          )
          .run(),
      /CHECK constraint/,
    );
    assert.throws(
      () => ledger.db.prepare("update journal_note set text = 'x'").run(),
      /append-only/,
    );
    ledger.close();
  });

  test("events keep the words they were recorded with, and read under the new names", () => {
    const ledger = migratedWithOldNames();
    const raw = ledger.db
      .prepare("select kind from event where kind in ('family_added', 'research_note')")
      .all() as { kind: string }[];
    assert.deepEqual(
      raw.map((r) => r.kind),
      ["family_added", "research_note"],
      "an event is never rewritten",
    );
    assert.deepEqual(ledger.events.newest("direction_added")?.body, {
      description: "tile the loops",
      direction: "tiling",
    });
    assert.equal(ledger.events.newest("trial_started")?.body.direction, "tiling");
    assert.equal(ledger.events.newest("run_created")?.body.note, null);
    assert.deepEqual(ledger.events.newest("directive")?.body.body, {
      kind: "planner_note",
      rationale: "r",
      value: "memory first",
    });
    assert.equal(ledger.events.newest("journal_note")?.body.kind, "other");
    assert.equal(ledger.events.newest("source_note")?.body.text, "the guide says so");
    ledger.close();
  });
});
