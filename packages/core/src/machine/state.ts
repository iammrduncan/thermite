import type { ActorRef } from "../policy/index.ts";
import type * as T from "./types.ts";
import { DEFAULT_BREAKER_CONFIG } from "./types.ts";

export type LaneStatus = "active" | "paused";
export type HypothesisStatus = "active" | "stalled" | "settled";
export type JobStatus = "running" | "cancelling" | "finished";
export type NeedStatus = "open" | "resolved";
type ASt = "submitted" | "judged" | "held";
export type AttemptStatus = ASt | "promoted" | "declined" | "invalidated";

type R<X> = Readonly<X>;
type MapOf<V> = Readonly<Record<string, V>>;
type Strs = readonly string[];
type AdvAt = Readonly<Partial<Record<T.AdvisorRole, number>>>;
type JRecs = readonly T.JudgedVerdictRecord[];
type Dirs = readonly T.ScopedDirective[];
type Devs = readonly T.DeviceInfo[];
type Tels = readonly T.DeviceTelemetry[];

export type PendingAuditState = R<{ targetId: string; role: T.AdvisorRole; deadlineAt: number }>;
type Lane1 = { laneId: string; status: LaneStatus; pauseReason?: string; lastInvalidHash?: string };
export type LaneState = R<Lane1 & { identicalInvalidStreak: number; lastAttemptId?: string }>;
type Plan1 = { lastEpoch: number; invalidEpochStreak: number; paused: boolean };
type Plan2 = { activeModel?: string; usedFallback: boolean; lastError?: string };
export type PlannerState = R<Plan1 & Plan2>;
type Hyp1 = { hypothesisId: string; status: HypothesisStatus; resumedAtRound?: number };
export type HypothesisState = R<Hyp1 & { history: readonly T.ResearchRoundEntry[] }>;
type R1 = { runId: string; campaignId: string; mode: T.RunMode; status: T.RunStatus };
type R2 = { config: T.RunConfig; championAttemptId?: string; infraCrashStreak: number };
type R3 = { advisorsPaused: boolean; advisorLastAt: AdvAt; activeDirectives: Dirs };
type R4 = { pendingAudits: MapOf<PendingAuditState>; pendingRejudges: Strs; planner: PlannerState };
type R5 = { lanes: MapOf<LaneState>; hypotheses: MapOf<HypothesisState> };
export type RunState = R<R1 & R2 & R3 & R4 & R5 & { lastGitSync?: T.GitSyncStatus }>;
type M1 = { machineId: string; status: T.MachineStatus; degraded: boolean; wallPlugin: string };
type M2 = { wallVersion: string; wallPassed: boolean; wallProofDigest?: string };
type M3 = { devices: Devs; telemetry: Tels; activeJobs: Strs; infraCrashStreak: number };
export type MachineState = R<M1 & M2 & M3 & { enrolledAt: number; lastHeartbeatAt?: number }>;
type JE1 = { machineId: string; status: JobStatus; outcome?: T.JobOutcome; errorHash?: string };
type JE2 = { metrics?: T.MetricSamples; artifactsDigest?: string; cancelEmittedAt?: number };
export type JobState = Omit<T.JobSpec, "commitRef" | "reason"> & R<JE1 & JE2>;
type A1 = { attemptId: string; runId: string; laneId: string; parentId?: string };
type A2 = { commitRef: string; summary: string; status: AttemptStatus; verdict?: T.Verdict };
type A3 = { judgePlugin?: string; judgeVersion?: string; verdicts: JRecs; rejudges: JRecs };
type A4 = { pendingNeedId?: string; metricDelta?: number; gitSync?: T.GitSyncStatus };
export type AttemptState = R<A1 & A2 & A3 & A4>;
type N1 = { needId: string; runId: string; kind: T.NeedKind; scope: T.NeedScope; summary: string };
type N2 = { status: NeedStatus; openedAt: number; deadlineAt?: number; resolvedAt?: number };
export type NeedState = R<N1 & N2 & { resolution?: T.NeedResolution; resolvedBy?: ActorRef }>;
type C1 = { seq: number; lastNow: number; runs: MapOf<RunState>; machines: MapOf<MachineState> };
type C2 = { jobs: MapOf<JobState>; attempts: MapOf<AttemptState>; needs: MapOf<NeedState> };
export type ControlState = R<C1 & C2>;
type SP1 = { r?: RunState; m?: MachineState; j?: JobState };
export type StatePatch = SP1 & { a?: AttemptState; n?: NeedState };

export const put = <V>(m: MapOf<V>, k: string, v: V): MapOf<V> => ({ ...m, [k]: v });
export const mergeState = (s: ControlState, p: StatePatch): ControlState => ({
  ...s,
  runs: p.r ? put(s.runs, p.r.runId, p.r) : s.runs,
  machines: p.m ? put(s.machines, p.m.machineId, p.m) : s.machines,
  jobs: p.j ? put(s.jobs, p.j.jobId, p.j) : s.jobs,
  attempts: p.a ? put(s.attempts, p.a.attemptId, p.a) : s.attempts,
  needs: p.n ? put(s.needs, p.n.needId, p.n) : s.needs,
});
export function createInitialState(): ControlState {
  return { seq: 0, lastNow: 0, runs: {}, machines: {}, jobs: {}, attempts: {}, needs: {} };
}
export const upsertOp = (table: T.ProjectionTable, id: string, data: unknown, runId?: string) =>
  ({ table, op: "upsert", id, ...(runId !== undefined ? { runId } : {}), data }) as T.ProjectionOp;

export function diffProjections(prev: ControlState, next: ControlState): T.ProjectionOp[] {
  const ops: T.ProjectionOp[] = [];
  type Opt<V> = MapOf<V> | undefined;
  type Rid<V> = (v: V) => string;
  const diff = <V>(t: T.ProjectionTable, p: Opt<V>, n: MapOf<V>, rid?: Rid<V>, pfx = "") => {
    for (const [k, v] of Object.entries(n))
      if (v !== p?.[k]) ops.push(upsertOp(t, `${pfx}${k}`, v, rid?.(v)));
  };
  for (const [id, r] of Object.entries(next.runs)) {
    const pr = prev.runs[id];
    if (r === pr) continue;
    ops.push(upsertOp("runs", id, r, id));
    diff("lanes", pr?.lanes, r.lanes, () => id, `${id}:`);
    diff("hypotheses", pr?.hypotheses, r.hypotheses, () => id, `${id}:`);
  }
  diff("machines", prev.machines, next.machines);
  diff("jobs", prev.jobs, next.jobs, (j) => j.runId);
  diff("attempts", prev.attempts, next.attempts, (a) => a.runId);
  diff("needs", prev.needs, next.needs, (n) => n.runId);
  return ops;
}

export const resolveBreakerConfig = (c: T.RunConfig) => ({ ...DEFAULT_BREAKER_CONFIG, ...c });
export const isPublicLiveRun = (run: RunState | undefined): boolean => run?.config.live === true;
export const isMachineEligible = (m: MachineState | undefined): m is MachineState =>
  m !== undefined && m.status === "online" && m.wallPassed && !m.degraded;
const cmpM = (a: MachineState, b: MachineState) =>
  a.activeJobs.length - b.activeJobs.length || a.machineId.localeCompare(b.machineId);
export const selectEligibleMachine = (s: ControlState) =>
  Object.values(s.machines).filter(isMachineEligible).sort(cmpM)[0];
export const ensureLane = (run: RunState, laneId: string): LaneState =>
  run.lanes[laneId] ?? { laneId, status: "active", identicalInvalidStreak: 0 };
export const selectActiveDirectives = (run: RunState, laneId: string, now: number) =>
  run.activeDirectives.filter(
    (d) => (!d.expiresAt || d.expiresAt > now) && (!d.laneId || d.laneId === laneId),
  );

export function mergeDirectives(existing: Dirs, incoming: Dirs, role: T.AdvisorRole, now: number) {
  const map = new Map<string, T.ScopedDirective>();
  for (const d of existing) if (!d.expiresAt || d.expiresAt > now) map.set(d.id, d);
  for (const d of incoming) {
    if (d.expiresAt !== undefined && d.expiresAt <= now) continue;
    map.set(d.id, { ...d, sourceRole: d.sourceRole ?? role, createdAt: d.createdAt ?? now });
  }
  return Array.from(map.values());
}

const sameScope = (a: T.NeedScope, b: T.NeedScope) =>
  a.attemptId === b.attemptId && a.laneId === b.laneId && a.hypothesisId === b.hypothesisId;
export const hasOpenNeed = (s: ControlState, rid: string, k: T.NeedKind, sc: T.NeedScope) =>
  Object.values(s.needs).some(
    (n) => n.status === "open" && n.runId === rid && n.kind === k && sameScope(n.scope, sc),
  );
