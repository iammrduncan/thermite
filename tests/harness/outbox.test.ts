import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { sha256Hex } from "../../src/core/canonical.ts";
import { parseContract } from "../../src/core/contract.ts";
import { Ledger } from "../../src/harness/ledger/index.ts";
import { LEDGER_COPY_EVERY_MS, writeExport } from "../../src/harness/outbox.ts";
import { hillClimbFixture } from "../helpers/fixtures.ts";

test("a run's export takes its attempts' verdicts and its judge's jobs, and no other run's (goal 170)", () => {
  const ledger = Ledger.open(join(mkdtempSync(join(tmpdir(), "thermite-run-export-")), "l.db"));
  const parsed = parseContract(hillClimbFixture);
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  ledger.contracts.store(parsed.contract, parsed.sha, "test");
  // Two runs, each with an attempt the judge measured and judged.
  for (const run of ["r-1", "r-2"]) {
    ledger.runs.create({
      id: run,
      contract: parsed.contract,
      contractSha: parsed.sha,
      seedRepo: "smoke",
      seedCommit: "a".repeat(40),
      actor: "test",
    });
    const id = `${run}-a`;
    ledger.attempts.record(
      {
        id,
        run,
        parentRef: "seed",
        parentCommit: "a".repeat(40),
        baselineChampionSeq: 1,
        commitSha: sha256Hex(id).slice(0, 40),
        ref: `refs/thermite/attempts/${id}`,
        diffSha: id,
        normalizedDiffSha: id,
        lifecycle: "submitted",
      },
      "test",
    );
    ledger.jobs.enqueue({ attempt: id, kind: "evaluate", actor: "judge" });
    const job = ledger.jobs.lease("judge", 60_000);
    assert.ok(job);
    ledger.jobs.complete(job.id, job.fence, "done", {});
    ledger.verdicts.record({
      attempt: id,
      verdict: "win_confirmed",
      reasons: "t",
      judgedBy: "judge",
    });
  }
  const ofRun = (run: string) =>
    ledger.eventsAfter(0, 10_000, run).events.map((e) => `${e.kind} ${e.subject}`);
  const kept = ofRun("r-1");
  for (const kind of ["run_created r-1", "attempt_recorded r-1-a", "verdict r-1-a"])
    assert.ok(kept.includes(kind), `${kind} in ${kept.join(", ")}`);
  for (const kind of ["job_queued", "job_leased", "job_finished"])
    assert.ok(
      kept.some((k) => k.startsWith(`${kind} `)),
      `${kind} in ${kept.join(", ")}`,
    );
  assert.ok(!kept.some((k) => k.includes("r-2")), kept.join(", "));
  // r-2's job events are not r-1's: each run's export has its own.
  const theirs = ofRun("r-2");
  assert.equal(
    kept.filter((k) => k.startsWith("job_")).length,
    theirs.filter((k) => k.startsWith("job_")).length,
  );
  assert.deepEqual(
    kept.filter((k) => k.startsWith("job_")).filter((k) => theirs.includes(k)),
    [],
  );
});

test("each of the ledger's tables is placed on purpose in an export's copy: copied, or dropped", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { LEDGER_COPY } = await import("../../src/harness/outbox.ts");
  const dir = mkdtempSync(join(tmpdir(), "thermite-ledger-copy-"));
  const ledger = Ledger.open(join(dir, "l.db"));
  const tablesOf = (db: { prepare(sql: string): { all(): unknown[] } }) =>
    (
      db.prepare("select name from sqlite_master where type = 'table' order by name").all() as {
        name: string;
      }[]
    )
      .map((r) => r.name)
      .filter((n) => !n.startsWith("sqlite_"));
  const placed = [...LEDGER_COPY.copied, ...LEDGER_COPY.dropped].sort();
  // A table on neither list fails here: put it on one, on purpose (src/harness/outbox.ts).
  assert.deepEqual(tablesOf(ledger.db), placed);
  // A held-out record, written as the judge writes one (constraints set aside: only its bytes
  // matter here). Nothing of it may stay in the copy's file, in one vacuum.
  const secret = "HELD-OUT-CELL-THE-AGENTS-NEVER-SEE";
  ledger.db.exec("pragma foreign_keys = off; pragma ignore_check_constraints = on");
  for (let i = 0; i < 200; i++)
    ledger.db
      .prepare(
        "insert into held_out (job, fence, attempt, pass, detail, created_at) values (?, 1, 'a', 1, ?, 'x')",
      )
      .run(i + 1, `${secret}-${i}`);
  ledger.copyTo(join(dir, "copy.db"), LEDGER_COPY.dropped);
  ledger.close();
  assert.ok(!readFileSync(join(dir, "copy.db")).includes(secret), "no byte of held_out is left");
  const copy = new DatabaseSync(join(dir, "copy.db"));
  assert.deepEqual(tablesOf(copy), [...LEDGER_COPY.copied].sort());
  copy.close();
});

test("an export of the chain holds a copy of the ledger once a day; a full export always; a run's never", async () => {
  const dir = mkdtempSync(join(tmpdir(), "thermite-ledger-due-"));
  let now = Date.parse("2026-10-31T00:00:00Z");
  const ledger = Ledger.open(join(dir, "l.db"), () => new Date(now));
  const exportOf = (o: { full?: boolean; run?: string } = {}) =>
    writeExport({ ledger, mirrorFor: () => "", outboxDir: dir, rig: "rig-a", actor: "test", ...o });
  const holds = (r: { dir: string }) =>
    "ledger.sqlite" in
    (JSON.parse(readFileSync(join(r.dir, "manifest.json"), "utf8")) as { files: object }).files;
  assert.equal(holds(await exportOf()), true, "the first export holds one");
  now += 3_600_000;
  assert.equal(holds(await exportOf()), false, "an hour later: none");
  assert.equal(holds(await exportOf({ full: true })), true, "a full export: always");
  now += LEDGER_COPY_EVERY_MS - 1;
  assert.equal(holds(await exportOf()), false, "within a day of the full export's copy: none");
  now += 1;
  assert.equal(holds(await exportOf()), true, "a day after it: one");
  assert.equal(holds(await exportOf({ run: "r-1" })), false, "a run's export: never");
});

test("an export reads its events a page at a time, by run for a run's export, and hashes each file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "thermite-paged-export-"));
  const ledger = Ledger.open(join(dir, "l.db"));
  const parsed = parseContract(hillClimbFixture);
  if (!parsed.ok) throw new Error(parsed.errors.join("; "));
  ledger.contracts.store(parsed.contract, parsed.sha, "test");
  for (const run of ["r-1", "r-2"])
    ledger.runs.create({
      id: run,
      contract: parsed.contract,
      contractSha: parsed.sha,
      seedRepo: "smoke",
      seedCommit: "a".repeat(40),
      actor: "test",
    });
  // More events than three pages of an export, the two runs' interleaved.
  for (let i = 0; i < 2_500; i++)
    ledger.appendEvent("test", "run_status", i % 2 ? "r-2" : "r-1", {
      status: "running",
      reason: null,
    });
  const lines = (d: string) => readFileSync(join(d, "events.jsonl"), "utf8").trimEnd().split("\n");
  const all = await writeExport({
    ledger,
    mirrorFor: () => "",
    outboxDir: dir,
    rig: "rig-a",
    actor: "test",
  });
  const ids = lines(all.dir).map((l) => (JSON.parse(l) as { id: number }).id);
  const chain = JSON.parse(readFileSync(join(all.dir, "manifest.json"), "utf8")) as {
    through_event: number;
  };
  assert.ok(chain.through_event > 2_500);
  assert.equal(all.events, chain.through_event);
  assert.deepEqual(
    ids,
    Array.from({ length: ids.length }, (_, i) => i + 1),
    "each event once, in order",
  );
  const one = await writeExport({
    ledger,
    mirrorFor: () => "",
    outboxDir: dir,
    rig: "rig-a",
    actor: "test",
    run: "r-1",
  });
  const own = ledger.eventsAfter(0, 10_000, "r-1").events.map((e) => e.id);
  assert.ok(own.length > 1_250);
  assert.deepEqual(
    lines(one.dir).map((l) => (JSON.parse(l) as { id: number }).id),
    own,
  );
  assert.equal(one.events, own.length);
  const manifest = JSON.parse(readFileSync(join(one.dir, "manifest.json"), "utf8")) as {
    files: Record<string, string>;
  };
  assert.equal(
    manifest.files["events.jsonl"],
    sha256Hex(readFileSync(join(one.dir, "events.jsonl"))),
  );
});
