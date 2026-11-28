import type { DomainEvent } from "../machine/events.ts";

export const SUBJECT_PREFIX = "t" as const;
export const THERMITE_HEADERS = {
  attempt: "Thermite-Attempt",
  job: "Thermite-Job",
  need: "Thermite-Need",
} as const;

export type ThermiteHeaderName = (typeof THERMITE_HEADERS)[keyof typeof THERMITE_HEADERS];
export type JobMsgPhase = "dispatch" | "result";

const BAD_TOKEN_RE = /[\s.*>/$\p{Cc}]/u;

export function assertSubjectToken(value: string, label: string): string {
  if (typeof value !== "string" || value.length === 0 || BAD_TOKEN_RE.test(value)) {
    throw new Error(`Invalid NATS subject token for ${label}: ${JSON.stringify(value)}`);
  }
  return value;
}

const t = assertSubjectToken;
const r = (id: string) => t(id, "runId");
const m = (id: string) => t(id, "machineId");

export const runEventSubject = (id: string, kind: string) => `t.run.${r(id)}.ev.${t(kind, "kind")}`;
export const runAttemptSubject = (id: string, st: string) =>
  `t.run.${r(id)}.attempt.${t(st, "stage")}`;
export const runNeedSubject = (id: string, st: string) => `t.run.${r(id)}.need.${t(st, "state")}`;
export const machineEventSubject = (id: string, k: string) =>
  `t.machine.${m(id)}.ev.${t(k, "kind")}`;
export const jobDispatchSubject = (id: string) => `t.machine.${m(id)}.job.dispatch`;
export const jobResultSubject = (id: string) => `t.machine.${m(id)}.job.result`;
export const runLiveSubject = (id: string, src: string) =>
  `t.run.${r(id)}.live.${t(src, "source")}`;
export const jobLiveSubject = (mid: string, jid: string) =>
  `t.machine.${m(mid)}.job.${t(jid, "jobId")}.live`;
export const needLiveSubject = (id: string) => `t.need.${t(id, "needId")}.live`;
export const publicLiveSubject = (id: string, ch: string) => `t.live.${r(id)}.${t(ch, "channel")}`;
export const machineHeartbeatSubject = (id: string) => `t.machine.${m(id)}.hb`;
export const machineCancelSubject = (id: string) => `t.machine.${m(id)}.cancel`;
export const jobMsgId = (mid: string, jid: string, phase: JobMsgPhase) =>
  `${m(mid)}:${t(jid, "jobId")}:${phase}`;

export function eventToSubject(event: DomainEvent, runId?: string): string | null {
  if (event.type === "machine.heartbeat" || event.type === "clock.tick") return null;
  if (event.type === "need.opened") return runNeedSubject(event.runId, "opened");
  if (event.type === "need.resolved") {
    return runNeedSubject(runId ?? event.runId ?? "global", "resolved");
  }
  if (event.type === "job.finished") {
    const target = runId ?? event.runId;
    return target
      ? runEventSubject(target, "job_finished")
      : machineEventSubject(event.machineId, "job_finished");
  }
  if ("runId" in event) {
    return event.type.startsWith("attempt.")
      ? runAttemptSubject(event.runId, event.type.slice(8))
      : runEventSubject(event.runId, event.type.replaceAll(".", "_"));
  }
  return machineEventSubject(event.machineId, event.type.replaceAll(".", "_"));
}

export function eventHeaders(event: DomainEvent): Record<string, string> {
  const headers: Record<string, string> = {};
  if ("jobId" in event) headers[THERMITE_HEADERS.job] = event.jobId;
  if ("attemptId" in event && event.attemptId) headers[THERMITE_HEADERS.attempt] = event.attemptId;
  if ("needId" in event) headers[THERMITE_HEADERS.need] = event.needId;
  if (event.type === "need.opened" && event.scope.attemptId) {
    headers[THERMITE_HEADERS.attempt] = event.scope.attemptId;
  }
  return headers;
}
