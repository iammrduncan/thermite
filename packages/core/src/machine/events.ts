import type { ActorRef } from "../policy/index.ts";
import type * as T from "./types.ts";

export const DOMAIN_EVENT_TYPES = [
  "run.created",
  "run.status_changed",
  "run.config_updated",
  "machine.enrolled",
  "machine.heartbeat",
  "machine.wall_checked",
  "machine.status_changed",
  "job.dispatched",
  "job.finished",
  "attempt.submitted",
  "attempt.judged",
  "attempt.rejudge_requested",
  "attempt.promoted",
  "attempt.invalidated",
  "planner.epoch_completed",
  "research.round_recorded",
  "advisor.completed",
  "need.opened",
  "need.resolved",
  "git.sync_finished",
  "clock.tick",
] as const;

export type DomainEventType = (typeof DOMAIN_EVENT_TYPES)[number];
export const EPHEMERAL_EVENT_TYPES = ["machine.heartbeat", "clock.tick"] as const;
export type EphemeralEventType = (typeof EPHEMERAL_EVENT_TYPES)[number];

type R<X> = Readonly<X>;
type REv<K, P> = R<{ type: K; runId: string } & P>;
type MEv<K, P> = R<{ type: K; machineId: string } & P>;
type AEv<K, P> = R<{ type: K; runId: string; attemptId: string } & P>;
type JF1 = { jobId: string; runId?: string; outcome: T.JobOutcome; errorHash?: string };
type JF2 = { metrics?: T.MetricSamples; artifactsDigest?: string };
type NeedOp = { needId: string; kind: T.NeedKind; scope: T.NeedScope; summary: string };
type NeedRes = { type: "need.resolved"; needId: string; runId?: string };
type NeedRes2 = { resolution: T.NeedResolution; note?: string; actor: ActorRef };
type Adv = { role: T.AdvisorRole; targetId?: string; finding?: T.AuditFinding };
type Plan = { epoch: number; valid: boolean; assignments?: readonly T.LaneTask[]; error?: string };
type AttSub = { laneId: string; parentId?: string; commitRef: string; summary: string };
type ResRound = { hypothesisId: string } & Omit<T.ResearchRoundEntry, "recordedAt">;
type Devs = readonly T.DeviceInfo[];
type Tels = readonly T.DeviceTelemetry[];

export type DomainEvent =
  | REv<"run.created", { campaignId: string; mode: T.RunMode; config: T.RunConfig }>
  | REv<"run.status_changed", { status: T.RunStatus; reason: string; actor: ActorRef }>
  | REv<"run.config_updated", { patch: Partial<T.RunConfig>; actor: ActorRef }>
  | MEv<"machine.enrolled", { devices: Devs; wallPlugin: string; wallVersion: string }>
  | MEv<"machine.heartbeat", { devices: Tels; activeJobs: readonly string[] }>
  | MEv<"machine.wall_checked", { passed: boolean; proofDigest: string; detail?: string }>
  | MEv<"machine.status_changed", { status: T.MachineStatus }>
  | R<{ type: "job.dispatched"; machineId: string } & Omit<T.JobSpec, "commitRef" | "reason">>
  | MEv<"job.finished", JF1 & JF2>
  | AEv<"attempt.submitted", AttSub>
  | AEv<"attempt.judged", Omit<T.JudgedVerdictRecord, "judgedAt">>
  | AEv<"attempt.rejudge_requested", { reason: string; actor: ActorRef }>
  | AEv<"attempt.promoted", { commitRef: string; metricDelta: number; actor: ActorRef }>
  | AEv<"attempt.invalidated", { reason: string; actor: ActorRef }>
  | REv<"planner.epoch_completed", Plan>
  | REv<"research.round_recorded", ResRound>
  | REv<"advisor.completed", Adv & { directives?: readonly T.ScopedDirective[] }>
  | REv<"need.opened", NeedOp & { deadlineAt?: number }>
  | R<NeedRes & NeedRes2>
  | REv<"git.sync_finished", Omit<T.GitSyncStatus, "syncedAt">>
  | R<{ type: "clock.tick"; now: number }>;

export type EphemeralDomainEvent = Extract<DomainEvent, { readonly type: EphemeralEventType }>;
export type PersistedDomainEvent = Exclude<DomainEvent, EphemeralDomainEvent>;
export type StoredEvent = R<{ seq: number; at: number; event: PersistedDomainEvent }>;

export const isEphemeralEvent = (ev: DomainEvent): ev is EphemeralDomainEvent =>
  ev.type === "machine.heartbeat" || ev.type === "clock.tick";
export const isPersistedEvent = (ev: DomainEvent): ev is PersistedDomainEvent =>
  !isEphemeralEvent(ev);
