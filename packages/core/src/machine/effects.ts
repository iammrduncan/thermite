import { eventHeaders, eventToSubject } from "../bus/subjects.ts";
import type { StoredEvent } from "./events.ts";
import type { ControlState } from "./state.ts";
import type * as T from "./types.ts";

export const EFFECT_KINDS = [
  "persist_pg",
  "publish_nats",
  "dispatch_job",
  "cancel_job",
  "invoke_harness_turn",
  "trigger_advisor",
  "notify_live",
  "sync_git",
] as const;
export type EffectKind = (typeof EFFECT_KINDS)[number];

type Ef<K, P> = Readonly<{ kind: K } & P>;
type REf<K, P> = Readonly<{ kind: K; runId: string } & P>;
type Hdr = Readonly<Record<string, string>>;
type Dirs = readonly T.ScopedDirective[];
type Turn = { laneId: string; harness: string; promptCtx: T.TurnContext; directives: Dirs };
type Adv = { role: T.AdvisorRole; targetId?: string; reason: string; deadlineAt: number };

export type Effect =
  | Ef<"persist_pg", { events: readonly StoredEvent[]; projections: readonly T.ProjectionOp[] }>
  | Ef<"publish_nats", { subject: string; payload: unknown; msgId?: string; headers?: Hdr }>
  | Ef<"dispatch_job", { machineId: string; job: T.JobSpec }>
  | Ef<"cancel_job", { machineId: string; jobId: string; reason: string }>
  | REf<"invoke_harness_turn", Turn>
  | REf<"trigger_advisor", Adv>
  | Ef<"notify_live", { runId?: string; scope: string; delta: unknown; publishPublic: boolean }>
  | REf<"sync_git", { attemptId: string; commitRef: string; policy: T.GitChampionPolicy }>;

export type ReduceResult = Readonly<{ state: ControlState; effects: readonly Effect[] }>;
type LiveEf = Extract<Effect, { readonly kind: "notify_live" }>;
export function liveEffect(scope: string, delta: unknown, runId?: string, pub = false): LiveEf {
  return { kind: "notify_live", runId, scope, delta, publishPublic: pub };
}

export function buildEventPublishEffect(stored: StoredEvent, runId?: string) {
  const subject = eventToSubject(stored.event, runId) ?? "t.run.global.ev.unknown";
  const headers = eventHeaders(stored.event);
  const msgId = `ev:${stored.seq}:${stored.event.type}`;
  const base = { kind: "publish_nats" as const, subject, payload: stored, msgId };
  return Object.keys(headers).length ? { ...base, headers } : base;
}
