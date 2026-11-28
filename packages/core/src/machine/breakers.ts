import { buildEventPublishEffect, type Effect, liveEffect } from "./effects.ts";
import type { DomainEvent, PersistedDomainEvent, StoredEvent } from "./events.ts";
import * as S from "./state.ts";
import type * as T from "./types.ts";
import { CERTAINTY_RANK } from "./types.ts";

type NeedEv = Extract<PersistedDomainEvent, { readonly type: "need.opened" }>;
type JobFinEv = Extract<DomainEvent, { readonly type: "job.finished" }>;
type PlanEv = Extract<DomainEvent, { readonly type: "planner.epoch_completed" }>;
type ResEv = Extract<DomainEvent, { readonly type: "research.round_recorded" }>;
type AdvEv = Extract<DomainEvent, { readonly type: "advisor.completed" }>;
export type SyntheticNeed = Readonly<{ seq: number; need: S.NeedState; event: NeedEv }>;
export type BreakerCtx = Readonly<{ state: S.ControlState; now: number; nextSeq: () => number }>;
export type BreakerOut = { run: S.RunState; effects: Effect[]; syntheticNeeds: SyntheticNeed[] };
type NeedIn = { runId: string; kind: T.NeedKind; scope: T.NeedScope; summary: string };
type AdvReq = { role: T.AdvisorRole; reason: string; now: number; tid?: string };
type JobIn = { run: S.RunState; m: S.MachineState; job: S.JobState; ev: JobFinEv };
type RejIn = { run: S.RunState; a: S.AttemptState; reason: string; seq?: number };

const runLive = (r: S.RunState, tag: string, delta: unknown): Effect =>
  liveEffect(`run.${r.runId}.${tag}`, delta, r.runId, S.isPublicLiveRun(r));

export function createSyntheticNeed(i: NeedIn, seq: number, now: number): SyntheticNeed {
  const base = { needId: `need:${i.runId}:${i.kind}:${seq}`, ...i };
  const need: S.NeedState = { ...base, status: "open", openedAt: now };
  return { seq, need, event: { type: "need.opened", ...base } };
}

function addNeed(c: BreakerCtx, out: SyntheticNeed[], i: NeedIn) {
  if (!S.hasOpenNeed(c.state, i.runId, i.kind, i.scope))
    out.push(createSyntheticNeed(i, c.nextSeq(), c.now));
}

export function pushAdvisor(r: S.RunState, req: AdvReq, out: Effect[]): S.RunState {
  if (r.advisorsPaused || r.status !== "running") return r;
  const { runId } = r;
  const { role, reason, now, tid: targetId } = req;
  const cfg = S.resolveBreakerConfig(r.config);
  const deadlineAt = now + cfg.auditTimeoutMs;
  const eff: Effect = { kind: "trigger_advisor", runId, role, targetId, reason, deadlineAt };
  const advisorLastAt = { ...r.advisorLastAt, [role]: now };
  if (role === "auditor" && targetId !== undefined) {
    if (r.pendingAudits[targetId]) return r;
    out.push(eff);
    const pendingAudits = S.put(r.pendingAudits, targetId, { targetId, role, deadlineAt });
    return { ...r, advisorLastAt, pendingAudits };
  }
  const last = r.advisorLastAt[role];
  if (last !== undefined && now - last < cfg.advisorCooldownMs) return r;
  out.push(eff);
  return { ...r, advisorLastAt };
}

export function evaluateJobOutcomeBreakers(ctx: BreakerCtx, i: JobIn) {
  const { state, now } = ctx;
  let { run, m } = i;
  const { job, ev } = i;
  const cfg = S.resolveBreakerConfig(run.config);
  const { runId } = run;
  const needs: SyntheticNeed[] = [];
  const effects: Effect[] = [];
  const lid = job.laneId ?? (job.attemptId ? state.attempts[job.attemptId]?.laneId : undefined);
  const putL = (l: S.LaneState) => {
    run = { ...run, lanes: S.put(run.lanes, l.laneId, l) };
  };
  if (ev.outcome === "crash_infra") {
    const rs = run.infraCrashStreak + 1;
    const ms = m.infraCrashStreak + 1;
    const deg = ms >= cfg.infraCrashLimit;
    m = { ...m, infraCrashStreak: ms, degraded: m.degraded || deg };
    run = { ...run, infraCrashStreak: rs };
    if (rs >= cfg.infraCrashLimit) {
      if (lid)
        putL({ ...S.ensureLane(run, lid), status: "paused", pauseReason: "infra_crash_loop" });
      run = { ...run, status: "paused", advisorsPaused: true };
      const host = deg ? ` (machine ${m.machineId} degraded)` : "";
      const summary = `Paused after ${rs} infra crashes${host}`;
      const scope = lid ? { laneId: lid } : {};
      addNeed(ctx, needs, { runId, kind: "infra_paused", scope, summary });
    }
  } else {
    if (run.infraCrashStreak) run = { ...run, infraCrashStreak: 0 };
    if (m.infraCrashStreak) m = { ...m, infraCrashStreak: 0 };
  }
  if (lid && (ev.outcome === "invalid" || ev.outcome === "ok")) {
    const existed = run.lanes[lid] !== undefined;
    const lane = S.ensureLane(run, lid);
    if (ev.outcome === "ok") {
      if (!existed || lane.identicalInvalidStreak || lane.lastInvalidHash !== undefined)
        putL({ ...lane, lastInvalidHash: undefined, identicalInvalidStreak: 0 });
    } else {
      const h = ev.errorHash?.trim() || "__unhashed_invalid__";
      const n = lane.lastInvalidHash === h ? lane.identicalInvalidStreak + 1 : 1;
      const trip = n >= cfg.identicalBuildLimit;
      const upd: S.LaneState = { ...lane, lastInvalidHash: h, identicalInvalidStreak: n };
      putL(trip ? { ...upd, status: "paused", pauseReason: "build_loop" } : upd);
      if (trip) {
        const summary = `Lane ${lid} paused: ${n} identical builds (${h})`;
        addNeed(ctx, needs, { runId, kind: "build_loop", scope: { laneId: lid }, summary });
        run = pushAdvisor(run, { role: "teacher", reason: "build_loop", now, tid: lid }, effects);
      }
    }
  }
  return { run, machine: m, syntheticNeeds: needs, effects };
}

export function scheduleRejudgeJob(ctx: BreakerCtx, i: RejIn) {
  const { run, a, reason } = i;
  const seq = i.seq ?? ctx.nextSeq();
  const m = S.selectEligibleMachine(ctx.state);
  if (!m) {
    const q = run.pendingRejudges;
    return { run: { ...run, pendingRejudges: q.includes(a.attemptId) ? q : [...q, a.attemptId] } };
  }
  const jobId = `rejudge:${a.attemptId}:${seq}`;
  const deviceIds = m.devices.map((d) => d.id);
  const deadlineAt = ctx.now + S.resolveBreakerConfig(run.config).defaultJobTimeoutMs;
  const { attemptId, laneId, commitRef } = a;
  const s1 = { jobId, runId: run.runId, attemptId, laneId, deviceIds, kind: "measure" as const };
  const spec = { ...s1, deadlineAt, rejudgeOf: attemptId };
  const pendingRejudges = run.pendingRejudges.filter((id) => id !== attemptId);
  const activeJobs = m.activeJobs.includes(jobId) ? m.activeJobs : [...m.activeJobs, jobId];
  const job: S.JobState = { ...spec, machineId: m.machineId, status: "running" };
  const jSpec: T.JobSpec = { ...spec, commitRef, reason };
  const effect: Effect = { kind: "dispatch_job", machineId: m.machineId, job: jSpec };
  return { run: { ...run, pendingRejudges }, machine: { ...m, activeJobs }, job, effect };
}

export function applyJudgedVerdict(a: S.AttemptState, r: T.JudgedVerdictRecord, rej: boolean) {
  const status = a.status === "submitted" ? "judged" : a.status;
  const { verdict, judgePlugin, judgeVersion } = r;
  const verdicts = [...a.verdicts, r];
  const rejudges = rej ? [...a.rejudges, r] : a.rejudges;
  return { ...a, status, verdict, judgePlugin, judgeVersion, verdicts, rejudges };
}

export function evaluatePlannerEpoch(ctx: BreakerCtx, r0: S.RunState, ev: PlanEv): BreakerOut {
  const cfg = S.resolveBreakerConfig(r0.config);
  let run = r0;
  const needs: SyntheticNeed[] = [];
  const effects: Effect[] = [];
  const { runId } = run;
  const { epoch, valid, assignments, error } = ev;
  if (valid) {
    const p = { ...run.planner, lastEpoch: epoch, invalidEpochStreak: 0, lastError: undefined };
    run = { ...run, planner: p };
    if (run.status === "running" && !p.paused && assignments) {
      let lanes = run.lanes;
      for (const t of assignments) {
        const lane = S.ensureLane(run, t.laneId);
        if (!lanes[t.laneId]) lanes = S.put(lanes, t.laneId, lane);
        if (lane.status !== "active") continue;
        const { harness: h, ...rest } = t;
        const c1 = { ...rest, runId, epoch, mode: run.mode, model: p.activeModel };
        const promptCtx: T.TurnContext = { ...c1, championAttemptId: run.championAttemptId };
        const directives = S.selectActiveDirectives(run, t.laneId, ctx.now);
        const turn = { kind: "invoke_harness_turn" as const, runId, laneId: t.laneId };
        effects.push({ ...turn, harness: h ?? cfg.harness, promptCtx, directives });
      }
      if (lanes !== run.lanes) run = { ...run, lanes };
    }
    return { run, syntheticNeeds: needs, effects };
  }
  const streak = run.planner.invalidEpochStreak + 1;
  const fb = run.config.plannerFallbackModel;
  const canFb = Boolean(fb) && !run.planner.usedFallback && run.planner.activeModel !== fb;
  const trip = streak >= cfg.plannerInvalidEpochLimit;
  const base = { ...run.planner, lastEpoch: epoch, lastError: error };
  if (trip && canFb && fb) {
    const planner = { ...base, invalidEpochStreak: 0, activeModel: fb, usedFallback: true };
    run = { ...run, planner };
    const delta = { type: "planner.fallback_activated", epoch, activeModel: fb, error };
    effects.push(runLive(run, "planner", delta));
  } else if (trip) {
    run = { ...run, planner: { ...base, invalidEpochStreak: streak, paused: true } };
    const m = run.planner.activeModel ? ` on ${run.planner.activeModel}` : "";
    const summary = `Planning paused after ${streak} invalid epochs${m}${error ? `: ${error}` : ""}`;
    addNeed(ctx, needs, { runId, kind: "planner_failed", scope: {}, summary });
  } else {
    run = { ...run, planner: { ...base, invalidEpochStreak: streak } };
  }
  return { run, syntheticNeeds: needs, effects };
}

export function detectResearchOscillation(hist: readonly T.ResearchRoundEntry[], win: number) {
  const n = Math.max(3, win);
  if (hist.length < n) return null;
  const tail = hist.slice(-n);
  const rk = (c: T.Certainty) => CERTAINTY_RANK[c];
  if (tail.every((e, i) => i === 0 || rk(e.certainty) > rk(tail[i - 1]?.certainty ?? "verified")))
    return null;
  const seen = new Set<T.ResearchDecision>();
  let prev: T.ResearchDecision | undefined;
  for (const e of tail) {
    if (prev !== undefined && e.decision !== prev && seen.has(e.decision))
      return tail.map((x) => `${x.decision}(${x.certainty})`).join(" -> ");
    seen.add(e.decision);
    prev = e.decision;
  }
  return null;
}

export function evaluateResearchRound(ctx: BreakerCtx, r0: S.RunState, ev: ResEv): BreakerOut {
  let run = r0;
  const { runId } = run;
  const { hypothesisId: hid, decision, certainty, summary } = ev;
  const prev = run.hypotheses[hid];
  const history = [...(prev?.history ?? []), { decision, certainty, summary, recordedAt: ctx.now }];
  const slice = prev?.resumedAtRound ? history.slice(prev.resumedAtRound) : history;
  const win = S.resolveBreakerConfig(run.config).oscillationRounds;
  const trace = detectResearchOscillation(slice, win);
  const stalled = trace !== null || prev?.status === "stalled";
  const status: S.HypothesisStatus = stalled ? "stalled" : (prev?.status ?? "active");
  const rAt = prev?.resumedAtRound;
  const hyp: S.HypothesisState = { hypothesisId: hid, status, resumedAtRound: rAt, history };
  const needs: SyntheticNeed[] = [];
  const effects: Effect[] = [];
  if (trace !== null) {
    const msg = `Hypothesis ${hid} stalled due to oscillation: ${trace}`;
    const scope = { hypothesisId: hid };
    addNeed(ctx, needs, { runId, kind: "research_oscillation", scope, summary: msg });
  } else if (!stalled) {
    const reason = "research_round_recorded";
    run = pushAdvisor(run, { role: "reviewer", reason, now: ctx.now, tid: hid }, effects);
  }
  const nextRun = { ...run, hypotheses: S.put(run.hypotheses, hid, hyp) };
  return { run: nextRun, syntheticNeeds: needs, effects };
}

export function evaluateAuditFinding(ctx: BreakerCtx, r0: S.RunState, ev: AdvEv) {
  let run = r0;
  const { targetId: tid, finding: f } = ev;
  if (tid && run.pendingAudits[tid]) {
    const { [tid]: _drop, ...pendingAudits } = run.pendingAudits;
    run = { ...run, pendingAudits };
  }
  if (!tid || !f || (f.kind !== "defect" && f.kind !== "gaming")) return { run };
  const a = ctx.state.attempts[tid];
  if (!a || a.runId !== run.runId) return { run };
  const summary = `Auditor flagged ${f.kind} on attempt ${tid}: ${f.summary}`;
  const { runId } = run;
  const meta = { runId, kind: "audit_hold" as const, scope: { attemptId: tid }, summary };
  const syn = createSyntheticNeed(meta, ctx.nextSeq(), ctx.now);
  const attempt: S.AttemptState = { ...a, status: "held", pendingNeedId: syn.need.needId };
  return { run, attempt, syntheticNeed: syn };
}

export function evaluateAuditTimeouts(state: S.ControlState, now: number) {
  let { seq, runs, attempts, needs } = state;
  const live: Effect[] = [];
  const stored: StoredEvent[] = [];
  const pubs: Effect[] = [];
  let changed = false;
  for (const run of Object.values(state.runs)) {
    const expired = Object.values(run.pendingAudits).filter((a) => now >= a.deadlineAt);
    if (!expired.length) continue;
    changed = true;
    const { runId } = run;
    const action = S.resolveBreakerConfig(run.config).onAuditTimeout;
    const rem = { ...run.pendingAudits };
    for (const audit of expired) {
      const attemptId = audit.targetId;
      delete rem[attemptId];
      if (action === "proceed") {
        live.push(runLive(run, "audit", { type: "audit.timeout", attemptId, action }));
        continue;
      }
      seq += 1;
      const summary = `Audit timed out for attempt ${attemptId}; owner decision required`;
      const meta = { runId, kind: "audit_timeout" as const, scope: { attemptId }, summary };
      const syn = createSyntheticNeed(meta, seq, now);
      const { needId } = syn.need;
      needs = S.put(needs, needId, syn.need);
      const st: StoredEvent = { seq: syn.seq, at: now, event: syn.event };
      stored.push(st);
      pubs.push(buildEventPublishEffect(st, runId));
      const a = attempts[attemptId];
      if (a && a.runId === runId)
        attempts = S.put(attempts, attemptId, { ...a, status: "held", pendingNeedId: needId });
      live.push(runLive(run, "need", { type: "audit.timeout", attemptId, action, needId }));
    }
    runs = S.put(runs, runId, { ...run, pendingAudits: rem });
  }
  if (!changed) return { state, effects: [] as readonly Effect[] };
  const next: S.ControlState = { ...state, seq, runs, attempts, needs };
  const projections = S.diffProjections(state, next);
  const pg: Effect = { kind: "persist_pg", events: stored, projections };
  return { state: next, effects: [...(stored.length ? [pg, ...pubs] : []), ...live] };
}
