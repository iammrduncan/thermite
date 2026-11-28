import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  assertSubjectToken,
  backupPrincipal,
  CORE_NATS_SUBJECTS,
  controlPrincipal,
  eventHeaders,
  eventToSubject,
  isPrincipalAllowed,
  JETSTREAM_STREAMS,
  jobDispatchSubject,
  jobLiveSubject,
  jobMsgId,
  jobResultSubject,
  liveReaderPrincipal,
  MAX_JOB_PAYLOAD_BYTES,
  machineCancelSubject,
  machineEventSubject,
  machineHeartbeatSubject,
  matchesNatsSubject,
  NATS_ACCOUNTS,
  needLiveSubject,
  publicLiveSubject,
  runAttemptSubject,
  runEventSubject,
  runLiveSubject,
  runNeedSubject,
  runnerPrincipal,
  SUBJECT_PREFIX,
  systemPrincipal,
  THERMITE_HEADERS,
} from "../src/bus/index.ts";
import type { DomainEvent } from "../src/machine/index.ts";

const ACTOR = {
  principalId: "owner-1",
  principalKind: "owner_session",
} as const;

const BASE_RUN_CONFIG = {
  mode: "hill_climb",
  live: false,
  infraCrashLimit: 3,
  identicalBuildLimit: 5,
  plannerInvalidEpochLimit: 2,
  oscillationRounds: 3,
  auditTimeoutMs: 60_000,
  onAuditTimeout: "need_owner",
  advisorCooldownMs: 30_000,
  gitPolicy: { onChampion: "none" },
} as const;

function matchesStream(streamName: keyof typeof JETSTREAM_STREAMS, subject: string): boolean {
  return JETSTREAM_STREAMS[streamName].subjects.some((pattern) =>
    matchesNatsSubject(pattern, subject),
  );
}

test("assertSubjectToken accepts safe tokens and rejects injection characters", () => {
  for (const ok of ["r1", "run-42", "m_01", "attempt-9a", "worker_1", "edge-1"]) {
    assert.equal(assertSubjectToken(ok, "id"), ok);
  }

  const badTokens = [
    "",
    " ",
    "r 1",
    "r\t1",
    "r\n1",
    "r\r1",
    "r\u00a01",
    ".",
    "r.1",
    "r1.",
    ".r1",
    "*",
    "r*1",
    ">",
    "r>1",
    "/",
    "r/1",
    "$",
    "$JS",
    "r$1",
    "r\u00001",
    "r\u001f1",
    "r\u007f1",
    "r\u00851",
  ];
  for (const bad of badTokens) {
    assert.throws(() => assertSubjectToken(bad, "testToken"), /Invalid NATS subject token/);
  }

  assert.throws(() => runEventSubject("r1.>", "run_created"));
  assert.throws(() => machineHeartbeatSubject("*"));
  assert.throws(() => jobLiveSubject("m1", "j1/escape"));
  assert.throws(() => jobMsgId("m1", "$bad", "dispatch"));
  assert.throws(() => runnerPrincipal("m1.*"));
  assert.throws(() => liveReaderPrincipal({ mode: "replay", consumer: "c>" }));
  assert.throws(() => liveReaderPrincipal({ mode: "replay" }));
});

test("canonical short t. subject builders align with disjoint stream patterns", () => {
  assert.equal(SUBJECT_PREFIX, "t");

  const eventsSubjects = [
    runEventSubject("r1", "run_created"),
    runAttemptSubject("r1", "promoted"),
    runNeedSubject("r1", "opened"),
    machineEventSubject("m1", "machine_enrolled"),
  ];
  assert.deepEqual(eventsSubjects, [
    "t.run.r1.ev.run_created",
    "t.run.r1.attempt.promoted",
    "t.run.r1.need.opened",
    "t.machine.m1.ev.machine_enrolled",
  ]);

  const jobsSubjects = [jobDispatchSubject("m1"), jobResultSubject("m1")];
  assert.deepEqual(jobsSubjects, ["t.machine.m1.job.dispatch", "t.machine.m1.job.result"]);

  const liveSubjects = [
    runLiveSubject("r1", "worker"),
    jobLiveSubject("m1", "j1"),
    needLiveSubject("n1"),
    publicLiveSubject("r1", "metrics"),
  ];
  assert.deepEqual(liveSubjects, [
    "t.run.r1.live.worker",
    "t.machine.m1.job.j1.live",
    "t.need.n1.live",
    "t.live.r1.metrics",
  ]);

  const hbSubject = machineHeartbeatSubject("m1");
  const cancelSubject = machineCancelSubject("m1");
  const coreSubjects = [hbSubject, cancelSubject];
  assert.deepEqual(coreSubjects, ["t.machine.m1.hb", "t.machine.m1.cancel"]);

  for (const subject of eventsSubjects) {
    assert.equal(matchesStream("EVENTS", subject), true, subject);
    assert.equal(matchesStream("JOBS", subject), false, subject);
    assert.equal(matchesStream("LIVE", subject), false, subject);
  }
  for (const subject of jobsSubjects) {
    assert.equal(matchesStream("JOBS", subject), true, subject);
    assert.equal(matchesStream("EVENTS", subject), false, subject);
    assert.equal(matchesStream("LIVE", subject), false, subject);
  }
  for (const subject of liveSubjects) {
    assert.equal(matchesStream("LIVE", subject), true, subject);
    assert.equal(matchesStream("EVENTS", subject), false, subject);
    assert.equal(matchesStream("JOBS", subject), false, subject);
  }
  for (const subject of coreSubjects) {
    assert.equal(matchesStream("EVENTS", subject), false, subject);
    assert.equal(matchesStream("JOBS", subject), false, subject);
    assert.equal(matchesStream("LIVE", subject), false, subject);
  }
  assert.equal(matchesNatsSubject(CORE_NATS_SUBJECTS.heartbeat, hbSubject), true);
  assert.equal(matchesNatsSubject(CORE_NATS_SUBJECTS.cancel, cancelSubject), true);
});

test("jobMsgId namespaces dispatch and result phases for stream-wide dedup", () => {
  const dispatchId = jobMsgId("m1", "job-99", "dispatch");
  const resultId = jobMsgId("m1", "job-99", "result");
  assert.equal(dispatchId, "m1:job-99:dispatch");
  assert.equal(resultId, "m1:job-99:result");
  assert.notEqual(dispatchId, resultId);
  assert.notEqual(jobMsgId("m1", "job-99", "dispatch"), jobMsgId("m2", "job-99", "dispatch"));
});

test("eventToSubject and eventHeaders cover all 21 DomainEvents with O(runs) cardinality", () => {
  const cases: ReadonlyArray<{
    readonly event: DomainEvent;
    readonly runIdArg?: string;
    readonly expectedSubject: string | null;
    readonly expectedHeaders: Record<string, string>;
  }> = [
    {
      event: {
        type: "run.created",
        runId: "r1",
        campaignId: "c1",
        mode: "hill_climb",
        config: BASE_RUN_CONFIG,
      },
      expectedSubject: "t.run.r1.ev.run_created",
      expectedHeaders: {},
    },
    {
      event: {
        type: "run.status_changed",
        runId: "r1",
        status: "running",
        reason: "started",
        actor: ACTOR,
      },
      expectedSubject: "t.run.r1.ev.run_status_changed",
      expectedHeaders: {},
    },
    {
      event: {
        type: "run.config_updated",
        runId: "r1",
        patch: { live: true },
        actor: ACTOR,
      },
      expectedSubject: "t.run.r1.ev.run_config_updated",
      expectedHeaders: {},
    },
    {
      event: {
        type: "machine.enrolled",
        machineId: "m1",
        devices: [],
        wallPlugin: "wall-container",
        wallVersion: "1.0.0",
      },
      expectedSubject: "t.machine.m1.ev.machine_enrolled",
      expectedHeaders: {},
    },
    {
      event: {
        type: "machine.heartbeat",
        machineId: "m1",
        devices: [],
        activeJobs: ["job-highcard"],
      },
      expectedSubject: null,
      expectedHeaders: {},
    },
    {
      event: {
        type: "machine.wall_checked",
        machineId: "m1",
        passed: true,
        proofDigest: "sha256:abc",
      },
      expectedSubject: "t.machine.m1.ev.machine_wall_checked",
      expectedHeaders: {},
    },
    {
      event: {
        type: "machine.status_changed",
        machineId: "m1",
        status: "online",
      },
      expectedSubject: "t.machine.m1.ev.machine_status_changed",
      expectedHeaders: {},
    },
    {
      event: {
        type: "job.dispatched",
        jobId: "job-highcard",
        runId: "r1",
        attemptId: "att-highcard",
        machineId: "m1",
        deviceIds: ["cpu0"],
        kind: "measure",
        deadlineAt: 1000,
      },
      expectedSubject: "t.run.r1.ev.job_dispatched",
      expectedHeaders: {
        [THERMITE_HEADERS.job]: "job-highcard",
        [THERMITE_HEADERS.attempt]: "att-highcard",
      },
    },
    {
      event: {
        type: "job.finished",
        jobId: "job-highcard",
        machineId: "m1",
        outcome: "ok",
      },
      runIdArg: "r1",
      expectedSubject: "t.run.r1.ev.job_finished",
      expectedHeaders: {
        [THERMITE_HEADERS.job]: "job-highcard",
      },
    },
    {
      event: {
        type: "attempt.submitted",
        runId: "r1",
        laneId: "lane-highcard",
        attemptId: "att-highcard",
        commitRef: "abc123",
        summary: "try vectorizing",
      },
      expectedSubject: "t.run.r1.attempt.submitted",
      expectedHeaders: { [THERMITE_HEADERS.attempt]: "att-highcard" },
    },
    {
      event: {
        type: "attempt.judged",
        runId: "r1",
        attemptId: "att-highcard",
        verdict: { outcome: "improve", metricDelta: 0.12 },
        judgePlugin: "judge-stat",
        judgeVersion: "1.0.0",
      },
      expectedSubject: "t.run.r1.attempt.judged",
      expectedHeaders: { [THERMITE_HEADERS.attempt]: "att-highcard" },
    },
    {
      event: {
        type: "attempt.rejudge_requested",
        runId: "r1",
        attemptId: "att-highcard",
        reason: "verify noise",
        actor: ACTOR,
      },
      expectedSubject: "t.run.r1.attempt.rejudge_requested",
      expectedHeaders: { [THERMITE_HEADERS.attempt]: "att-highcard" },
    },
    {
      event: {
        type: "attempt.promoted",
        runId: "r1",
        attemptId: "att-highcard",
        commitRef: "abc123",
        metricDelta: 0.12,
        actor: ACTOR,
      },
      expectedSubject: "t.run.r1.attempt.promoted",
      expectedHeaders: { [THERMITE_HEADERS.attempt]: "att-highcard" },
    },
    {
      event: {
        type: "attempt.invalidated",
        runId: "r1",
        attemptId: "att-highcard",
        reason: "sensor glitch",
        actor: ACTOR,
      },
      expectedSubject: "t.run.r1.attempt.invalidated",
      expectedHeaders: { [THERMITE_HEADERS.attempt]: "att-highcard" },
    },
    {
      event: {
        type: "planner.epoch_completed",
        runId: "r1",
        epoch: 1,
        valid: true,
        assignments: [],
      },
      expectedSubject: "t.run.r1.ev.planner_epoch_completed",
      expectedHeaders: {},
    },
    {
      event: {
        type: "research.round_recorded",
        runId: "r1",
        hypothesisId: "hyp-highcard",
        decision: "support",
        certainty: "high",
        summary: "confirmed",
      },
      expectedSubject: "t.run.r1.ev.research_round_recorded",
      expectedHeaders: {},
    },
    {
      event: {
        type: "advisor.completed",
        runId: "r1",
        role: "auditor",
        targetId: "att-highcard",
      },
      expectedSubject: "t.run.r1.ev.advisor_completed",
      expectedHeaders: {},
    },
    {
      event: {
        type: "need.opened",
        needId: "need-highcard",
        runId: "r1",
        kind: "approval",
        scope: { attemptId: "att-highcard" },
        summary: "review promotion",
      },
      expectedSubject: "t.run.r1.need.opened",
      expectedHeaders: {
        [THERMITE_HEADERS.need]: "need-highcard",
        [THERMITE_HEADERS.attempt]: "att-highcard",
      },
    },
    {
      event: {
        type: "need.resolved",
        needId: "need-highcard",
        resolution: "approve",
        actor: ACTOR,
      },
      runIdArg: "r1",
      expectedSubject: "t.run.r1.need.resolved",
      expectedHeaders: { [THERMITE_HEADERS.need]: "need-highcard" },
    },
    {
      event: {
        type: "git.sync_finished",
        runId: "r1",
        attemptId: "att-highcard",
        ok: true,
        ref: "refs/heads/champ-1",
      },
      expectedSubject: "t.run.r1.ev.git_sync_finished",
      expectedHeaders: { [THERMITE_HEADERS.attempt]: "att-highcard" },
    },
    {
      event: {
        type: "clock.tick",
        now: 123456,
      },
      expectedSubject: null,
      expectedHeaders: {},
    },
  ];

  assert.equal(cases.length, 21);
  assert.equal(new Set(cases.map((c) => c.event.type)).size, 21);

  for (const item of cases) {
    const subject = eventToSubject(item.event, item.runIdArg);
    assert.equal(subject, item.expectedSubject, `subject mismatch for ${item.event.type}`);
    assert.deepEqual(
      eventHeaders(item.event),
      item.expectedHeaders,
      `headers mismatch for ${item.event.type}`,
    );

    if (subject !== null) {
      assert.equal(matchesStream("EVENTS", subject), true, `${subject} must match EVENTS`);
      // O(runs) cardinality guard: no high-cardinality IDs in retained EVENTS subjects.
      for (const highCard of [
        "att-highcard",
        "job-highcard",
        "need-highcard",
        "lane-highcard",
        "hyp-highcard",
      ]) {
        assert.equal(subject.includes(highCard), false, `${subject} leaked ${highCard}`);
      }
    }
  }

  // Fallback paths when runId is omitted for need.resolved and job.finished:
  const needResolvedCase = cases.find((c) => c.event.type === "need.resolved");
  assert.ok(needResolvedCase);
  const needResolvedSubject = eventToSubject(needResolvedCase.event);
  assert.equal(needResolvedSubject, "t.run.global.need.resolved");
  assert.equal(matchesStream("EVENTS", needResolvedSubject), true);

  const jobFinishedCase = cases.find((c) => c.event.type === "job.finished");
  assert.ok(jobFinishedCase);
  const jobFinishedSubject = eventToSubject(jobFinishedCase.event);
  assert.equal(jobFinishedSubject, "t.machine.m1.ev.job_finished");
  assert.equal(matchesStream("EVENTS", jobFinishedSubject), true);

  // Inline runId on need.resolved and job.finished is used when runIdArg is omitted:
  const inlineNeedResolved: DomainEvent = {
    type: "need.resolved",
    needId: "need-2",
    runId: "r2",
    resolution: "approve",
    actor: ACTOR,
  };
  assert.equal(eventToSubject(inlineNeedResolved), "t.run.r2.need.resolved");

  const inlineJobFinished: DomainEvent = {
    type: "job.finished",
    jobId: "j-2",
    runId: "r2",
    machineId: "m1",
    outcome: "ok",
  };
  assert.equal(eventToSubject(inlineJobFinished), "t.run.r2.ev.job_finished");

  // job.dispatched without attemptId omits Thermite-Attempt header:
  const selfTestDispatch: DomainEvent = {
    type: "job.dispatched",
    jobId: "j-selftest",
    runId: "r1",
    machineId: "m1",
    deviceIds: ["cpu0"],
    kind: "self_test",
    deadlineAt: 2000,
  };
  assert.deepEqual(eventHeaders(selfTestDispatch), { [THERMITE_HEADERS.job]: "j-selftest" });
});

test("JETSTREAM_STREAMS and CORE_NATS_SUBJECTS match section 1.1 contract exactly", () => {
  assert.equal(MAX_JOB_PAYLOAD_BYTES, 1_048_576);
  assert.deepEqual(Object.keys(JETSTREAM_STREAMS), ["EVENTS", "JOBS", "LIVE"]);

  assert.deepEqual(JETSTREAM_STREAMS.EVENTS, {
    name: "EVENTS",
    subjects: ["t.run.*.ev.*", "t.run.*.attempt.*", "t.run.*.need.*", "t.machine.*.ev.*"],
    retention: "limits",
    storage: "file",
    compression: "s2",
    discard: "new",
    maxAgeNs: 0,
    allowDirect: true,
    allowAtomic: true,
  });

  assert.deepEqual(JETSTREAM_STREAMS.JOBS, {
    name: "JOBS",
    subjects: ["t.machine.*.job.dispatch", "t.machine.*.job.result"],
    retention: "workqueue",
    storage: "file",
    discard: "new",
    discardNewPerSubject: true,
    maxAgeNs: 7 * 24 * 3600 * 1e9,
    maxMsgsPerSubject: 256,
    duplicateWindowNs: 7 * 24 * 3600 * 1e9,
    maxMsgSizeBytes: 1_048_576,
  });

  assert.deepEqual(JETSTREAM_STREAMS.LIVE, {
    name: "LIVE",
    subjects: ["t.run.*.live.*", "t.machine.*.job.*.live", "t.need.*.live", "t.live.*.*"],
    retention: "limits",
    storage: "file",
    discard: "old",
    maxAgeNs: 3600 * 1e9,
    maxBytes: 256 * 1024 * 1024,
    maxMsgsPerSubject: 1000,
  });

  assert.deepEqual(CORE_NATS_SUBJECTS, {
    heartbeat: "t.machine.*.hb",
    cancel: "t.machine.*.cancel",
  });
});

test("matchesNatsSubject enforces NATS single-token * and trailing > semantics", () => {
  assert.equal(matchesNatsSubject("a.b.c", "a.b.c"), true);
  assert.equal(matchesNatsSubject("a.b.c", "a.b.d"), false);
  assert.equal(matchesNatsSubject("a.*.c", "a.b.c"), true);
  assert.equal(matchesNatsSubject("a.*.c", "a.b.d.c"), false);
  assert.equal(matchesNatsSubject("a.*.c", "a.c"), false);
  assert.equal(matchesNatsSubject("a.*", "a.>"), false);
  assert.equal(matchesNatsSubject("a.>", "a"), false);
  assert.equal(matchesNatsSubject("a.>", "a.b"), true);
  assert.equal(matchesNatsSubject("a.>", "a.b.c.d"), true);
  assert.equal(matchesNatsSubject(">", "a"), true);
  assert.equal(matchesNatsSubject(">", "a.b.c"), true);
  assert.equal(matchesNatsSubject("t.live.>", "t.live.>"), true);

  // Malformed patterns or subjects never match.
  assert.equal(matchesNatsSubject("", "a"), false);
  assert.equal(matchesNatsSubject(">", ""), false);
  assert.equal(matchesNatsSubject("a.>.c", "a.b.c"), false);
  assert.equal(matchesNatsSubject("a.b*", "a.bc"), false);
  assert.equal(matchesNatsSubject("a..b", "a..b"), false);
  assert.equal(matchesNatsSubject(".a", ".a"), false);
  assert.equal(matchesNatsSubject("a.", "a."), false);
  assert.equal(matchesNatsSubject("a.b", "a.b "), false);
  assert.equal(matchesNatsSubject("a.b", "a.*"), false);
});

test("two-account 5-principal security matrix enforces least-privilege boundaries", () => {
  assert.equal(NATS_ACCOUNTS.THERMITE.jetstream, true);
  assert.equal(NATS_ACCOUNTS.SYS.jetstream, false);

  // 1. control (THERMITE)
  const control = controlPrincipal();
  assert.equal(control.account, "THERMITE");
  assert.equal(isPrincipalAllowed(control, "publish", "t.run.r1.ev.run_created"), true);
  assert.equal(isPrincipalAllowed(control, "publish", "t.machine.m1.job.dispatch"), true);
  assert.equal(isPrincipalAllowed(control, "publish", "$JS.API.STREAM.INFO.EVENTS"), true);
  assert.equal(isPrincipalAllowed(control, "publish", "$JS.API.STREAM.DELETE.EVENTS"), false);
  // Wildcard publish is forbidden by NATS protocol even for control.
  assert.equal(isPrincipalAllowed(control, "publish", "t.run.*.ev.run_created"), false);
  assert.equal(isPrincipalAllowed(control, "publish", ">"), false);
  assert.equal(isPrincipalAllowed(control, "subscribe", "t.machine.m1.hb"), true);
  assert.equal(isPrincipalAllowed(control, "subscribe", ">"), true);

  // 2. runner:<m> (THERMITE)
  const runner = runnerPrincipal("m1");
  assert.equal(runner.account, "THERMITE");
  assert.equal(runner.name, "runner:m1");
  for (const okPub of [
    "t.machine.m1.hb",
    "t.machine.m1.job.result",
    "t.machine.m1.job.j1.live",
    "$JS.API.CONSUMER.INFO.JOBS.runner-m1",
    "$JS.API.CONSUMER.MSG.NEXT.JOBS.runner-m1",
    "$JS.ACK.JOBS.runner-m1.1.1",
  ]) {
    assert.equal(isPrincipalAllowed(runner, "publish", okPub), true, `runner allow pub ${okPub}`);
  }
  for (const okSub of ["t.machine.m1.cancel", "_INBOX.m.m1.x", "_INBOX.m.m1.>"]) {
    assert.equal(isPrincipalAllowed(runner, "subscribe", okSub), true, `runner allow sub ${okSub}`);
  }
  for (const badPub of [
    "t.machine.m2.hb",
    "t.machine.m2.job.result",
    "t.machine.m2.job.j1.live",
    "t.run.r1.ev.run_created",
    "$JS.API.CONSUMER.CREATE.JOBS.runner-m1",
    "$JS.API.STREAM.INFO.EVENTS",
    "$JS.ACK.JOBS.runner-m2.1.1",
    "t.live.r1.metrics",
  ]) {
    assert.equal(isPrincipalAllowed(runner, "publish", badPub), false, `runner deny pub ${badPub}`);
  }
  for (const badSub of [
    "t.machine.m2.cancel",
    "_INBOX.m.m2.x",
    "t.run.r1.ev.run_created",
    "t.machine.m1.job.dispatch",
    "t.live.r1.metrics",
  ]) {
    assert.equal(
      isPrincipalAllowed(runner, "subscribe", badSub),
      false,
      `runner deny sub ${badSub}`,
    );
  }

  // 3a. live-reader (live_only, THERMITE)
  const liveOnly = liveReaderPrincipal();
  assert.equal(liveOnly.account, "THERMITE");
  assert.equal(isPrincipalAllowed(liveOnly, "subscribe", "t.live.r1.metrics"), true);
  assert.equal(isPrincipalAllowed(liveOnly, "subscribe", "t.live.>"), true);
  for (const badSub of [
    "t.live",
    "t.run.r1.live.worker",
    "t.machine.m1.job.j1.live",
    "t.need.n1.live",
    "t.run.r1.ev.run_created",
  ]) {
    assert.equal(
      isPrincipalAllowed(liveOnly, "subscribe", badSub),
      false,
      `liveOnly deny sub ${badSub}`,
    );
  }
  assert.equal(isPrincipalAllowed(liveOnly, "publish", "t.live.r1.metrics"), false);
  assert.equal(isPrincipalAllowed(liveOnly, "publish", "$JS.API.CONSUMER.INFO.LIVE.c1"), false);

  // 3b. live-reader (replay, THERMITE)
  const liveReplay = liveReaderPrincipal({ mode: "replay", consumer: "edge-1" });
  assert.equal(liveReplay.account, "THERMITE");
  assert.equal(liveReplay.name, "live-reader:edge-1");
  for (const okPub of [
    "$JS.API.CONSUMER.INFO.LIVE.edge-1",
    "$JS.API.CONSUMER.MSG.NEXT.LIVE.edge-1",
    "$JS.ACK.LIVE.edge-1.1.1",
  ]) {
    assert.equal(
      isPrincipalAllowed(liveReplay, "publish", okPub),
      true,
      `liveReplay allow pub ${okPub}`,
    );
  }
  assert.equal(isPrincipalAllowed(liveReplay, "subscribe", "_INBOX.live.edge-1.req1"), true);
  assert.equal(isPrincipalAllowed(liveReplay, "subscribe", "_INBOX.live.edge-1.>"), true);
  for (const badPub of [
    "t.live.r1.metrics",
    "$JS.API.CONSUMER.CREATE.LIVE.edge-1",
    "$JS.API.CONSUMER.MSG.NEXT.LIVE.edge-2",
    "t.run.r1.ev.run_created",
  ]) {
    assert.equal(
      isPrincipalAllowed(liveReplay, "publish", badPub),
      false,
      `liveReplay deny pub ${badPub}`,
    );
  }
  for (const badSub of [
    "t.live.r1.metrics",
    "t.run.r1.live.worker",
    "t.machine.m1.job.j1.live",
    "t.run.r1.ev.run_created",
    "_INBOX.live.edge-2.req1",
  ]) {
    assert.equal(
      isPrincipalAllowed(liveReplay, "subscribe", badSub),
      false,
      `liveReplay deny sub ${badSub}`,
    );
  }

  // 4. backup (THERMITE)
  const backup = backupPrincipal();
  assert.equal(backup.account, "THERMITE");
  for (const okPub of [
    "$JS.API.STREAM.INFO.EVENTS",
    "$JS.API.STREAM.MSG.GET.EVENTS",
    "$JS.API.STREAM.SNAPSHOT.EVENTS",
    "$JS.API.STREAM.RESTORE.EVENTS",
    "$JS.SNAPSHOT.ACK.EVENTS.snap1",
    "$JS.SNAPSHOT.RESTORE.EVENTS.snap1",
  ]) {
    assert.equal(isPrincipalAllowed(backup, "publish", okPub), true, `backup allow pub ${okPub}`);
  }
  assert.equal(isPrincipalAllowed(backup, "subscribe", "_INBOX.backup.1"), true);
  for (const badPub of [
    "t.run.r1.ev.x",
    "$JS.API.STREAM.PURGE.EVENTS",
    "$JS.API.STREAM.DELETE.EVENTS",
    "$JS.API.STREAM.INFO.JOBS",
  ]) {
    assert.equal(isPrincipalAllowed(backup, "publish", badPub), false, `backup deny pub ${badPub}`);
  }
  assert.equal(isPrincipalAllowed(backup, "subscribe", "t.run.r1.ev.x"), false);

  // 5. system (SYS)
  const system = systemPrincipal();
  assert.equal(system.account, "SYS");
  for (const okPub of [
    "$SYS.REQ.SERVER.PING.RELOAD",
    "$SYS.REQ.SERVER.PING.VARZ",
    "$SYS.REQ.SERVER.PING.CONNZ",
    "$SYS.REQ.SERVER.PING.JSZ",
  ]) {
    assert.equal(isPrincipalAllowed(system, "publish", okPub), true, `system allow pub ${okPub}`);
  }
  assert.equal(isPrincipalAllowed(system, "subscribe", "_INBOX.sys.1"), true);
  for (const badPub of [
    "t.run.r1.ev.x",
    "$JS.API.STREAM.INFO.EVENTS",
    "$SYS.REQ.SERVER.PING.SHUTDOWN",
  ]) {
    assert.equal(isPrincipalAllowed(system, "publish", badPub), false, `system deny pub ${badPub}`);
  }
  assert.equal(isPrincipalAllowed(system, "subscribe", "t.run.r1.ev.x"), false);
});

test("packages/core/src/bus has zero node:*, @nats-io/* imports, or legacy topology terms", () => {
  const busDir = join(import.meta.dirname, "..", "src", "bus");
  const files = readdirSync(busDir)
    .filter((name) => name.endsWith(".ts"))
    .sort();
  assert.ok(files.length >= 4, "expected bus source modules");

  const bannedTermRe = new RegExp(`\\b${"ri"}gs?\\b`, "i");
  const forbiddenImportRe =
    /from\s+["'](?:node:|@nats-io\/)|import\s*\(\s*["'](?:node:|@nats-io\/)/;

  for (const file of files) {
    const content = readFileSync(join(busDir, file), "utf8");
    assert.equal(
      forbiddenImportRe.test(content),
      false,
      `${file} must not import node:* or @nats-io/*`,
    );
    assert.equal(
      bannedTermRe.test(content),
      false,
      `${file} must not contain legacy topology identifiers`,
    );
  }
});
