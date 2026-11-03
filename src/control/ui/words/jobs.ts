import type { JudgeJob } from "../../views/index.ts";

/** What a judge job is doing, in words. */
export function jobText(job: Pick<JudgeJob, "kind" | "attempt">, lane?: string | null): string {
  const who = job.attempt ? `${job.attempt}${lane ? ` (${lane})` : ""}` : "";
  switch (job.kind) {
    case "baseline":
      return job.attempt
        ? `measuring setup change ${who} to see whether it can be the starting point`
        : "measuring the starting point on every case (the run's baseline)";
    case "evaluate":
      return `screening ${who}: building it and measuring it against the champion`;
    case "parent_screen":
      return `measuring ${who} against the older champion it was written on, to see whether to port it onto the current one`;
    case "confirm":
      return `confirming ${who} on fresh runs`;
    case "validate":
      return "checking which goals the champion meets";
    case "calibrate":
      return "measuring the rig's own noise (the champion against itself)";
    default:
      return `${job.kind.replace(/_/g, " ")} ${who}`.trim();
  }
}

/**
 * A History sentence for a change written on an older champion (goal 135): its effect measured
 * on that champion, or its port queued onto the current one.
 */
export function portWords(kind: string, attempt: string, b: Record<string, unknown>): string {
  const cut = (x: unknown) => String(x ?? "").slice(0, 240);
  return kind === "parent_screened"
    ? `${attempt} was written on an older champion. ${cut(b.effect)}`
    : `A port of ${attempt} onto champion #${String(b.onto_seq)} is at the top of the queue: ${cut(b.why)}.`;
}
