import type { AttemptView, JudgeJob, RigView, StoredEvent } from "../../views/index.ts";
import { findAttempt } from "./shared.ts";

export interface Sentence {
  text: string;
  tone: "" | "ok" | "warn" | "bad";
  /** An attempt the sentence is about (the page links it). */
  attempt?: string | undefined;
  run?: string | undefined;
}

/**
 * What each group's sentences take from their event and its rig: the event's body, and the words
 * for who did it, an experiment, an attempt and a judge job.
 */
export interface SentenceContext {
  b: Record<string, unknown>;
  who: (by: string) => string;
  title: (run: unknown, id: unknown) => string;
  att: (id: unknown) => AttemptView | undefined;
  job: (id: unknown) => JudgeJob | undefined;
  s: (text: string, tone?: Sentence["tone"], extra?: Partial<Sentence>) => Sentence;
}

/** The context of one event's sentence. */
export function sentenceContext(u: RigView, e: StoredEvent): SentenceContext {
  const b = e.body ?? {};
  /** Who did it, in words. */
  const who = (by: string) =>
    by === "owner" || by.startsWith("control:owner")
      ? "You"
      : by === "planner" || by.startsWith("planner:")
        ? "The planner"
        : /teacher|merged/.test(by) || by === "supervisor"
          ? "The teachers"
          : /auditor/.test(by)
            ? "The auditor"
            : by.startsWith("control:")
              ? by.slice("control:".length)
              : by;
  /** An experiment's title, from the run's queue. */
  const title = (run: unknown, id: unknown) =>
    u.runs.find((r) => r.id === String(run))?.queue.find((x) => x.id === String(id))?.title ??
    String(id ?? "");
  const att = (id: unknown) => findAttempt(u, String(id ?? ""));
  const job = (id: unknown) => u.judge.jobs.find((j) => j.id === String(id ?? ""));
  const s = (text: string, tone: Sentence["tone"] = "", extra: Partial<Sentence> = {}) => ({
    text,
    tone,
    ...extra,
  });
  return { b, who, title, att, job, s };
}
