import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { parseContract } from "../../../src/core/contract.ts";
import { Ledger } from "../../../src/harness/ledger/index.ts";
import {
  drainDeadline,
  drainSpans,
  endDrainAtStart,
  RESTARTED,
  workNow,
} from "../../../src/harness/service/drain.ts";
import { HarnessService } from "../../../src/harness/service/index.ts";
import { researchFixture } from "../../helpers/fixtures.ts";
import { makeHarnessEnv } from "../../helpers/harness-env.ts";
import { makeJudgeEnv } from "../../helpers/judge-env.ts";
import { appendOther } from "../../helpers/kinds.ts";

const T0 = Date.parse("2026-10-25T00:00:00.000Z");
const min = (m: number) => T0 + m * 60_000;

/** A ledger whose events are written at the minute `at` says. */
function ledgerAt() {
  let now = T0;
  const path = join(mkdtempSync(join(tmpdir(), "thermite-drain-")), "ledger.db");
  const ledger = Ledger.open(path, () => new Date(now));
  const at = (m: number, kind: string, body: unknown = {}) => {
    now = min(m);
    appendOther(ledger, "t", kind, kind === "trial_started" ? "r-1" : null, body);
  };
  return { ledger, at };
}

describe("when the rig drained (goal 136)", () => {
  test("from each drain to its end, or to the first trial after it; one under way runs to now", () => {
    const { ledger, at } = ledgerAt();
    assert.deepEqual(drainSpans(ledger, min(1)), [], "no drain: none");
    at(5, "trial_started");
    // A drain called off.
    at(10, "rig_drain", { drain: true, reason: "its images are about to change" });
    at(20, "rig_drain", { drain: false });
    // Asked again while it drains: the same drain. A harness older than goal 136 recorded no end
    // at its restart; the first trial after it shows the drain had ended.
    at(30, "rig_drain", { drain: true });
    at(35, "rig_drain", { drain: true });
    at(50, "trial_started");
    // Then a drain that a restart ended, recorded as the harness started again.
    at(60, "rig_drain", { drain: true });
    at(70, "rig_drain", { drain: false, reason: RESTARTED });
    at(75, "trial_started");
    // And one under way.
    at(80, "rig_drain", { drain: true });
    assert.deepEqual(drainSpans(ledger, min(95)), [
      [min(10), min(20)],
      [min(30), min(50)],
      [min(60), min(70)],
      [min(80), min(95)],
    ]);
  });

  test("a restart ends a drain under way, and the harness records the end as it starts", async () => {
    const env = makeJudgeEnv();
    await env.service.applyCommand(env.assign);
    assert.equal(endDrainAtStart(env.ledger, "harness"), false, "no drain: nothing to end");
    await env.service.applyCommand(env.sign("drain_rig", { drain: true, reason: "new images" }));
    const ends = () =>
      env.ledger.db
        .prepare("select actor, body from event where kind = 'rig_drain' order by id")
        .all()
        .map((r) => ({ actor: String(r.actor), ...JSON.parse(String(r.body)) }));
    assert.equal(ends().length, 1);
    // The harness starts again on the same ledger: the drain it kept in memory is gone.
    const again = new HarnessService({
      rig: env.service.rig,
      ledger: env.ledger,
      paths: env.paths,
      controlPublicKeyPem: env.keys.publicKeyPem,
    });
    assert.equal(again.draining, undefined);
    const last = ends().at(-1);
    assert.deepEqual(
      { actor: last?.actor, drain: last?.drain, reason: last?.reason },
      { actor: "harness", drain: false, reason: RESTARTED },
    );
    const spans = drainSpans(env.ledger, Date.now() + 60_000);
    assert.equal(spans.length, 1);
    assert.ok((spans[0]?.[1] ?? 0) <= Date.now(), "the drain ended at the restart, not now");
    // Started again with no drain open: nothing more is recorded.
    assert.equal(endDrainAtStart(env.ledger, "harness"), false);
    assert.equal(ends().length, 2);
  });
});

describe("what a drain waits for (goal 136, item 3)", () => {
  test("the report lists each open trial: its task, counters, claims and a refused request it repeats", async () => {
    const env = makeHarnessEnv("rig-d");
    const parsed = parseContract({ ...researchFixture, lanes: { count: 2, trials_per_epoch: 1 } });
    if (!parsed.ok) throw new Error(parsed.errors.join("; "));
    const out = await env.service.applyCommand(
      env.sign("assign_campaign", {
        run: "r-1",
        contract: parsed.contract,
        contract_sha: parsed.sha,
        imports: [],
      }),
    );
    assert.ok(out.status === "applied" && out.accepted, JSON.stringify(out));
    const db = env.service.ledger.db;
    const started = "2026-10-25T02:10:00.000Z";
    const trial = (id: string, lane: string, ended: string | null) =>
      db
        .prepare(
          "insert into trial (id, run, lane, epoch, parent_commit, turns, tool_calls, tokens_in, started_at, ended_at) values (?, 'r-1', ?, 1, 'c', 214, 196, 3100000, ?, ?)",
        )
        .run(id, lane, started, ended);
    trial("t-1", "lane-1", null);
    trial("t-0", "lane-2", "2026-10-25T03:00:00.000Z");
    db.prepare(
      "insert into experiment (id, run, title, added_by, state, question, trial, lane, created_at, updated_at) values ('x-1', 'r-1', 'Trace the benchmark guide to its source', 'planner', 'assigned', 0, 't-1', 'lane-1', ?, ?)",
    ).run(started, started);
    const claim = (id: string, lane: string, verified: number, at: string) =>
      db
        .prepare(
          "insert into claim (id, run, lane, question, text, quotes, verified, created_at) values (?, 'r-1', ?, 0, 'c', '[]', ?, ?)",
        )
        .run(id, lane, verified, at);
    claim("c-1", "lane-1", 1, "2026-10-25T02:30:00.000Z");
    claim("c-2", "lane-1", 1, "2026-10-25T03:30:00.000Z");
    claim("c-3", "lane-1", 0, "2026-10-25T03:40:00.000Z");
    claim("c-4", "lane-1", 1, "2026-10-25T01:00:00.000Z");
    claim("c-5", "lane-2", 1, "2026-10-25T02:40:00.000Z");
    const refused = (lane: string, at: string, asked?: number) =>
      db
        .prepare(
          "insert into event (at, actor, kind, subject, body) values (?, ?, 'fetch_refused', 'r-1', ?)",
        )
        .run(
          at,
          lane,
          JSON.stringify({
            url: "https://vendor.example.org/guide.pdf",
            reason: "larger than 5000000 bytes",
            ...(asked ? { asked } : {}),
          }),
        );
    // A re-ask before the trial began is another trial's; this one asked twice.
    refused("lane-1", "2026-10-25T01:00:00.000Z", 3);
    refused("lane-1", "2026-10-25T02:20:00.000Z");
    refused("lane-1", "2026-10-25T03:20:00.000Z", 211);
    refused("lane-1", "2026-10-25T09:33:00.000Z", 212);
    const at = new Date("2026-10-25T09:34:00.000Z");
    // Listed whether or not the rig drains (goal 143); while it drains, the trials it waits for.
    const open = workNow(env.service.ledger, at, undefined).open;
    const w = workNow(env.service.ledger, at, {
      since: "2026-10-25T04:10:00.000Z",
      reason: "its images are about to change",
      by: "control:owner:api",
      deadline: "2026-10-25T05:10:00.000Z",
    });
    assert.equal(w.trials, 1);
    assert.deepEqual(w.draining, {
      since: "2026-10-25T04:10:00.000Z",
      reason: "its images are about to change",
      by: "control:owner:api",
      deadline: "2026-10-25T05:10:00.000Z",
    });
    assert.deepEqual(w.open, [
      {
        trial: "t-1",
        run: "r-1",
        lane: "lane-1",
        started_at: started,
        task: "Trace the benchmark guide to its source",
        question: 0,
        turns: 214,
        tool_calls: 196,
        tokens_in: 3100000,
        claims: 2,
        refused_again: {
          url: "https://vendor.example.org/guide.pdf",
          reason: "larger than 5000000 bytes",
          asked: 212,
          at: "2026-10-25T09:33:00.000Z",
          times: 2,
        },
        // What the harness's watch knows of it (goal 143): nothing outside the service.
        last_line_at: null,
        reply: null,
        repeating: null,
      },
    ]);
    assert.deepEqual(open, w.open);
  });

  test("a drain_rig records who asked, and its event keeps to the counts", async () => {
    const env = makeJudgeEnv();
    await env.service.applyCommand(env.assign);
    const out = await env.service.applyCommand(env.sign("drain_rig", { drain: true }));
    assert.ok(out.status === "applied" && out.accepted, JSON.stringify(out));
    const r = out.result as Record<string, unknown>;
    assert.deepEqual(Object.keys(r).sort(), ["draining", "judge_jobs", "trials"]);
    assert.equal((r.draining as { by?: unknown }).by, "control:owner");
    const e = env.ledger.db
      .prepare("select body from event where kind = 'rig_drain' order by id desc")
      .get() as { body: string };
    assert.equal("open" in JSON.parse(e.body), false);
    assert.ok(Array.isArray((env.service.work() as { open?: unknown }).open));
  });
});

describe("a drain's deadline (goal 173)", () => {
  const drains = (ledger: Ledger) =>
    ledger.db
      .prepare("select body from event where kind = 'rig_drain' order by id")
      .all()
      .map((r) => JSON.parse(String(r.body)) as Record<string, unknown>);

  test("a drain that ends before its deadline records no deadline", async () => {
    const env = makeJudgeEnv();
    await env.service.applyCommand(env.assign);
    await env.service.applyCommand(
      env.sign("drain_rig", { drain: true, reason: "new images", deadline_minutes: 30 }),
    );
    const d = env.service.draining;
    assert.ok(d);
    // The command's own wait, not the rig's.
    assert.equal(Date.parse(d.deadline) - Date.parse(d.since), 30 * 60_000);
    assert.equal(drains(env.ledger)[0]?.deadline, d.deadline);
    assert.equal(drainDeadline(env.service, new Date(Date.parse(d.deadline) - 1000)), false);
    // The work ended and the drain with it, before the deadline.
    await env.service.applyCommand(env.sign("drain_rig", { drain: false }));
    assert.equal(drainDeadline(env.service, new Date(Date.parse(d.deadline) + 60_000)), false);
    assert.ok(!drains(env.ledger).some((b) => b.deadline_reached));
  });

  test("at its deadline the step is recorded once, and the rig goes on draining for the owner's choice", async () => {
    const env = makeJudgeEnv();
    await env.service.applyCommand(env.assign);
    env.service.drainMinutes = 45;
    await env.service.applyCommand(env.sign("drain_rig", { drain: true, reason: "new images" }));
    const d = env.service.draining;
    assert.ok(d);
    // No deadline in the command: the rig's THERMITE_DRAIN_MINUTES.
    assert.equal(Date.parse(d.deadline) - Date.parse(d.since), 45 * 60_000);
    const at = new Date(Date.parse(d.deadline) + 1000);
    assert.equal(drainDeadline(env.service, at), true);
    assert.equal(drainDeadline(env.service, new Date(at.getTime() + 60_000)), false, "once");
    const step = drains(env.ledger).at(-1);
    assert.equal(step?.drain, true);
    assert.equal(step?.deadline_reached, true);
    assert.equal(step?.deadline, d.deadline);
    assert.equal(step?.reason, "new images");
    assert.equal(typeof step?.trials, "number");
    // Nothing is chosen for the owner: the rig still drains, and its report says the deadline passed.
    assert.ok(env.service.draining);
    assert.equal(env.service.work().draining?.deadline_reached, at.toISOString());
    // Still one drain for a research run's clock.
    assert.equal(drainSpans(env.ledger, Date.now() + 3_600_000).length, 1);
    // The owner ends it.
    await env.service.applyCommand(
      env.sign("drain_rig", { drain: false, reason: "the owner ended the drain" }),
    );
    assert.equal(env.service.draining, undefined);
  });
});
