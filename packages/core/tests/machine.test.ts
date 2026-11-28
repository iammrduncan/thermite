import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { eventHeaders, eventToSubject } from "../src/bus/subjects.ts";
import {
  type ControlState,
  createInitialState,
  DEFAULT_HEARTBEAT_TIMEOUT_MS,
  DOMAIN_EVENT_TYPES,
  type DomainEvent,
  EFFECT_KINDS,
  type Effect,
  EPHEMERAL_EVENT_TYPES,
  isEphemeralEvent,
  isPersistedEvent,
  type ReplayEntry,
  type RunConfig,
  reduce,
  replay,
  type ScopedDirective,
} from "../src/machine/index.ts";
import type { ActorRef } from "../src/policy/index.ts";

const OWNER: ActorRef = { principalId: "owner-1", principalKind: "owner_session" };
const DELEGATE: ActorRef = {
  principalId: "orchestrator-1",
  principalKind: "delegated_agent",
  grantId: "grant-1",
};

function baseConfig(overrides: Partial<RunConfig> = {}): RunConfig {
  return {
    mode: "hill_climb",
    live: false,
    gitPolicy: { onChampion: "pr", branch: "thermite/champion", base: "main" },
    ...overrides,
  };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}

function step(
  state: ControlState,
  event: DomainEvent,
  now: number,
): { state: ControlState; effects: readonly Effect[] } {
  deepFreeze(state);
  return reduce(state, event, now);
}

function setupMachineAndRun(opts?: {
  runId?: string;
  machineId?: string;
  config?: Partial<RunConfig>;
}): ControlState {
  const runId = opts?.runId ?? "run-1";
  const machineId = opts?.machineId ?? "m1";
  let s = createInitialState();
  s = step(
    s,
    {
      type: "run.created",
      runId,
      campaignId: "camp-1",
      mode: opts?.config?.mode ?? "hill_climb",
      config: baseConfig(opts?.config),
    },
    1000,
  ).state;
  s = step(
    s,
    {
      type: "machine.enrolled",
      machineId,
      devices: [{ id: "gpu0", kind: "cuda", name: "GPU-0" }],
      wallPlugin: "wall-container",
      wallVersion: "1.0.0",
    },
    1010,
  ).state;
  s = step(
    s,
    {
      type: "machine.wall_checked",
      machineId,
      passed: true,
      proofDigest: "sha256:proof-ok",
    },
    1020,
  ).state;
  return s;
}

test("static Sans-I/O purity: zero I/O imports, clocks, randomness, classes, or legacy terms", () => {
  const dir = join(import.meta.dirname, "..", "src", "machine");
  const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
  assert.ok(files.length >= 7, "expected all 7 machine module files");

  const forbiddenPatterns: readonly [string, RegExp][] = [
    ["node:* import", /from\s+["']node:/],
    ["pg import", /from\s+["'](?:pg|postgres)["']/],
    ["@nats-io import", /from\s+["']@nats-io\//],
    ["zod import", /from\s+["']zod(?:\/|["'])/],
    ["Date.now", /\bDate\.now\b/],
    ["performance.now", /\bperformance\.now\b/],
    ["Math.random", /\bMath\.random\b/],
    ["fetch call", /\bfetch\s*\(/],
    ["process global", /\bprocess\./],
    ["timers", /\b(?:setTimeout|setInterval|clearTimeout|clearInterval|queueMicrotask)\b/],
    ["class declaration", /^\s*(?:export\s+)?class\s+[A-Za-z_]/m],
    ["legacy topology terms", new RegExp(`\\b${"ri"}gs?\\b`, "i")],
  ];

  const externalImportRe = /^\s*import\s+(type\s+)?[\s\S]*?from\s+["']([^"']+)["'];/gm;

  for (const file of files) {
    const content = readFileSync(join(dir, file), "utf8");
    for (const [label, re] of forbiddenPatterns) {
      assert.equal(re.test(content), false, `${file} violated purity rule: ${label}`);
    }
    for (const match of content.matchAll(externalImportRe)) {
      const isTypeImport = match[1] !== undefined;
      const specifier = match[2] ?? "";
      if (!specifier.startsWith("./")) {
        assert.ok(
          specifier === "../policy/index.ts" || specifier === "../bus/subjects.ts",
          `${file} has unexpected external import: ${specifier}`,
        );
        if (specifier === "../policy/index.ts") {
          assert.equal(isTypeImport, true, `${file} external policy import must be type-only`);
        }
      }
    }
  }

  // Also verify imported ../bus/subjects.ts stays 100% pure (zero I/O, clocks, zod, or legacy terms).
  const busSubjects = readFileSync(join(dir, "..", "bus", "subjects.ts"), "utf8");
  for (const [label, re] of forbiddenPatterns) {
    assert.equal(re.test(busSubjects), false, `bus/subjects.ts violated purity rule: ${label}`);
  }
});

test("all 21 DomainEvents and all 8 Effects: persisted vs ephemeral separation and live privacy guard", () => {
  assert.equal(DOMAIN_EVENT_TYPES.length, 21);
  assert.deepEqual(EPHEMERAL_EVENT_TYPES, ["machine.heartbeat", "clock.tick"]);
  assert.equal(EFFECT_KINDS.length, 8);

  const seenEvents = new Set<DomainEvent["type"]>();
  const seenEffects = new Set<Effect["kind"]>();

  let state = createInitialState();
  const privateEvents: readonly ReplayEntry[] = [
    {
      now: 1000,
      event: {
        type: "run.created",
        runId: "r-priv",
        campaignId: "c1",
        mode: "hill_climb",
        config: baseConfig({ live: false }),
      },
    },
    {
      now: 1010,
      event: {
        type: "run.config_updated",
        runId: "r-priv",
        patch: { advisorCooldownMs: 1000 },
        actor: OWNER,
      },
    },
    {
      now: 1020,
      event: {
        type: "machine.enrolled",
        machineId: "m1",
        devices: [{ id: "cpu0", kind: "cpu", name: "CPU" }],
        wallPlugin: "wall-tools",
        wallVersion: "1.0.0",
      },
    },
    {
      now: 1030,
      event: {
        type: "machine.heartbeat",
        machineId: "m1",
        devices: [{ id: "cpu0", drained: true, utilizationPct: 5 }],
        activeJobs: [],
      },
    },
    {
      now: 1040,
      event: {
        type: "machine.wall_checked",
        machineId: "m1",
        passed: true,
        proofDigest: "sha256:ok",
      },
    },
    {
      now: 1050,
      event: { type: "machine.status_changed", machineId: "m1", status: "online" },
    },
    {
      now: 1060,
      event: {
        type: "planner.epoch_completed",
        runId: "r-priv",
        epoch: 1,
        valid: true,
        assignments: [{ laneId: "lane-1", goal: "optimize matmul" }],
      },
    },
    {
      now: 1070,
      event: {
        type: "job.dispatched",
        jobId: "j1",
        runId: "r-priv",
        laneId: "lane-1",
        machineId: "m1",
        deviceIds: ["cpu0"],
        kind: "build",
        deadlineAt: 2000,
      },
    },
    {
      now: 1080,
      event: {
        type: "job.finished",
        jobId: "j1",
        machineId: "m1",
        outcome: "ok",
        artifactsDigest: "sha256:art1",
      },
    },
    {
      now: 1090,
      event: {
        type: "attempt.submitted",
        runId: "r-priv",
        laneId: "lane-1",
        attemptId: "a1",
        commitRef: "abc123",
        summary: "unroll inner loop",
      },
    },
    {
      now: 1100,
      event: {
        type: "attempt.judged",
        runId: "r-priv",
        attemptId: "a1",
        verdict: { outcome: "improve", metricDelta: 0.12 },
        judgePlugin: "judge-stat",
        judgeVersion: "1.0.0",
      },
    },
    {
      now: 1110,
      event: {
        type: "advisor.completed",
        runId: "r-priv",
        role: "auditor",
        targetId: "a1",
        finding: { kind: "clean", summary: "verified diff" },
      },
    },
    {
      now: 1120,
      event: {
        type: "attempt.rejudge_requested",
        runId: "r-priv",
        attemptId: "a1",
        reason: "confirm speedup",
        actor: DELEGATE,
      },
    },
    {
      now: 1130,
      event: {
        type: "attempt.promoted",
        runId: "r-priv",
        attemptId: "a1",
        commitRef: "abc123",
        metricDelta: 0.12,
        actor: DELEGATE,
      },
    },
    {
      now: 1140,
      event: {
        type: "git.sync_finished",
        runId: "r-priv",
        attemptId: "a1",
        ok: true,
        ref: "refs/heads/thermite/champion",
        prUrl: "https://example.test/pr/1",
      },
    },
    {
      now: 1150,
      event: {
        type: "need.opened",
        needId: "n-manual",
        runId: "r-priv",
        kind: "custom",
        scope: { laneId: "lane-1" },
        summary: "confirm dataset split",
      },
    },
    {
      now: 1160,
      event: {
        type: "need.resolved",
        needId: "n-manual",
        resolution: "approve",
        note: "looks good",
        actor: OWNER,
      },
    },
    {
      now: 1170,
      event: {
        type: "research.round_recorded",
        runId: "r-priv",
        hypothesisId: "h1",
        decision: "support",
        certainty: "medium",
        summary: "benchmark confirms hypothesis",
      },
    },
    {
      now: 1180,
      event: {
        type: "attempt.invalidated",
        runId: "r-priv",
        attemptId: "a1",
        reason: "superseded test",
        actor: OWNER,
      },
    },
    {
      now: 1190,
      event: {
        type: "job.dispatched",
        jobId: "j-timeout",
        runId: "r-priv",
        machineId: "m1",
        deviceIds: ["cpu0"],
        kind: "measure",
        deadlineAt: 1500,
      },
    },
    {
      now: 2000,
      event: { type: "clock.tick", now: 2000 },
    },
    {
      now: 2010,
      event: {
        type: "run.status_changed",
        runId: "r-priv",
        status: "completed",
        reason: "done",
        actor: OWNER,
      },
    },
  ];

  for (const { event, now } of privateEvents) {
    seenEvents.add(event.type);
    const res = step(state, event, now);
    state = res.state;
    for (const eff of res.effects) {
      seenEffects.add(eff.kind);
      if (isEphemeralEvent(event)) {
        assert.notEqual(eff.kind, "persist_pg", `${event.type} must never emit persist_pg`);
      }
      if (eff.kind === "notify_live") {
        assert.equal(
          eff.publishPublic,
          false,
          `private run must never leak publishPublic on ${event.type}`,
        );
      }
    }
    if (isPersistedEvent(event)) {
      assert.ok(
        res.effects.some((e) => e.kind === "persist_pg"),
        `${event.type} must emit persist_pg`,
      );
      assert.ok(
        res.effects.some((e) => e.kind === "publish_nats"),
        `${event.type} must emit publish_nats`,
      );
      assert.ok(
        res.effects.some((e) => e.kind === "notify_live"),
        `${event.type} must emit notify_live`,
      );
    }
  }

  // Every single one of the 21 DomainEvents and 8 Effects was exercised!
  assert.equal(seenEvents.size, 21);
  assert.equal(seenEffects.size, 8);
  assert.equal(state.runs["r-priv"]?.config.caps, undefined, "no default research caps");
  assert.equal(state.runs["r-priv"]?.championAttemptId, undefined, "invalidated champion cleared");

  // Verify live=true enables publishPublic for run events, while machine events stay private.
  const pubRun = step(
    createInitialState(),
    {
      type: "run.created",
      runId: "r-pub",
      campaignId: "c1",
      mode: "goal",
      config: baseConfig({ mode: "goal", live: true }),
    },
    5000,
  );
  const pubLive = pubRun.effects.find((e) => e.kind === "notify_live");
  assert.equal(pubLive?.kind, "notify_live");
  assert.equal(pubLive?.publishPublic, true);

  const toggled = step(
    pubRun.state,
    { type: "run.config_updated", runId: "r-pub", patch: { live: false }, actor: OWNER },
    5010,
  );
  const afterToggle = toggled.effects.find((e) => e.kind === "notify_live");
  assert.equal(afterToggle?.kind, "notify_live");
  assert.equal(afterToggle?.publishPublic, false);
});

test("machine wall-proof gating, job machineId spoof rejection, and clock.tick timeout/heartbeat", () => {
  let s = createInitialState();
  s = step(
    s,
    {
      type: "run.created",
      runId: "r1",
      campaignId: "c1",
      mode: "hill_climb",
      config: baseConfig(),
    },
    1000,
  ).state;
  s = step(
    s,
    {
      type: "machine.enrolled",
      machineId: "m1",
      devices: [{ id: "gpu0", kind: "cuda", name: "GPU-0" }],
      wallPlugin: "wall-container",
      wallVersion: "1.0.0",
    },
    1010,
  ).state;

  assert.equal(s.machines.m1?.wallPassed, false);

  // Dispatch rejected before wall_checked(passed: true).
  const blockedBefore = step(
    s,
    {
      type: "job.dispatched",
      jobId: "j1",
      runId: "r1",
      machineId: "m1",
      deviceIds: ["gpu0"],
      kind: "measure",
      deadlineAt: 5000,
    },
    1020,
  );
  assert.equal(blockedBefore.effects.length, 0);
  assert.equal(blockedBefore.state.jobs.j1, undefined);

  // Failed wall check keeps machine gated.
  s = step(
    s,
    {
      type: "machine.wall_checked",
      machineId: "m1",
      passed: false,
      proofDigest: "sha256:bad",
      detail: "egress leak",
    },
    1030,
  ).state;
  assert.equal(s.machines.m1?.wallPassed, false);
  const blockedAfterFail = step(
    s,
    {
      type: "job.dispatched",
      jobId: "j1",
      runId: "r1",
      machineId: "m1",
      deviceIds: ["gpu0"],
      kind: "measure",
      deadlineAt: 5000,
    },
    1040,
  );
  assert.equal(blockedAfterFail.effects.length, 0);

  // Passing wall check unlocks dispatch.
  s = step(
    s,
    {
      type: "machine.wall_checked",
      machineId: "m1",
      passed: true,
      proofDigest: "sha256:good",
    },
    1050,
  ).state;
  const dispatched = step(
    s,
    {
      type: "job.dispatched",
      jobId: "j1",
      runId: "r1",
      machineId: "m1",
      deviceIds: ["gpu0"],
      kind: "measure",
      deadlineAt: 5000,
    },
    1060,
  );
  s = dispatched.state;
  assert.ok(s.jobs.j1);
  assert.ok(dispatched.effects.some((e) => e.kind === "dispatch_job"));

  // Spoofed job.finished from another machine MUST be ignored without mutating job or run state.
  const spoofed = step(
    s,
    {
      type: "job.finished",
      jobId: "j1",
      machineId: "m-attacker",
      outcome: "crash_infra",
    },
    1100,
  );
  assert.equal(spoofed.effects.length, 0);
  assert.equal(spoofed.state.jobs.j1?.status, "running");
  assert.equal(spoofed.state.runs.r1?.infraCrashStreak, 0);

  // clock.tick past deadline emits cancel_job(reason: "timeout") once, and zero persist_pg.
  const tick1 = step(s, { type: "clock.tick", now: 5000 }, 5000);
  s = tick1.state;
  assert.equal(
    tick1.effects.some((e) => e.kind === "persist_pg"),
    false,
  );
  const cancel = tick1.effects.find((e) => e.kind === "cancel_job");
  assert.deepEqual(cancel, { kind: "cancel_job", machineId: "m1", jobId: "j1", reason: "timeout" });
  assert.equal(s.jobs.j1?.status, "cancelling");

  // Repeat tick does not duplicate cancel_job.
  const tick2 = step(s, { type: "clock.tick", now: 5100 }, 5100);
  s = tick2.state;
  assert.equal(
    tick2.effects.some((e) => e.kind === "cancel_job"),
    false,
  );

  // Stale heartbeat beyond DEFAULT_HEARTBEAT_TIMEOUT_MS marks machine offline.
  const staleAt = 1010 + DEFAULT_HEARTBEAT_TIMEOUT_MS + 1;
  const staleTick = step(s, { type: "clock.tick", now: staleAt }, staleAt);
  s = staleTick.state;
  assert.equal(s.machines.m1?.status, "offline");
  assert.equal(
    staleTick.effects.some((e) => e.kind === "persist_pg"),
    false,
  );

  // Fresh heartbeat brings offline machine back online.
  const hb = step(
    s,
    { type: "machine.heartbeat", machineId: "m1", devices: [], activeJobs: [] },
    staleAt + 100,
  );
  assert.equal(hb.state.machines.m1?.status, "online");
  assert.equal(
    hb.effects.some((e) => e.kind === "persist_pg"),
    false,
  );
});

test("Breaker 1: infra crash loop pauses run/lane/advisors, degrades host, resets on non-infra finish", () => {
  let s = setupMachineAndRun();
  let t = 2000;

  const runJob = (jobId: string, outcome: "ok" | "crash_infra" | "invalid", machineId = "m1") => {
    t += 100;
    s = step(
      s,
      {
        type: "job.dispatched",
        jobId,
        runId: "run-1",
        laneId: "lane-a",
        machineId,
        deviceIds: ["gpu0"],
        kind: "measure",
        deadlineAt: t + 10_000,
      },
      t,
    ).state;
    t += 100;
    const res = step(s, { type: "job.finished", jobId, machineId, outcome }, t);
    s = res.state;
    return res;
  };

  // 2 consecutive infra crashes -> not paused yet; non-infra resets both streaks to 0.
  runJob("j1", "crash_infra");
  runJob("j2", "crash_infra");
  assert.equal(s.runs["run-1"]?.infraCrashStreak, 2);
  assert.equal(s.machines.m1?.infraCrashStreak, 2);
  assert.equal(s.runs["run-1"]?.status, "running");

  runJob("j3", "ok");
  assert.equal(s.runs["run-1"]?.infraCrashStreak, 0);
  assert.equal(s.machines.m1?.infraCrashStreak, 0);

  // 3 consecutive infra crashes trip breaker.
  runJob("j4", "crash_infra");
  runJob("j5", "crash_infra");
  const trip = runJob("j6", "crash_infra");

  assert.equal(s.runs["run-1"]?.status, "paused");
  assert.equal(s.runs["run-1"]?.advisorsPaused, true);
  assert.equal(s.runs["run-1"]?.lanes["lane-a"]?.status, "paused");
  assert.equal(s.machines.m1?.degraded, true);
  const need = Object.values(s.needs).find((n) => n.kind === "infra_paused");
  assert.ok(need, "expected infra_paused need");
  assert.equal(need.status, "open");
  assert.ok(
    trip.effects.some(
      (e) =>
        e.kind === "persist_pg" && e.events.some((stored) => stored.event.type === "need.opened"),
    ),
  );

  // Resolving infra_paused with resume restores running status, advisors, and emits lanes projection!
  const resumeEv: DomainEvent = {
    type: "need.resolved",
    needId: need.needId,
    resolution: "resume",
    actor: OWNER,
  };
  const resumed = step(s, resumeEv, t + 100);
  s = resumed.state;
  assert.equal(s.runs["run-1"]?.status, "running");
  assert.equal(s.runs["run-1"]?.advisorsPaused, false);
  assert.equal(s.runs["run-1"]?.infraCrashStreak, 0);
  assert.equal(s.runs["run-1"]?.lanes["lane-a"]?.status, "active");
  const resumePub = resumed.effects.find((e) => e.kind === "publish_nats");
  assert.ok(resumePub);
  assert.equal(resumePub.subject, eventToSubject(resumeEv, "run-1"));
  assert.deepEqual(resumePub.headers, eventHeaders(resumeEv));
  const tripJobPub = trip.effects.find((e) => e.kind === "publish_nats");
  assert.ok(tripJobPub);
  assert.equal(
    tripJobPub.subject,
    eventToSubject(
      { type: "job.finished", jobId: "j6", machineId: "m1", outcome: "crash_infra" },
      "run-1",
    ),
  );
  const resumePg = resumed.effects.find((e) => e.kind === "persist_pg");
  assert.ok(resumePg);
  const laneProj = resumePg.projections.find(
    (p) => p.table === "lanes" && p.id === "run-1:lane-a" && p.runId === "run-1",
  );
  assert.ok(laneProj, "expected lanes upsert projection when infra_paused resumes a lane");
  assert.equal((laneProj.data as { status?: string }).status, "active");

  // Multi-machine infra crash across two hosts pauses run without falsely degrading either host.
  s = step(s, { type: "machine.status_changed", machineId: "m1", status: "online" }, t + 200).state;
  s = step(
    s,
    {
      type: "machine.enrolled",
      machineId: "m2",
      devices: [{ id: "gpu0", kind: "cuda", name: "GPU-1" }],
      wallPlugin: "wall-container",
      wallVersion: "1.0.0",
    },
    t + 210,
  ).state;
  s = step(
    s,
    { type: "machine.wall_checked", machineId: "m2", passed: true, proofDigest: "sha256:m2" },
    t + 220,
  ).state;
  t += 300;
  runJob("j7", "crash_infra", "m1");
  runJob("j8", "crash_infra", "m1");
  runJob("j9", "crash_infra", "m2");
  assert.equal(s.runs["run-1"]?.status, "paused");
  assert.equal(s.machines.m1?.degraded, false);
  assert.equal(s.machines.m2?.degraded, false);
});

test("Breaker 2: identical build failure loop pauses ONLY that lane and triggers teacher advisor", () => {
  let s = setupMachineAndRun({ config: { advisorCooldownMs: 1000 } });
  let t = 2000;

  const finishBuild = (
    jobId: string,
    laneId: string,
    outcome: "ok" | "invalid",
    errorHash?: string,
  ) => {
    t += 100;
    s = step(
      s,
      {
        type: "job.dispatched",
        jobId,
        runId: "run-1",
        laneId,
        machineId: "m1",
        deviceIds: ["gpu0"],
        kind: "build",
        deadlineAt: t + 10_000,
      },
      t,
    ).state;
    t += 100;
    const res = step(
      s,
      {
        type: "job.finished",
        jobId,
        machineId: "m1",
        outcome,
        ...(errorHash !== undefined ? { errorHash } : {}),
      },
      t,
    );
    s = res.state;
    return res;
  };

  // Start lane-b healthy so we prove isolation.
  finishBuild("jb0", "lane-b", "ok");

  // 4 identical hashes, then different hash resets streak to 1, then ok resets to 0.
  for (let i = 1; i <= 4; i += 1) finishBuild(`ja-a${i}`, "lane-a", "invalid", "hash-same");
  assert.equal(s.runs["run-1"]?.lanes["lane-a"]?.identicalInvalidStreak, 4);
  assert.equal(s.runs["run-1"]?.lanes["lane-a"]?.status, "active");

  finishBuild("ja-diff", "lane-a", "invalid", "hash-other");
  assert.equal(s.runs["run-1"]?.lanes["lane-a"]?.identicalInvalidStreak, 1);

  finishBuild("ja-ok", "lane-a", "ok");
  assert.equal(s.runs["run-1"]?.lanes["lane-a"]?.identicalInvalidStreak, 0);

  // 5 consecutive identical hashes pause ONLY lane-a + open build_loop need + trigger teacher!
  for (let i = 1; i <= 4; i += 1) finishBuild(`ja-loop${i}`, "lane-a", "invalid", "err-dup");
  const tripped = finishBuild("ja-loop5", "lane-a", "invalid", "err-dup");

  assert.equal(s.runs["run-1"]?.status, "running", "run stays running");
  assert.equal(s.runs["run-1"]?.lanes["lane-a"]?.status, "paused");
  assert.equal(s.runs["run-1"]?.lanes["lane-b"]?.status, "active");

  const need = Object.values(s.needs).find((n) => n.kind === "build_loop");
  assert.ok(need);
  assert.deepEqual(need.scope, { laneId: "lane-a" });
  const teacher = tripped.effects.find((e) => e.kind === "trigger_advisor");
  assert.equal(teacher?.kind, "trigger_advisor");
  assert.equal(teacher?.role, "teacher");
  assert.equal(teacher?.targetId, "lane-a");

  // Valid planner epoch still dispatches lane-b while skipping paused lane-a!
  const epoch = step(
    s,
    {
      type: "planner.epoch_completed",
      runId: "run-1",
      epoch: 1,
      valid: true,
      assignments: [
        { laneId: "lane-a", goal: "blocked work" },
        { laneId: "lane-b", goal: "healthy work" },
      ],
    },
    t + 100,
  );
  const turns = epoch.effects.filter((e) => e.kind === "invoke_harness_turn");
  assert.equal(turns.length, 1);
  assert.equal(turns[0]?.laneId, "lane-b");
});

test("Breaker 3: first-class rejudge queues without eligible machine, dispatches when wall passes, preserves history", () => {
  let s = createInitialState();
  s = step(
    s,
    {
      type: "run.created",
      runId: "run-1",
      campaignId: "c1",
      mode: "hill_climb",
      config: baseConfig(),
    },
    1000,
  ).state;
  s = step(
    s,
    {
      type: "attempt.submitted",
      runId: "run-1",
      laneId: "lane-1",
      attemptId: "a1",
      commitRef: "deadbeef1234",
      summary: "tiled kernel",
    },
    1010,
  ).state;
  s = step(
    s,
    {
      type: "attempt.judged",
      runId: "run-1",
      attemptId: "a1",
      verdict: { outcome: "improve", metricDelta: 0.08 },
      judgePlugin: "judge-stat",
      judgeVersion: "1.0.0",
    },
    1020,
  ).state;

  // No eligible machine yet -> rejudge queues on run.pendingRejudges.
  const queued = step(
    s,
    {
      type: "attempt.rejudge_requested",
      runId: "run-1",
      attemptId: "a1",
      reason: "thermal drift check",
      actor: DELEGATE,
    },
    1030,
  );
  s = queued.state;
  assert.deepEqual(s.runs["run-1"]?.pendingRejudges, ["a1"]);
  assert.equal(
    queued.effects.some((e) => e.kind === "dispatch_job"),
    false,
  );

  // Enroll machine -> still queued until wall_checked(passed: true).
  s = step(
    s,
    {
      type: "machine.enrolled",
      machineId: "m1",
      devices: [{ id: "gpu0", kind: "cuda", name: "GPU-0" }],
      wallPlugin: "wall-container",
      wallVersion: "1.0.0",
    },
    1040,
  ).state;
  assert.deepEqual(s.runs["run-1"]?.pendingRejudges, ["a1"]);

  // Wall proof passes -> pending rejudge automatically dispatches measure job with immutable commitRef!
  const wallOk = step(
    s,
    { type: "machine.wall_checked", machineId: "m1", passed: true, proofDigest: "sha256:p" },
    1050,
  );
  s = wallOk.state;
  assert.deepEqual(s.runs["run-1"]?.pendingRejudges, []);
  const dispatch = wallOk.effects.find((e) => e.kind === "dispatch_job");
  assert.equal(dispatch?.kind, "dispatch_job");
  assert.equal(dispatch?.machineId, "m1");
  assert.equal(dispatch?.job.kind, "measure");
  assert.equal(dispatch?.job.rejudgeOf, "a1");
  assert.equal(dispatch?.job.commitRef, "deadbeef1234");
  const wallPg = wallOk.effects.find((e) => e.kind === "persist_pg");
  assert.ok(wallPg);
  const m1Ops = wallPg.projections.filter((p) => p.table === "machines" && p.id === "m1");
  assert.equal(m1Ops.length, 1, "expected single deduplicated machines upsert on rejudge drain");
  const m1Data = m1Ops[0]?.data as { activeJobs?: readonly string[] } | undefined;
  assert.ok(
    m1Data?.activeJobs?.includes(dispatch?.job.jobId ?? ""),
    "machines upsert projection must reflect activeJobs after rejudge dispatch",
  );

  // Rejudge verdict supersedes active verdict while keeping prior verdicts + rejudges[] history!
  s = step(
    s,
    {
      type: "attempt.judged",
      runId: "run-1",
      attemptId: "a1",
      rejudgeOf: "a1",
      verdict: { outcome: "improve", metricDelta: 0.11 },
      judgePlugin: "judge-stat",
      judgeVersion: "1.1.0",
    },
    1060,
  ).state;

  const attempt = s.attempts.a1;
  assert.ok(attempt);
  assert.equal(attempt.commitRef, "deadbeef1234");
  assert.equal(attempt.verdict?.metricDelta, 0.11);
  assert.equal(attempt.judgePlugin, "judge-stat");
  assert.equal(attempt.judgeVersion, "1.1.0");
  assert.equal(attempt.verdicts.length, 2);
  assert.equal(attempt.rejudges.length, 1);
  assert.equal(attempt.verdicts[0]?.judgeVersion, "1.0.0");
  assert.equal(attempt.rejudges[0]?.judgeVersion, "1.1.0");
});

test("Breaker 4: planner invalid-epoch drift switches to fallback model or pauses (never silent FIFO)", () => {
  // Case A: Fallback model configured -> switches after 2 invalid epochs, then pauses if fallback also fails twice.
  let s = setupMachineAndRun({
    config: { plannerModel: "model-primary", plannerFallbackModel: "model-fallback" },
  });

  const e1 = step(
    s,
    { type: "planner.epoch_completed", runId: "run-1", epoch: 1, valid: false, error: "bad json" },
    2000,
  );
  s = e1.state;
  assert.equal(s.runs["run-1"]?.planner.invalidEpochStreak, 1);
  assert.equal(s.runs["run-1"]?.planner.activeModel, "model-primary");
  assert.equal(
    e1.effects.some((e) => e.kind === "invoke_harness_turn"),
    false,
  );

  // Valid epoch resets streak.
  const eValid = step(
    s,
    {
      type: "planner.epoch_completed",
      runId: "run-1",
      epoch: 2,
      valid: true,
      assignments: [{ laneId: "lane-1", goal: "try vectorize" }],
    },
    2010,
  );
  s = eValid.state;
  assert.equal(s.runs["run-1"]?.planner.invalidEpochStreak, 0);
  assert.equal(eValid.effects.filter((e) => e.kind === "invoke_harness_turn").length, 1);

  // Two consecutive invalid epochs -> switches to fallback model, resets streak, does NOT pause yet.
  s = step(
    s,
    { type: "planner.epoch_completed", runId: "run-1", epoch: 3, valid: false, error: "schema" },
    2020,
  ).state;
  const switched = step(
    s,
    { type: "planner.epoch_completed", runId: "run-1", epoch: 4, valid: false, error: "schema" },
    2030,
  );
  s = switched.state;
  assert.equal(s.runs["run-1"]?.planner.activeModel, "model-fallback");
  assert.equal(s.runs["run-1"]?.planner.usedFallback, true);
  assert.equal(s.runs["run-1"]?.planner.invalidEpochStreak, 0);
  assert.equal(s.runs["run-1"]?.planner.paused, false);
  assert.equal(Object.keys(s.needs).length, 0);
  assert.equal(
    switched.effects.some((e) => e.kind === "invoke_harness_turn"),
    false,
  );

  // Two consecutive invalid epochs on fallback -> pauses planning & opens planner_failed need!
  s = step(
    s,
    { type: "planner.epoch_completed", runId: "run-1", epoch: 5, valid: false, error: "empty" },
    2040,
  ).state;
  const paused = step(
    s,
    { type: "planner.epoch_completed", runId: "run-1", epoch: 6, valid: false, error: "empty" },
    2050,
  );
  s = paused.state;
  assert.equal(s.runs["run-1"]?.planner.paused, true);
  assert.equal(
    paused.effects.some((e) => e.kind === "invoke_harness_turn"),
    false,
  );
  const need = Object.values(s.needs).find((n) => n.kind === "planner_failed");
  assert.ok(need);

  // Case B: No fallback configured -> pauses immediately at 2nd invalid epoch.
  let noFb = setupMachineAndRun({ runId: "run-nofb", config: { plannerModel: "only-model" } });
  noFb = step(
    noFb,
    { type: "planner.epoch_completed", runId: "run-nofb", epoch: 1, valid: false },
    3000,
  ).state;
  noFb = step(
    noFb,
    { type: "planner.epoch_completed", runId: "run-nofb", epoch: 2, valid: false },
    3010,
  ).state;
  assert.equal(noFb.runs["run-nofb"]?.planner.paused, true);
  assert.ok(Object.values(noFb.needs).some((n) => n.kind === "planner_failed"));
});

test("Breaker 5: research oscillation freezes ONLY oscillating hypothesis, allows monotonic certainty gain", () => {
  let s = setupMachineAndRun({ config: { mode: "research", oscillationRounds: 3 } });

  // hyp-progress: flip-flops decision BUT strictly gains certainty (low -> medium -> high) => NOT stalled!
  s = step(
    s,
    {
      type: "research.round_recorded",
      runId: "run-1",
      hypothesisId: "hyp-progress",
      decision: "support",
      certainty: "low",
      summary: "initial hint",
    },
    2000,
  ).state;
  s = step(
    s,
    {
      type: "research.round_recorded",
      runId: "run-1",
      hypothesisId: "hyp-progress",
      decision: "refute",
      certainty: "medium",
      summary: "counter evidence",
    },
    2100,
  ).state;
  s = step(
    s,
    {
      type: "research.round_recorded",
      runId: "run-1",
      hypothesisId: "hyp-progress",
      decision: "support",
      certainty: "high",
      summary: "resolved with deeper source",
    },
    2200,
  ).state;
  assert.equal(s.runs["run-1"]?.hypotheses["hyp-progress"]?.status, "active");

  // hyp-loop: cycles support(medium) -> refute(low) -> support(medium) without monotonic gain => STALLED!
  s = step(
    s,
    {
      type: "research.round_recorded",
      runId: "run-1",
      hypothesisId: "hyp-loop",
      decision: "support",
      certainty: "medium",
      summary: "r1",
    },
    2300,
  ).state;
  s = step(
    s,
    {
      type: "research.round_recorded",
      runId: "run-1",
      hypothesisId: "hyp-loop",
      decision: "refute",
      certainty: "low",
      summary: "r2",
    },
    2400,
  ).state;
  s = step(
    s,
    {
      type: "research.round_recorded",
      runId: "run-1",
      hypothesisId: "hyp-loop",
      decision: "support",
      certainty: "medium",
      summary: "r3",
    },
    2500,
  ).state;

  assert.equal(s.runs["run-1"]?.status, "running");
  assert.equal(s.runs["run-1"]?.hypotheses["hyp-loop"]?.status, "stalled");
  assert.equal(s.runs["run-1"]?.hypotheses["hyp-progress"]?.status, "active");
  const need = Object.values(s.needs).find((n) => n.kind === "research_oscillation");
  assert.ok(need);
  assert.deepEqual(need.scope, { hypothesisId: "hyp-loop" });
  assert.match(need.summary, /support\(medium\) -> refute\(low\) -> support\(medium\)/);

  // Resuming stalled hypothesis records resumedAtRound without erasing full history,
  // does NOT re-stall on the very next round, and DOES stall again on a fresh 3-round cycle.
  s = step(
    s,
    { type: "need.resolved", needId: need.needId, resolution: "resume", actor: OWNER },
    2600,
  ).state;
  assert.equal(s.runs["run-1"]?.hypotheses["hyp-loop"]?.status, "active");
  assert.equal(s.runs["run-1"]?.hypotheses["hyp-loop"]?.resumedAtRound, 3);
  assert.equal(s.runs["run-1"]?.hypotheses["hyp-loop"]?.history.length, 3);

  s = step(
    s,
    {
      type: "research.round_recorded",
      runId: "run-1",
      hypothesisId: "hyp-loop",
      decision: "refute",
      certainty: "low",
      summary: "r4 after resume",
    },
    2700,
  ).state;
  assert.equal(
    s.runs["run-1"]?.hypotheses["hyp-loop"]?.status,
    "active",
    "must not immediately re-stall on first round after resume",
  );

  s = step(
    s,
    {
      type: "research.round_recorded",
      runId: "run-1",
      hypothesisId: "hyp-loop",
      decision: "support",
      certainty: "low",
      summary: "r5",
    },
    2800,
  ).state;
  assert.equal(s.runs["run-1"]?.hypotheses["hyp-loop"]?.status, "active");

  s = step(
    s,
    {
      type: "research.round_recorded",
      runId: "run-1",
      hypothesisId: "hyp-loop",
      decision: "refute",
      certainty: "low",
      summary: "r6 fresh cycle",
    },
    2900,
  ).state;
  assert.equal(s.runs["run-1"]?.hypotheses["hyp-loop"]?.status, "stalled");
  assert.equal(s.runs["run-1"]?.hypotheses["hyp-loop"]?.history.length, 6);
});

test("Breaker 6: narrowed non-blocking audit holds + auditor timeout (proceed and need_owner)", () => {
  // Part A: gaming/defect finding holds ONLY that attempt while other lanes keep promoting.
  let s = setupMachineAndRun({ config: { auditTimeoutMs: 5000, onAuditTimeout: "need_owner" } });
  s = step(
    s,
    {
      type: "attempt.submitted",
      runId: "run-1",
      laneId: "lane-a",
      attemptId: "a-suspect",
      commitRef: "ref-a",
      summary: "suspect patch",
    },
    2000,
  ).state;
  s = step(
    s,
    {
      type: "attempt.submitted",
      runId: "run-1",
      laneId: "lane-b",
      attemptId: "b-clean",
      commitRef: "ref-b",
      summary: "clean patch",
    },
    2010,
  ).state;

  s = step(
    s,
    {
      type: "advisor.completed",
      runId: "run-1",
      role: "auditor",
      targetId: "a-suspect",
      finding: { kind: "gaming", summary: "skips benchmark validation" },
    },
    2020,
  ).state;

  assert.equal(s.attempts["a-suspect"]?.status, "held");
  const holdNeedId = s.attempts["a-suspect"]?.pendingNeedId;
  assert.ok(holdNeedId);
  assert.equal(s.runs["run-1"]?.status, "running");

  // Promotion of held attempt is blocked while need is open.
  const blockedPromote = step(
    s,
    {
      type: "attempt.promoted",
      runId: "run-1",
      attemptId: "a-suspect",
      commitRef: "ref-a",
      metricDelta: 0.5,
      actor: DELEGATE,
    },
    2030,
  );
  assert.equal(blockedPromote.effects.length, 0);
  assert.equal(s.runs["run-1"]?.championAttemptId, undefined);

  // Other lane's attempt promotes without being blocked!
  const promotedB = step(
    s,
    {
      type: "attempt.promoted",
      runId: "run-1",
      attemptId: "b-clean",
      commitRef: "ref-b",
      metricDelta: 0.1,
      actor: DELEGATE,
    },
    2040,
  );
  s = promotedB.state;
  assert.equal(s.runs["run-1"]?.championAttemptId, "b-clean");
  assert.ok(promotedB.effects.some((e) => e.kind === "sync_git"));

  // Resolving held need with "approve" releases the hold so promotion can succeed; "decline" declines cleanly.
  s = step(
    s,
    { type: "need.resolved", needId: holdNeedId, resolution: "approve", actor: OWNER },
    2050,
  ).state;
  assert.equal(s.attempts["a-suspect"]?.status, "judged");
  assert.equal(s.attempts["a-suspect"]?.pendingNeedId, undefined);

  // Part B: Auditor timeout with onAuditTimeout = "need_owner" holds ONLY timed-out attempt,
  // persists ONLY the synthetic need.opened event (never clock.tick!), and publishes matching NATS headers.
  s = step(
    s,
    {
      type: "attempt.submitted",
      runId: "run-1",
      laneId: "lane-a",
      attemptId: "a-to",
      commitRef: "ref-to",
      summary: "candidate",
    },
    3000,
  ).state;
  const judgedTo = step(
    s,
    {
      type: "attempt.judged",
      runId: "run-1",
      attemptId: "a-to",
      verdict: { outcome: "improve", metricDelta: 0.2 },
      judgePlugin: "judge-stat",
      judgeVersion: "1.0.0",
    },
    3010,
  );
  s = judgedTo.state;
  assert.ok(judgedTo.effects.some((e) => e.kind === "trigger_advisor" && e.role === "auditor"));
  assert.ok(s.runs["run-1"]?.pendingAudits["a-to"]);

  const seqBeforeTick = s.seq;
  const stateBeforeTick = s;
  const toTick = step(s, { type: "clock.tick", now: 8010 }, 8010);
  s = toTick.state;
  assert.equal(s.seq, seqBeforeTick + 1, "synthetic need.opened advances seq");
  const tickPg = toTick.effects.find((e) => e.kind === "persist_pg");
  assert.ok(tickPg, "expected persist_pg for synthetic audit_timeout need.opened");
  assert.equal(tickPg.events.length, 1);
  const synEv = tickPg.events[0]?.event;
  assert.equal(synEv?.type, "need.opened", "never persist clock.tick; only synthetic need.opened");
  assert.equal(synEv?.kind, "audit_timeout");
  const tickPub = toTick.effects.find((e) => e.kind === "publish_nats");
  assert.ok(tickPub && synEv);
  assert.equal(tickPub.subject, eventToSubject(synEv, "run-1"));
  assert.deepEqual(tickPub.headers, eventHeaders(synEv));
  assert.equal(tickPub.headers?.["Thermite-Attempt"], "a-to");
  assert.equal(s.runs["run-1"]?.pendingAudits["a-to"], undefined);
  assert.equal(s.attempts["a-to"]?.status, "held");
  const timeoutNeedId = s.attempts["a-to"]?.pendingNeedId;
  assert.ok(timeoutNeedId);
  assert.equal(s.needs[timeoutNeedId]?.kind, "audit_timeout");

  // Replaying the persisted synthetic need.opened + subsequent need.resolved reproduces held -> declined!
  const declineEv: DomainEvent = {
    type: "need.resolved",
    needId: timeoutNeedId,
    resolution: "decline",
    actor: OWNER,
  };
  s = step(s, declineEv, 8020).state;
  assert.equal(s.attempts["a-to"]?.status, "declined");
  assert.equal(s.attempts["a-to"]?.pendingNeedId, undefined);
  const replayedOpen = replay(stateBeforeTick, [{ event: synEv, now: 8010 }]);
  assert.equal(
    replayedOpen.runs["run-1"]?.pendingAudits["a-to"],
    undefined,
    "replaying audit_timeout need.opened must clear pendingAudits",
  );
  const afterRestartTick = step(replayedOpen, { type: "clock.tick", now: 9000 }, 9000);
  assert.equal(
    afterRestartTick.effects.some((e) => e.kind === "persist_pg"),
    false,
    "follow-up clock.tick after replay must not fire duplicate audit_timeout need",
  );
  assert.equal(
    Object.keys(afterRestartTick.state.needs).length,
    Object.keys(replayedOpen.needs).length,
  );
  const replayed = replay(replayedOpen, [{ event: declineEv, now: 8020 }]);
  assert.equal(replayed.attempts["a-to"]?.status, "declined");
  assert.equal(replayed.needs[timeoutNeedId]?.status, "resolved");
  assert.equal(replayed.needs[timeoutNeedId]?.resolution, "decline");

  // Part C: Auditor timeout with onAuditTimeout = "proceed" releases pending audit without opening need.
  let sp = setupMachineAndRun({
    runId: "run-proceed",
    config: { auditTimeoutMs: 2000, onAuditTimeout: "proceed" },
  });
  sp = step(
    sp,
    {
      type: "attempt.submitted",
      runId: "run-proceed",
      laneId: "lane-1",
      attemptId: "ap1",
      commitRef: "ref-p1",
      summary: "candidate",
    },
    10_000,
  ).state;
  sp = step(
    sp,
    {
      type: "attempt.judged",
      runId: "run-proceed",
      attemptId: "ap1",
      verdict: { outcome: "improve", metricDelta: 0.15 },
      judgePlugin: "judge-stat",
      judgeVersion: "1.0.0",
    },
    10_010,
  ).state;
  const proceedTick = step(sp, { type: "clock.tick", now: 12_010 }, 12_010);
  sp = proceedTick.state;
  assert.equal(sp.runs["run-proceed"]?.pendingAudits.ap1, undefined);
  assert.equal(sp.attempts.ap1?.status, "judged");
  assert.equal(Object.keys(sp.needs).length, 0);

  // Promotion proceeds cleanly after timeout!
  const promotedProceed = step(
    sp,
    {
      type: "attempt.promoted",
      runId: "run-proceed",
      attemptId: "ap1",
      commitRef: "ref-p1",
      metricDelta: 0.15,
      actor: DELEGATE,
    },
    12_020,
  );
  assert.equal(promotedProceed.state.runs["run-proceed"]?.championAttemptId, "ap1");
});

test("Breaker 7: cooldown-gated advisors and active ScopedDirective / AVOID carve-outs on harness turns", () => {
  let s = setupMachineAndRun({
    config: { advisorCooldownMs: 10_000, gitPolicy: { onChampion: "none" } },
  });

  // Submit two attempts to test strategist cooldown on promotion + regression.
  s = step(
    s,
    {
      type: "attempt.submitted",
      runId: "run-1",
      laneId: "lane-1",
      attemptId: "a1",
      commitRef: "c1",
      summary: "s1",
    },
    2000,
  ).state;
  s = step(
    s,
    {
      type: "attempt.submitted",
      runId: "run-1",
      laneId: "lane-2",
      attemptId: "a2",
      commitRef: "c2",
      summary: "s2",
    },
    2010,
  ).state;

  // First promotion triggers strategist (and skips sync_git because onChampion === "none").
  const p1 = step(
    s,
    {
      type: "attempt.promoted",
      runId: "run-1",
      attemptId: "a1",
      commitRef: "c1",
      metricDelta: 0.05,
      actor: OWNER,
    },
    3000,
  );
  s = p1.state;
  assert.equal(
    p1.effects.some((e) => e.kind === "sync_git"),
    false,
  );
  assert.equal(
    p1.effects.some((e) => e.kind === "trigger_advisor" && e.role === "strategist"),
    true,
  );

  // Regression inside cooldown window (3000 + 5000 < 13000) is suppressed!
  const regSuppressed = step(
    s,
    {
      type: "attempt.judged",
      runId: "run-1",
      attemptId: "a2",
      verdict: { outcome: "regress", metricDelta: -0.04 },
      judgePlugin: "judge-stat",
      judgeVersion: "1.0.0",
    },
    8000,
  );
  s = regSuppressed.state;
  assert.equal(
    regSuppressed.effects.some((e) => e.kind === "trigger_advisor" && e.role === "strategist"),
    false,
  );

  // After cooldown window (13_500 >= 3000 + 10_000), strategist triggers again!
  const regTriggered = step(
    s,
    {
      type: "attempt.judged",
      runId: "run-1",
      attemptId: "a2",
      verdict: { outcome: "regress", metricDelta: -0.05 },
      judgePlugin: "judge-stat",
      judgeVersion: "1.0.0",
    },
    13_500,
  );
  s = regTriggered.state;
  assert.equal(
    regTriggered.effects.some((e) => e.kind === "trigger_advisor" && e.role === "strategist"),
    true,
  );

  // Advisor emits ScopedDirectives: global AVOID carve-out, lane-1-only focus, and expiring constraint.
  const directives: readonly ScopedDirective[] = [
    {
      id: "d-avoid",
      kind: "avoid",
      pathPattern: "src/kernel/**",
      condition: "unless cache aligned",
      instruction: "Avoid unaligned loads in inner kernel",
    },
    {
      id: "d-lane1",
      kind: "focus",
      laneId: "lane-1",
      instruction: "Tune block size 32..64",
    },
    {
      id: "d-expiring",
      kind: "constraint",
      instruction: "Temporary flag",
      expiresAt: 15_000,
    },
  ];
  s = step(
    s,
    {
      type: "advisor.completed",
      runId: "run-1",
      role: "strategist",
      directives,
    },
    14_000,
  ).state;

  // Before expiry (14_500): lane-1 gets all 3; lane-2 gets d-avoid + d-expiring (not d-lane1).
  const ep1 = step(
    s,
    {
      type: "planner.epoch_completed",
      runId: "run-1",
      epoch: 1,
      valid: true,
      assignments: [
        { laneId: "lane-1", goal: "g1" },
        { laneId: "lane-2", goal: "g2" },
      ],
    },
    14_500,
  );
  s = ep1.state;
  const turns1 = ep1.effects.filter((e) => e.kind === "invoke_harness_turn");
  const tLane1 = turns1.find((t) => t.laneId === "lane-1");
  const tLane2 = turns1.find((t) => t.laneId === "lane-2");
  assert.deepEqual(
    tLane1?.directives.map((d) => d.id),
    ["d-avoid", "d-lane1", "d-expiring"],
  );
  assert.deepEqual(
    tLane2?.directives.map((d) => d.id),
    ["d-avoid", "d-expiring"],
  );

  // After expiry (15_500): d-expiring is excluded!
  const ep2 = step(
    s,
    {
      type: "planner.epoch_completed",
      runId: "run-1",
      epoch: 2,
      valid: true,
      assignments: [{ laneId: "lane-1", goal: "g3" }],
    },
    15_500,
  );
  const turn2 = ep2.effects.find((e) => e.kind === "invoke_harness_turn");
  assert.deepEqual(
    turn2?.directives.map((d) => d.id),
    ["d-avoid", "d-lane1"],
  );
});

test("deterministic multi-mode replay produces byte-identical JSON in < 10 ms without mutating input state", () => {
  const stream: ReplayEntry[] = [
    {
      now: 1000,
      event: {
        type: "run.created",
        runId: "r-hc",
        campaignId: "c1",
        mode: "hill_climb",
        config: baseConfig({ live: true, plannerModel: "m-main", plannerFallbackModel: "m-fb" }),
      },
    },
    {
      now: 1010,
      event: {
        type: "run.created",
        runId: "r-res",
        campaignId: "c2",
        mode: "research",
        config: baseConfig({ mode: "research", live: false }),
      },
    },
    {
      now: 1020,
      event: {
        type: "machine.enrolled",
        machineId: "m1",
        devices: [{ id: "metal0", kind: "metal", name: "Apple GPU" }],
        wallPlugin: "wall-microsandbox",
        wallVersion: "1.0.0",
      },
    },
    {
      now: 1030,
      event: { type: "machine.wall_checked", machineId: "m1", passed: true, proofDigest: "d1" },
    },
  ];

  for (let i = 1; i <= 10; i += 1) {
    const base = 2000 + i * 1000;
    stream.push(
      {
        now: base,
        event: {
          type: "planner.epoch_completed",
          runId: "r-hc",
          epoch: i,
          valid: true,
          assignments: [{ laneId: "lane-1", goal: `step ${i}` }],
        },
      },
      {
        now: base + 100,
        event: {
          type: "attempt.submitted",
          runId: "r-hc",
          laneId: "lane-1",
          attemptId: `a${i}`,
          commitRef: `sha-${i}`,
          summary: `attempt ${i}`,
        },
      },
      {
        now: base + 200,
        event: {
          type: "attempt.judged",
          runId: "r-hc",
          attemptId: `a${i}`,
          verdict: { outcome: i % 2 === 0 ? "improve" : "neutral", metricDelta: i * 0.01 },
          judgePlugin: "judge-stat",
          judgeVersion: "1.0.0",
        },
      },
      {
        now: base + 250,
        event: {
          type: "advisor.completed",
          runId: "r-hc",
          role: "auditor",
          targetId: `a${i}`,
          finding: { kind: "clean", summary: "ok" },
        },
      },
    );
    if (i % 2 === 0) {
      stream.push(
        {
          now: base + 300,
          event: {
            type: "attempt.promoted",
            runId: "r-hc",
            attemptId: `a${i}`,
            commitRef: `sha-${i}`,
            metricDelta: i * 0.01,
            actor: DELEGATE,
          },
        },
        {
          now: base + 350,
          event: {
            type: "git.sync_finished",
            runId: "r-hc",
            attemptId: `a${i}`,
            ok: true,
            ref: `refs/heads/champ-${i}`,
          },
        },
      );
    }
  }

  stream.push(
    {
      now: 15_000,
      event: {
        type: "research.round_recorded",
        runId: "r-res",
        hypothesisId: "h1",
        decision: "support",
        certainty: "low",
        summary: "round 1",
      },
    },
    {
      now: 15_100,
      event: {
        type: "research.round_recorded",
        runId: "r-res",
        hypothesisId: "h1",
        decision: "refute",
        certainty: "low",
        summary: "round 2",
      },
    },
    {
      now: 15_200,
      event: {
        type: "research.round_recorded",
        runId: "r-res",
        hypothesisId: "h1",
        decision: "support",
        certainty: "low",
        summary: "round 3",
      },
    },
    { now: 16_000, event: { type: "clock.tick", now: 16_000 } },
  );

  // Verify immutability at every single step via deepFreeze.
  let checked = createInitialState();
  for (const entry of stream) {
    checked = step(checked, entry.event, entry.now).state;
  }

  // Time two full replays and compare serialized JSON byte-for-byte.
  const t0 = performance.now();
  const r1 = replay(createInitialState(), stream);
  const r2 = replay(createInitialState(), stream);
  const elapsedMs = performance.now() - t0;

  const json1 = JSON.stringify(r1);
  const json2 = JSON.stringify(r2);
  assert.equal(json1, json2);
  assert.equal(json1, JSON.stringify(checked));
  assert.ok(elapsedMs < 10, `expected replay < 10 ms, got ${elapsedMs.toFixed(2)} ms`);
});
