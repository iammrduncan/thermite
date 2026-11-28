export type RunMode = "hill_climb" | "goal" | "research";
export type RunStatus = "running" | "paused" | "completed" | "closed";
export type MachineStatus = "online" | "draining" | "offline" | "retired";
export type JobKind = "build" | "measure" | "experiment" | "self_test";
export type JobOutcome = "ok" | "invalid" | "crash_infra" | "timeout" | "cancelled";
export type ResearchDecision = "support" | "refute" | "inconclusive" | "pivot" | "continue";
export type Certainty = "low" | "medium" | "high" | "verified";
export type AdvisorRole = "auditor" | "teacher" | "strategist" | "reviewer";
export type AuditFindingKind = "clean" | "note" | "defect" | "gaming";
export type DirectiveKind = "avoid" | "focus" | "constraint";
export type NeedResolution = "approve" | "decline" | "override" | "resume" | "dismiss";
export type AuditTimeoutAction = "proceed" | "need_owner";
export type VerdictOutcome = "pass" | "fail" | "improve" | "regress" | "neutral" | "invalid";
export type GitAction = "push" | "pr" | "tag" | "none";

type PT = "runs" | "lanes" | "machines" | "jobs" | "attempts" | "hypotheses" | "needs";
export type ProjectionTable = PT;
type NK1 = "infra_paused" | "build_loop" | "planner_failed" | "research_oscillation";
type NK2 = "audit_hold" | "audit_timeout" | "approval" | "custom";
export type NeedKind = NK1 | NK2;

type RankMap = Readonly<Record<Certainty, number>>;
export const CERTAINTY_RANK: RankMap = { low: 0, medium: 1, high: 2, verified: 3 };
export const DEFAULT_HEARTBEAT_TIMEOUT_MS = 30_000;
export const DEFAULT_BREAKER_CONFIG = {
  infraCrashLimit: 3,
  identicalBuildLimit: 5,
  plannerInvalidEpochLimit: 2,
  oscillationRounds: 3,
  auditTimeoutMs: 300_000,
  onAuditTimeout: "need_owner" as AuditTimeoutAction,
  advisorCooldownMs: 60_000,
  defaultJobTimeoutMs: 600_000,
  harness: "libfx",
} as const;

type R<X> = Readonly<X>;
type Strs = readonly string[];
type Nums = Readonly<Record<string, number>>;
type Meta = Readonly<Record<string, unknown>>;
type Sev = "low" | "medium" | "high";

export type NeedScope = R<{ attemptId?: string; laneId?: string; hypothesisId?: string }>;
export type GitChampionPolicy = R<{ onChampion: GitAction; branch?: string; base?: string }>;
type Finding = { kind: AuditFindingKind; summary: string; severity?: Sev; evidence?: string };
export type AuditFinding = R<Finding>;
type Caps1 = { maxTurns?: number; maxAttempts?: number; maxDurationMs?: number };
export type RunCaps = R<Caps1 & { maxSpendUsd?: number }>;
type Metrics = { primary?: number; unit?: string; values?: readonly number[]; extra?: Nums };
export type MetricSamples = R<Metrics>;
type Verd = { outcome: VerdictOutcome; score?: number; metricDelta?: number; summary?: string };
export type Verdict = R<Verd & { metrics?: MetricSamples }>;
type Dev = { id: string; kind: string; name: string; memoryBytes?: number; capabilities?: Strs };
export type DeviceInfo = R<Dev>;
type Tel = { id: string; utilizationPct?: number; memoryUsedBytes?: number; temperatureC?: number };
export type DeviceTelemetry = R<Tel & { drained: boolean }>;
type Round = { decision: ResearchDecision; certainty: Certainty; summary: string };
export type ResearchRoundEntry = R<Round & { recordedAt: number }>;
type Sync = { attemptId: string; ok: boolean; ref?: string; prUrl?: string; error?: string };
export type GitSyncStatus = R<Sync & { syncedAt: number }>;
type Proj = { table: ProjectionTable; op: "upsert" | "delete"; id: string; runId?: string };
export type ProjectionOp = R<Proj & { data: unknown }>;
type JRec = { verdict: Verdict; judgePlugin: string; judgeVersion: string; judgedAt: number };
export type JudgedVerdictRecord = R<JRec & { rejudgeOf?: string }>;
type Task = { laneId: string; harness?: string; goal: string; parentAttemptId?: string };
export type LaneTask = R<Task & { editablePaths?: Strs; metadata?: Meta }>;
type TurnBase = { runId: string; epoch: number; mode: RunMode; model?: string };
export type TurnContext = Omit<LaneTask, "harness"> & R<TurnBase & { championAttemptId?: string }>;
type Dir1 = { id: string; kind: DirectiveKind; instruction: string; laneId?: string };
type Dir2 = { pathPattern?: string; condition?: string; sourceRole?: AdvisorRole };
export type ScopedDirective = R<Dir1 & Dir2 & { createdAt?: number; expiresAt?: number }>;
type Job1 = { jobId: string; runId: string; attemptId?: string; laneId?: string };
type Job2 = { commitRef?: string; deviceIds: Strs; kind: JobKind; deadlineAt: number };
export type JobSpec = R<Job1 & Job2 & { rejudgeOf?: string; reason?: string }>;
type Cfg1 = { mode: RunMode; live: boolean; gitPolicy: GitChampionPolicy; harness?: string };
type Cfg2 = { plannerModel?: string; plannerFallbackModel?: string; infraCrashLimit?: number };
type Cfg3 = { identicalBuildLimit?: number; plannerInvalidEpochLimit?: number };
type Cfg4 = { oscillationRounds?: number; auditTimeoutMs?: number; advisorCooldownMs?: number };
type Cfg5 = { onAuditTimeout?: AuditTimeoutAction; defaultJobTimeoutMs?: number; caps?: RunCaps };
export type RunConfig = R<Cfg1 & Cfg2 & Cfg3 & Cfg4 & Cfg5>;
