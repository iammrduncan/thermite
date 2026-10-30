import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { sha256Hex } from "../../src/core/canonical.ts";
import { parseContract } from "../../src/core/contract.ts";
import { Ledger } from "../../src/harness/ledger/index.ts";
import { runEvents } from "../../src/harness/outbox.ts";
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
  const events = ledger.eventsAfter(0, 10_000).events;
  const ofRun = runEvents("r-1");
  const kept = events.filter(ofRun).map((e) => `${e.kind} ${e.subject}`);
  for (const kind of ["run_created r-1", "attempt_recorded r-1-a", "verdict r-1-a"])
    assert.ok(kept.includes(kind), `${kind} in ${kept.join(", ")}`);
  for (const kind of ["job_queued", "job_leased", "job_finished"])
    assert.ok(
      kept.some((k) => k.startsWith(`${kind} `)),
      `${kind} in ${kept.join(", ")}`,
    );
  assert.ok(!kept.some((k) => k.includes("r-2")), kept.join(", "));
  // r-2's job events are not r-1's: each run's export has its own.
  const theirs = events.filter(runEvents("r-2")).map((e) => `${e.kind} ${e.subject}`);
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
  ledger.copyTo(join(dir, "copy.db"), LEDGER_COPY.dropped);
  ledger.close();
  const copy = new DatabaseSync(join(dir, "copy.db"));
  assert.deepEqual(tablesOf(copy), [...LEDGER_COPY.copied].sort());
  copy.close();
});
