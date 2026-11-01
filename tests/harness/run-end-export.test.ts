import assert from "node:assert/strict";
import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { GIB } from "../../src/common/disk.ts";
import { generateSigningKeys } from "../../src/core/commands.ts";
import { type Contract, parseContract } from "../../src/core/contract.ts";
import { RIG_CHECK_PREFIX } from "../../src/core/ids.ts";
import { DiskWatch } from "../../src/harness/disk.ts";
import { Ledger } from "../../src/harness/ledger/index.ts";
import { HarnessService } from "../../src/harness/service/index.ts";
import { HARNESS_NUMBERS, harnessNumbers } from "../../src/harness/settings.ts";
import { hillClimbFixture, researchFixture } from "../helpers/fixtures.ts";
import { type HarnessEnv, makeHarnessEnv } from "../helpers/harness-env.ts";
import { appendOther } from "../helpers/kinds.ts";

/**
 * Each run's export at its end (the owner's decision of 2026-11-01): no export comes on a timer.
 * Once a run is closed and its closing work is done, the harness writes that run's export, once,
 * and records it in the ledger, so a restart exports a run that closed without one and never one
 * twice. The rig's Exports setting turns it off.
 */

const RUN = "smoke-1";

/** A harness with its run assigned and running. */
async function assigned(): Promise<HarnessEnv> {
  const env = makeHarnessEnv();
  const out = await env.service.applyCommand(env.sign("assign_campaign", env.assignPayload()));
  assert.ok(out.status === "applied" && out.accepted, JSON.stringify(out));
  return env;
}

async function command(env: HarnessEnv, kind: "close_run" | "rig_settings", payload: unknown) {
  const out = await env.service.applyCommand(env.sign(kind, payload));
  assert.ok(out.status === "applied" && out.accepted, JSON.stringify(out));
}

const close = (env: HarnessEnv, run = RUN) => command(env, "close_run", { run, reason: "done" });

/** The exports in the outbox, each with its manifest. */
function outbox(env: HarnessEnv): { name: string; manifest: Record<string, unknown> }[] {
  const dir = env.service.paths.outboxDir;
  return readdirSync(dir)
    .filter((n) => !n.startsWith("."))
    .sort()
    .map((name) => ({
      name,
      manifest: JSON.parse(readFileSync(join(dir, name, "manifest.json"), "utf8")),
    }));
}

const endEvents = (ledger: Ledger, run = RUN) =>
  ledger.events.list("run_end_exported", { subject: run });

/** The same harness started again: a new service over the same ledger and folders. */
function restarted(env: HarnessEnv): HarnessService {
  env.service.ledger.close();
  const ledger = Ledger.open(join(env.service.paths.stateDir, "ledger", "ledger.db"));
  return new HarnessService({
    rig: env.service.rig,
    ledger,
    paths: env.service.paths,
    controlPublicKeyPem: env.keys.publicKeyPem,
    rigKeys: generateSigningKeys(),
  });
}

describe("each run's export at its end", () => {
  test("nothing is exported on a timer: a running run exports nothing, and no setting sets a period", async () => {
    let now = Date.parse("2026-11-01T00:00:00Z");
    const env = makeHarnessEnv("rig-a", () => new Date(now));
    await env.service.applyCommand(env.sign("assign_campaign", env.assignPayload()));
    for (const hours of [1, 2, 25]) {
      now += hours * 3_600_000;
      env.service.ledger.appendEvent("test", "run_status", RUN, {
        status: "running",
        reason: null,
      });
      assert.deepEqual(await env.service.exportRunEnds("harness"), []);
    }
    assert.deepEqual(outbox(env), [], "no export in the outbox");
    assert.equal(env.service.ledger.exports.last(), undefined, "no export of the chain either");
    assert.ok(!("exportEveryMs" in harnessNumbers({})), "the harness reads no export period");
    assert.ok(
      !Object.values(HARNESS_NUMBERS).some((s) => s.name === "THERMITE_EXPORT_MINUTES"),
      "THERMITE_EXPORT_MINUTES is gone",
    );
  });

  test("a closed run is exported once, alone, its manifest saying it is the run's end", async () => {
    const env = await assigned();
    assert.deepEqual(await env.service.exportRunEnds("harness"), [], "still running");
    await close(env);
    const written = await env.service.exportRunEnds("harness");
    assert.equal(written.length, 1);
    const [only] = outbox(env);
    assert.ok(only, "one export in the outbox");
    assert.equal(only.name, written[0]);
    assert.equal(only.manifest.run, RUN);
    assert.equal(only.manifest.end, true);
    assert.ok(!("ledger.sqlite" in (only.manifest.files as object)), "no copy of the ledger");
    const events = endEvents(env.service.ledger);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.body.export, written[0]);
    assert.equal(events[0]?.body.through_event, only.manifest.through_event);
    // Asked again, now and later: nothing more.
    assert.deepEqual(await env.service.exportRunEnds("harness"), []);
    assert.deepEqual(await env.service.exportRunEnds("harness"), []);
    assert.equal(outbox(env).length, 1);
    assert.equal(endEvents(env.service.ledger).length, 1);
    // Outside the chain: the rig's next export of what changed still starts at the beginning.
    assert.equal(env.service.ledger.exports.last(), undefined);
  });

  test("a restart between the close and the export exports the run then, once", async () => {
    const env = await assigned();
    await close(env);
    // The harness stops before its exports loop came around.
    const again = restarted(env);
    assert.equal(again.recordRunEndsInOutbox(), 0);
    const written = await again.exportRunEnds("harness");
    assert.equal(written.length, 1);
    assert.deepEqual(await again.exportRunEnds("harness"), []);
    // And once more: a later start finds the record and exports nothing.
    const third = restarted({ ...env, service: again });
    assert.equal(third.recordRunEndsInOutbox(), 0);
    assert.deepEqual(await third.exportRunEnds("harness"), []);
    assert.equal(outbox(env).length, 1);
    assert.equal(endEvents(third.ledger).length, 1);
  });

  test("an export written just before a crash, not yet recorded, is recorded at the start and not written again", async () => {
    const env = await assigned();
    await close(env);
    // As exportRunEnds writes it, with the process gone before its record.
    const out = await env.service.export("harness", { run: RUN, end: true });
    assert.equal(endEvents(env.service.ledger).length, 0);
    const again = restarted(env);
    assert.equal(again.recordRunEndsInOutbox(), 1);
    const events = endEvents(again.ledger);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.body.export, out.name);
    assert.deepEqual(await again.exportRunEnds("harness"), []);
    assert.equal(outbox(env).length, 1);
    // A run's export someone asked for is no end export: it is not taken for one.
    assert.equal(again.recordRunEndsInOutbox(), 0);
  });

  test("with the Exports setting off, a run that ends is not exported; it is once the setting is on again", async () => {
    const env = await assigned();
    await command(env, "rig_settings", { exports: false });
    await close(env);
    assert.deepEqual(await env.service.exportRunEnds("harness"), []);
    assert.deepEqual(outbox(env), []);
    await command(env, "rig_settings", { exports: true });
    assert.equal((await env.service.exportRunEnds("harness")).length, 1);
    assert.equal(endEvents(env.service.ledger).length, 1);
  });

  test("it waits for the run's trials and the judge's job under way, and a research run's final report", async () => {
    const env = await assigned();
    const { ledger } = env.service;
    ledger.trials.startTrial({
      id: "t-1",
      run: RUN,
      lane: "lane-1",
      epoch: 1,
      family: "f",
      parent: env.seedCommit,
    });
    // A judge's job under way for it: the first of its jobs the judge leases.
    ledger.jobs.enqueue({ kind: "calibration", spec: { run: RUN }, actor: "test" });
    const job = ledger.jobs.lease("judge-1", 3_600_000);
    assert.ok(job, "a job of the run is leased");
    await close(env);
    assert.deepEqual(await env.service.exportRunEnds("harness"), [], "its trial still runs");
    ledger.trials.finishTrial("t-1", {
      stopped: "interrupted",
      turns: 0,
      toolCalls: 0,
      tokensIn: 0,
      tokensOut: 0,
    });
    assert.deepEqual(
      await env.service.exportRunEnds("harness"),
      [],
      "the judge's job is under way",
    );
    ledger.jobs.complete(job.id, job.fence, "done", {});
    assert.equal((await env.service.exportRunEnds("harness")).length, 1, "once both ended");

    // A research run closed by the owner: its final report comes after its close.
    const parsed = parseContract(researchFixture);
    if (!parsed.ok) throw new Error(parsed.errors.join("; "));
    ledger.contracts.store(parsed.contract, parsed.sha, "test");
    ledger.runs.create({
      id: "survey-1",
      contract: parsed.contract,
      contractSha: parsed.sha,
      seedRepo: "smoke-kernels",
      seedCommit: env.seedCommit,
      actor: "test",
    });
    ledger.runs.setStatus("survey-1", "closed", "done", "owner");
    assert.deepEqual(await env.service.exportRunEnds("harness"), [], "its final report is due");
    // Its final report failed in this process: it goes without it.
    const failed = await env.service.exportRunEnds("harness", (run) => run === "survey-1");
    assert.equal(failed.length, 1);
    assert.equal(endEvents(ledger, "survey-1").length, 1);
  });

  test("a research run's end goes once its final report is written", async () => {
    const env = makeHarnessEnv();
    const { ledger } = env.service;
    const parsed = parseContract(researchFixture);
    if (!parsed.ok) throw new Error(parsed.errors.join("; "));
    ledger.contracts.store(parsed.contract, parsed.sha, "test");
    ledger.runs.create({
      id: "survey-1",
      contract: parsed.contract,
      contractSha: parsed.sha,
      seedRepo: "smoke-kernels",
      seedCommit: env.seedCommit,
      actor: "test",
    });
    ledger.runs.setStatus("survey-1", "closed", "done", "owner");
    assert.deepEqual(await env.service.exportRunEnds("harness"), []);
    appendOther(ledger, "harness", "research_final", "survey-1", { run: "survey-1" });
    assert.equal((await env.service.exportRunEnds("harness")).length, 1);
  });

  test("the rig's checks export nothing, and a run closed before this version is not exported at its end", async () => {
    const env = makeHarnessEnv();
    const { ledger } = env.service;
    const parsed = parseContract({
      ...hillClimbFixture,
      campaign: `${RIG_CHECK_PREFIX}smoke-cpu-0123abcd`,
    });
    if (!parsed.ok) throw new Error(parsed.errors.join("; "));
    ledger.contracts.store(parsed.contract, parsed.sha, "test");
    const run = (id: string) => {
      ledger.runs.create({
        id,
        contract: parsed.contract,
        contractSha: parsed.sha,
        seedRepo: "smoke-kernels",
        seedCommit: env.seedCommit,
        actor: "test",
      });
      ledger.runs.setStatus(id, "closed", "the smoke check is done", "test");
    };
    run("check-smoke-0123abcd");
    assert.deepEqual(await env.service.exportRunEnds("harness"), []);

    // A ledger from before this version: its runs closed then went out in the hourly exports.
    const old = await assigned();
    await close(old);
    old.service.ledger.db
      .prepare("update meta set value = ? where key = 'run_end_exports_after'")
      .run(String(old.service.ledger.latestEventId()));
    assert.deepEqual(await old.service.exportRunEnds("harness"), []);
  });

  test("at the disk floor it waits, with no failure; with room again it goes", async () => {
    const env = await assigned();
    const free = { outbox: 3 };
    env.service.disk = new DiskWatch({
      ledger: env.service.ledger,
      floorGib: 5,
      places: [{ name: "outbox", path: env.service.paths.outboxDir }],
      free: () => ({ free: free.outbox * GIB, total: 100 * GIB }),
    });
    await close(env);
    assert.deepEqual(await env.service.exportRunEnds("harness"), []);
    assert.deepEqual(outbox(env), []);
    assert.equal(endEvents(env.service.ledger).length, 0);
    free.outbox = 50;
    env.service.disk.check();
    assert.equal((await env.service.exportRunEnds("harness")).length, 1, "no wait after the floor");
    assert.ok(existsSync(join(env.service.paths.outboxDir, outbox(env)[0]?.name ?? "")));
  });
  test("a run's end export publishes its champion, as the chain's exports did; a run with none publishes none", async () => {
    const env = await assigned();
    const { ledger } = env.service;
    // A champion beyond the seed: a change the judge found better, promoted.
    const patch = env.patchFrom((d) =>
      appendFileSync(join(d, "src", "kernel", "k.c"), "/* a faster k */\n"),
    );
    const sub = await env.service.submitAttempt(
      { run: RUN, patch_base64: patch, hypothesis: "faster", known_flaws: [] },
      "proposer",
    );
    const attempt = ledger.attempts.get(sub.attempt);
    assert.ok(attempt);
    ledger.verdicts.record({
      attempt: sub.attempt,
      verdict: "win_confirmed",
      reasons: "t",
      judgedBy: "judge",
    });
    const promoted = ledger.champions.promote({
      run: RUN,
      expectedSeq: 1,
      attempt: sub.attempt,
      commitSha: String(attempt.commit_sha),
      by: "judge",
    });
    assert.ok(promoted.ok);
    const files = (dir: string) =>
      Object.keys(
        (JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as { files: object }).files,
      );
    const published = () => ledger.events.list("champion_published", { subject: RUN });

    // A run's export someone asks for publishes none.
    const asked = await env.service.export("owner", { run: RUN });
    assert.ok(!files(asked.dir).some((f) => f.startsWith("champions/")));
    assert.equal(published().length, 0);

    // Its export at its end does: the patch from its seed and its manifest, announced once.
    await close(env);
    const [name] = await env.service.exportRunEnds("harness");
    assert.ok(name);
    const dir = join(env.service.paths.outboxDir, name);
    assert.deepEqual(
      files(dir)
        .filter((f) => f.startsWith("champions/"))
        .sort(),
      [`champions/${RUN}/2.json`, `champions/${RUN}/2.patch`],
    );
    assert.match(readFileSync(join(dir, "champions", RUN, "2.patch"), "utf8"), /a faster k/);
    const events = published();
    assert.equal(events.length, 1);
    assert.equal(events[0]?.body.seq, 2);
    assert.equal(events[0]?.body.export, name);
    // The rig's next export of what changed does not publish it again.
    const next = await env.service.export("owner");
    assert.ok(!files(next.dir).some((f) => f.startsWith("champions/")));
    assert.equal(published().length, 1);

    // A run with no champion beyond its seed publishes none at its end: one of the same contract.
    const same = env.assignPayload();
    ledger.runs.create({
      id: "plain-1",
      contract: same.contract as Contract,
      contractSha: String(same.contract_sha),
      seedRepo: "smoke-kernels",
      seedCommit: env.seedCommit,
      actor: "test",
    });
    ledger.runs.setStatus("plain-1", "closed", "done", "owner");
    const [plain] = await env.service.exportRunEnds("harness");
    assert.ok(plain);
    const plainDir = join(env.service.paths.outboxDir, plain);
    assert.equal(JSON.parse(readFileSync(join(plainDir, "manifest.json"), "utf8")).run, "plain-1");
    assert.ok(!files(plainDir).some((f) => f.startsWith("champions/")));
    assert.equal(ledger.events.list("champion_published", { subject: "plain-1" }).length, 0);
  });
});
