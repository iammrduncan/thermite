import * as B from "./breakers.ts";
import { buildEventPublishEffect, type Effect, liveEffect, type ReduceResult } from "./effects.ts";
import type { DomainEvent, PersistedDomainEvent, StoredEvent } from "./events.ts";
import * as S from "./state.ts";
import type * as T from "./types.ts";
import { DEFAULT_HEARTBEAT_TIMEOUT_MS } from "./types.ts";

export type ReplayEntry = Readonly<{ event: DomainEvent; now: number }>;
const noop = (state: S.ControlState): ReduceResult => ({ state, effects: [] });

export function replay(initial: S.ControlState, events: readonly ReplayEntry[]): S.ControlState {
  let cur = initial;
  for (const e of events) cur = reduce(cur, e.event, e.now).state;
  return cur;
}

export function reduce(state: S.ControlState, event: DomainEvent, now: number): ReduceResult {
  if (event.type === "machine.heartbeat") return reduceHeartbeat(state, event, now);
  if (event.type === "clock.tick") return reduceClockTick(state, event);
  return reducePersisted(state, event, now);
}

type HbEv = Extract<DomainEvent, { readonly type: "machine.heartbeat" }>;
function reduceHeartbeat(s: S.ControlState, ev: HbEv, now: number): ReduceResult {
  const m = s.machines[ev.machineId];
  if (!m) return noop(s);
  const status = m.status === "offline" ? "online" : m.status;
  const { devices: telemetry, activeJobs } = ev;
  const upd = { ...m, status, telemetry, activeJobs, lastHeartbeatAt: now };
  const next = { ...S.mergeState(s, { m: upd }), lastNow: Math.max(s.lastNow, now) };
  return { state: next, effects: [liveEffect(`machine.${m.machineId}`, { ...ev, status })] };
}

type TickEv = Extract<DomainEvent, { readonly type: "clock.tick" }>;
function reduceClockTick(s: S.ControlState, ev: TickEv): ReduceResult {
  const t = ev.now;
  let { jobs, machines, runs } = s;
  const effects: Effect[] = [];
  for (const j of Object.values(s.jobs)) {
    if (j.status !== "running" || j.cancelEmittedAt !== undefined || t < j.deadlineAt) continue;
    jobs = S.put(jobs, j.jobId, { ...j, status: "cancelling", cancelEmittedAt: t });
    const d = { type: "job.timeout", jobId: j.jobId, machineId: j.machineId };
    effects.push({ kind: "cancel_job", machineId: j.machineId, jobId: j.jobId, reason: "timeout" });
    effects.push(liveEffect(`run.${j.runId}.job`, d, j.runId, S.isPublicLiveRun(s.runs[j.runId])));
  }
  for (const m of Object.values(s.machines)) {
    const lastSeen = m.lastHeartbeatAt ?? m.enrolledAt;
    if (m.status !== "online" || t - lastSeen <= DEFAULT_HEARTBEAT_TIMEOUT_MS) continue;
    machines = S.put(machines, m.machineId, { ...m, status: "offline" });
    const d = { type: "machine.heartbeat_stale", machineId: m.machineId, lastSeen };
    effects.push(liveEffect(`machine.${m.machineId}`, d));
  }
  for (const r of Object.values(s.runs)) {
    const active = r.activeDirectives.filter((d) => !d.expiresAt || d.expiresAt > t);
    if (active.length !== r.activeDirectives.length)
      runs = S.put(runs, r.runId, { ...r, activeDirectives: active });
  }
  const base = { ...s, lastNow: Math.max(s.lastNow, t), jobs, machines, runs };
  const aud = B.evaluateAuditTimeouts(base, t);
  return { state: aud.state, effects: [...effects, ...aud.effects] };
}

function applyMachineUpdate(ctx: B.BreakerCtx, m: S.MachineState) {
  let cur = S.mergeState(ctx.state, { m });
  const effects: Effect[] = [];
  if (!S.isMachineEligible(m)) return { state: cur, effects };
  for (const run of Object.values(cur.runs)) {
    if (run.status !== "running" || !run.pendingRejudges.length) continue;
    for (const aid of run.pendingRejudges) {
      const a = cur.attempts[aid];
      const r = cur.runs[run.runId];
      if (!a || !r) continue;
      const inRej = { run: r, a, reason: "pending_rejudge_drained" };
      const res = B.scheduleRejudgeJob({ ...ctx, state: cur }, inRej);
      if (!res.job || !res.machine || !res.effect) break;
      cur = S.mergeState(cur, { r: res.run, m: res.machine, j: res.job });
      effects.push(res.effect);
    }
  }
  return { state: cur, effects };
}

function resolveNeedRun(run: S.RunState, prev: S.NeedState): S.RunState | undefined {
  const { kind, scope } = prev;
  if (kind === "infra_paused") {
    const l = scope.laneId ? run.lanes[scope.laneId] : undefined;
    const upd: S.LaneState | undefined = l && { ...l, pauseReason: undefined, status: "active" };
    const lanes = upd ? S.put(run.lanes, upd.laneId, upd) : run.lanes;
    return { ...run, status: "running", advisorsPaused: false, infraCrashStreak: 0, lanes };
  }
  if (kind === "build_loop" && scope.laneId) {
    const l = run.lanes[scope.laneId];
    if (!l) return undefined;
    const b = { ...l, pauseReason: undefined, lastInvalidHash: undefined };
    const res: S.LaneState = { ...b, status: "active", identicalInvalidStreak: 0 };
    return { ...run, lanes: S.put(run.lanes, l.laneId, res) };
  }
  if (kind === "planner_failed")
    return { ...run, planner: { ...run.planner, paused: false, invalidEpochStreak: 0 } };
  if (kind === "research_oscillation" && scope.hypothesisId) {
    const h = run.hypotheses[scope.hypothesisId];
    if (!h) return undefined;
    const res: S.HypothesisState = { ...h, status: "active", resumedAtRound: h.history.length };
    return { ...run, hypotheses: S.put(run.hypotheses, h.hypothesisId, res) };
  }
  return undefined;
}

type FO1 = { p?: S.StatePatch; draft?: S.ControlState; rid?: string };
type FinOpts = FO1 & { extra?: readonly Effect[]; syn?: readonly B.SyntheticNeed[] };

function reducePersisted(s: S.ControlState, e: PersistedDomainEvent, now: number): ReduceResult {
  const pSeq = s.seq + 1;
  let seq = pSeq;
  const ctx: B.BreakerCtx = { state: s, now, nextSeq: () => (seq += 1) };
  const eRid = "runId" in e ? e.runId : undefined;
  const run = eRid ? s.runs[eRid] : undefined;
  const fin = (tag: string, o: FinOpts = {}): ReduceResult => {
    const rid = o.rid ?? eRid;
    const base = o.draft ?? (o.p ? S.mergeState(s, o.p) : s);
    let needs = base.needs;
    const primary: StoredEvent = { seq: pSeq, at: now, event: e };
    const stored: StoredEvent[] = [primary];
    const pubs: Effect[] = [buildEventPublishEffect(primary, rid)];
    for (const item of o.syn ?? []) {
      needs = S.put(needs, item.need.needId, item.need);
      const sn: StoredEvent = { seq: item.seq, at: now, event: item.event };
      stored.push(sn);
      pubs.push(buildEventPublishEffect(sn, item.need.runId));
    }
    const next: S.ControlState = { ...base, seq, lastNow: Math.max(base.lastNow, now), needs };
    const projections = S.diffProjections(s, next);
    const pub = S.isPublicLiveRun(rid ? next.runs[rid] : undefined);
    const scope = rid ? `run.${rid}.${tag}` : `machine.${tag}`;
    const pg: Effect = { kind: "persist_pg", events: stored, projections };
    const extra = o.extra ?? [];
    return { state: next, effects: [pg, ...pubs, ...extra, liveEffect(scope, e, rid, pub)] };
  };
  const finM = (m: S.MachineState) => {
    const res = applyMachineUpdate(ctx, m);
    return fin(m.machineId, { draft: res.state, extra: res.effects });
  };
  const finB = (res: B.BreakerOut, tag: string) =>
    fin(tag, { p: { r: res.run }, extra: res.effects, syn: res.syntheticNeeds });

  switch (e.type) {
    case "run.created": {
      const { runId, campaignId, mode } = e;
      const p = { lastEpoch: 0, invalidEpochStreak: 0, paused: false, usedFallback: false };
      const planner: S.PlannerState = { ...p, activeModel: e.config.plannerModel };
      const a = { runId, campaignId, mode, status: "running" as const };
      const b = { config: { ...e.config, mode }, infraCrashStreak: 0, advisorsPaused: false };
      const c = { advisorLastAt: {}, activeDirectives: [], pendingAudits: {} };
      const d = { pendingRejudges: [], planner, lanes: {}, hypotheses: {} };
      return fin("status", { p: { r: { ...a, ...b, ...c, ...d } } });
    }
    case "run.status_changed": {
      if (!run) return noop(s);
      const rst = e.status === "running" ? { advisorsPaused: false, infraCrashStreak: 0 } : {};
      let draft = S.mergeState(s, { r: { ...run, ...rst, status: e.status } });
      const extra: Effect[] = [];
      if (e.status === "closed" || e.status === "completed") {
        const reason = `run_${e.status}`;
        for (const j of Object.values(s.jobs)) {
          if (j.runId !== e.runId || j.status !== "running") continue;
          draft = S.mergeState(draft, { j: { ...j, status: "cancelling", cancelEmittedAt: now } });
          extra.push({ kind: "cancel_job", machineId: j.machineId, jobId: j.jobId, reason });
        }
      }
      return fin("status", { draft, extra });
    }
    case "run.config_updated": {
      if (!run) return noop(s);
      const { patch } = e;
      const gp = patch.gitPolicy;
      const gitPolicy = gp ? { ...run.config.gitPolicy, ...gp } : run.config.gitPolicy;
      const config = { ...run.config, ...patch, gitPolicy };
      const updM = patch.plannerModel !== undefined && !run.planner.usedFallback;
      const planner = updM ? { ...run.planner, activeModel: patch.plannerModel } : run.planner;
      return fin("config", { p: { r: { ...run, mode: config.mode, config, planner } } });
    }
    case "machine.enrolled": {
      const { machineId, wallPlugin, wallVersion, devices } = e;
      const m1 = { machineId, status: "online" as const, degraded: false, wallPlugin, wallVersion };
      const m2 = { wallPassed: false, devices, telemetry: [], activeJobs: [], infraCrashStreak: 0 };
      return fin(machineId, { p: { m: { ...m1, ...m2, enrolledAt: now } } });
    }
    case "machine.wall_checked": {
      const m = s.machines[e.machineId];
      return m ? finM({ ...m, wallPassed: e.passed, wallProofDigest: e.proofDigest }) : noop(s);
    }
    case "machine.status_changed": {
      const m = s.machines[e.machineId];
      if (!m) return noop(s);
      const rst = e.status === "online" ? { degraded: false, infraCrashStreak: 0 } : {};
      return finM({ ...m, ...rst, status: e.status });
    }
    case "job.dispatched": {
      const m = s.machines[e.machineId];
      if (!run || !S.isMachineEligible(m) || s.jobs[e.jobId]) return noop(s);
      const a = e.attemptId ? s.attempts[e.attemptId] : undefined;
      const { jobId, runId, attemptId, machineId, deviceIds, kind, deadlineAt, rejudgeOf } = e;
      const s1 = { jobId, runId, attemptId, laneId: e.laneId ?? a?.laneId, deviceIds, kind };
      const spec = { ...s1, deadlineAt, rejudgeOf };
      const activeJobs = m.activeJobs.includes(jobId) ? m.activeJobs : [...m.activeJobs, jobId];
      const p = { m: { ...m, activeJobs }, j: { ...spec, machineId, status: "running" as const } };
      const extra: Effect[] = [
        { kind: "dispatch_job", machineId, job: { ...spec, commitRef: a?.commitRef } },
      ];
      return fin("job", { p, extra });
    }
    case "job.finished": {
      const j = s.jobs[e.jobId];
      if (!j || j.status === "finished" || j.machineId !== e.machineId) return noop(s);
      const jr = s.runs[j.runId];
      const m = s.machines[j.machineId];
      if (!jr || !m) return noop(s);
      const { outcome, errorHash, metrics, artifactsDigest } = e;
      const f1 = { ...j, status: "finished" as const, outcome, errorHash };
      const done: S.JobState = { ...f1, metrics, artifactsDigest };
      const cleaned = { ...m, activeJobs: m.activeJobs.filter((id) => id !== e.jobId) };
      const b = B.evaluateJobOutcomeBreakers(ctx, { run: jr, m: cleaned, job: done, ev: e });
      const p = { r: b.run, m: b.machine, j: done };
      return fin("job", { p, rid: jr.runId, extra: b.effects, syn: b.syntheticNeeds });
    }
    case "attempt.submitted": {
      if (!run) return noop(s);
      const { runId, laneId, attemptId, parentId, commitRef, summary } = e;
      const base = { attemptId, runId, laneId, parentId, commitRef, summary };
      const a: S.AttemptState = { ...base, status: "submitted", verdicts: [], rejudges: [] };
      const lane = { ...S.ensureLane(run, laneId), lastAttemptId: attemptId };
      return fin("attempt", { p: { r: { ...run, lanes: S.put(run.lanes, laneId, lane) }, a } });
    }
    case "attempt.judged": {
      if (!run) return noop(s);
      const tid = e.rejudgeOf && s.attempts[e.rejudgeOf] ? e.rejudgeOf : e.attemptId;
      const target = s.attempts[tid];
      if (!target || target.runId !== e.runId) return noop(s);
      const { verdict, judgePlugin, judgeVersion, rejudgeOf } = e;
      const rec = { verdict, judgePlugin, judgeVersion, judgedAt: now, rejudgeOf };
      const a = B.applyJudgedVerdict(target, rec, rejudgeOf !== undefined);
      let r: S.RunState = { ...run, pendingRejudges: run.pendingRejudges.filter((x) => x !== tid) };
      const o = verdict.outcome;
      const cand = o === "improve" || (run.mode === "goal" && o === "pass");
      const role = cand ? "auditor" : o === "regress" ? "strategist" : null;
      const reason = cand ? "candidate_audit" : "attempt_regressed";
      const extra: Effect[] = [];
      if (role) r = B.pushAdvisor(r, { role, reason, now, tid }, extra);
      return fin("attempt", { p: { r, a }, extra });
    }
    case "attempt.rejudge_requested": {
      const a = s.attempts[e.attemptId];
      if (!run || !a || a.runId !== e.runId || !a.commitRef) return noop(s);
      const res = B.scheduleRejudgeJob(ctx, { run, a, reason: e.reason, seq: pSeq });
      const p = { r: res.run, m: res.machine, j: res.job };
      return fin("attempt", { p, extra: res.effect ? [res.effect] : [] });
    }
    case "attempt.promoted": {
      const a = s.attempts[e.attemptId];
      const bad = !a || a.runId !== e.runId || a.status === "held" || a.pendingNeedId !== undefined;
      if (!run || bad || a.status === "invalidated" || a.status === "declined") return noop(s);
      const { [e.attemptId]: _drop, ...pendingAudits } = run.pendingAudits;
      const { runId, attemptId, commitRef, metricDelta } = e;
      let r: S.RunState = { ...run, championAttemptId: attemptId, pendingAudits };
      const policy = r.config.gitPolicy;
      const extra: Effect[] = [];
      if (policy.onChampion !== "none")
        extra.push({ kind: "sync_git", runId, attemptId, commitRef, policy });
      const req = { role: "strategist" as const, reason: "attempt_promoted", now, tid: attemptId };
      r = B.pushAdvisor(r, req, extra);
      return fin("champion", { p: { r, a: { ...a, status: "promoted", metricDelta } }, extra });
    }
    case "attempt.invalidated": {
      const a = s.attempts[e.attemptId];
      if (!run || !a || a.runId !== e.runId) return noop(s);
      const champ = run.championAttemptId === e.attemptId ? undefined : run.championAttemptId;
      const inv: S.AttemptState = { ...a, pendingNeedId: undefined, status: "invalidated" };
      return fin("attempt", { p: { r: { ...run, championAttemptId: champ }, a: inv } });
    }
    case "planner.epoch_completed":
      return run ? finB(B.evaluatePlannerEpoch(ctx, run, e), "planner") : noop(s);
    case "research.round_recorded":
      return run ? finB(B.evaluateResearchRound(ctx, run, e), "research") : noop(s);
    case "advisor.completed": {
      if (!run) return noop(s);
      const cur = run.activeDirectives;
      const dirs = e.directives?.length ? S.mergeDirectives(cur, e.directives, e.role, now) : cur;
      const withDir = dirs !== cur ? { ...run, activeDirectives: dirs } : run;
      const aud = B.evaluateAuditFinding(ctx, withDir, e);
      const syn = aud.syntheticNeed ? [aud.syntheticNeed] : [];
      return fin("advisor", { p: { r: aud.run, a: aud.attempt }, syn });
    }
    case "need.opened": {
      if (!run) return noop(s);
      const { needId, runId, kind, scope, summary, deadlineAt } = e;
      const base = { needId, runId, kind, scope, summary, deadlineAt };
      const aid = scope.attemptId;
      const hold = kind === "audit_hold" || kind === "audit_timeout" || kind === "approval";
      const t = aid && hold ? s.attempts[aid] : undefined;
      const a =
        t && t.runId === runId
          ? { ...t, status: "held" as const, pendingNeedId: needId }
          : undefined;
      let r: S.RunState | undefined;
      if (kind === "audit_timeout" && aid && run.pendingAudits[aid]) {
        const { [aid]: _drop, ...pendingAudits } = run.pendingAudits;
        r = { ...run, pendingAudits };
      }
      return fin("need", { p: { n: { ...base, status: "open", openedAt: now }, a, r } });
    }
    case "need.resolved": {
      const prev = s.needs[e.needId];
      if (!prev || prev.status === "resolved") return noop(s);
      const { resolution, actor } = e;
      const rel = resolution === "approve" || resolution === "override" || resolution === "resume";
      const att = prev.scope.attemptId ? s.attempts[prev.scope.attemptId] : undefined;
      const nr = s.runs[prev.runId];
      const n1 = { ...prev, status: "resolved" as const, resolution };
      const n: S.NeedState = { ...n1, resolvedBy: actor, resolvedAt: now };
      const st: S.AttemptStatus = rel ? "judged" : "declined";
      const a =
        att && att.pendingNeedId === prev.needId
          ? { ...att, pendingNeedId: undefined, status: st }
          : undefined;
      const r = nr && rel ? resolveNeedRun(nr, prev) : undefined;
      return fin("need", { p: { n, a, r }, rid: prev.runId });
    }
    case "git.sync_finished": {
      if (!run) return noop(s);
      const { attemptId, ok, ref, prUrl, error } = e;
      const gitSync: T.GitSyncStatus = { attemptId, ok, ref, prUrl, error, syncedAt: now };
      const att = s.attempts[attemptId];
      const a = att && att.runId === e.runId ? { ...att, gitSync } : undefined;
      return fin("git", { p: { r: { ...run, lastGitSync: gitSync }, a } });
    }
  }
}
