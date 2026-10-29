import type { Bus, BusMessage } from "../../common/bus/index.ts";
import { log } from "../../common/env.ts";
import {
  LIVE_CONSUMER_CONFIG,
  LIVE_RIG_HEADER,
  LIVE_STREAM_CONFIG,
  type LiveSubject,
  readLiveMessage,
  readLiveSubject,
} from "../../core/link/live.ts";
import type { LiveEntry } from "../../core/live.ts";
import type { ControlStore } from "../store/index.ts";
import { type HarnessRefusal, harnessRefusal, type LiveBatchRead } from "./take.ts";

/**
 * Control's live view from the message bus (goal 168, step 2): each message of the LIVE stream,
 * the lines of one run's source, checked as a batch posted to `POST /v1/rigs/<rig>/live` is and
 * folded into the same live view, which the dashboard's Live pages read. A message control
 * refuses is counted and logged, and passed over: no answer goes back to the supervisor, and the
 * live view is a view, so nothing waits for it.
 */

/** Why control refused a message: a fixed set of words, so that their counts stay few. */
export const LIVE_REFUSALS = [
  "not a live subject",
  "no rig named",
  "no such rig: control has no token for it",
  "this rig is retired in control",
  "a run control does not give this rig",
  "not a live message",
  "rig mismatch",
  "the rig's report key is not accepted yet",
  "live lines must be signed with the rig's pinned key",
  "bad live signature",
  "unsigned lines must be the supervisor's own",
] as const satisfies readonly (string | HarnessRefusal)[];
export type LiveRefusal = (typeof LIVE_REFUSALS)[number];

/** What control took from the live stream since it started: the bus's state and /metrics show it. */
export class LiveTaken {
  readonly since = new Date().toISOString();
  messages = 0;
  /** Lines added to the live view; a line it had already is not counted again. */
  lines = 0;
  /** Lines left out: of a kind or source control does not know, or of another subject. */
  leftOut = 0;
  /** Messages refused, by why. */
  readonly refused: Partial<Record<LiveRefusal, number>> = {};
  /** Lines added, by rig. */
  readonly rigs = new Map<string, number>();
}

/** What folding the live stream needs: the store, and the counts to keep. */
export interface LiveIntake {
  store: ControlStore;
  taken: LiveTaken;
}

/** What one message came to. */
export type LiveFolded = { added: number; leftOut: number } | { refused: LiveRefusal };

/** Whether a line belongs on the subject its message came on. */
function onSubject(e: LiveEntry, s: LiveSubject): boolean {
  if (e.source !== s.source) return false;
  // On a rig's subject, a line may name any of the rig's runs: the supervisor sends a run's lines
  // there while the bus refuses the run's own subject.
  return "rig" in s || e.run === s.run;
}

/**
 * One message from the live stream: the rig its subject or its header names, the run's place on
 * that rig in control's run registry, and the batch as the harness signed it, or, unsigned, the
 * supervisor's own lines. The lines kept go into the rig's live view.
 */
export function foldLive(t: LiveIntake, m: BusMessage): LiveFolded {
  const { store, taken } = t;
  const subject = readLiveSubject(m.subject);
  const rig = subject && "rig" in subject ? subject.rig : m.header(LIVE_RIG_HEADER);
  const refuse = (why: LiveRefusal): LiveFolded => {
    taken.refused[why] = (taken.refused[why] ?? 0) + 1;
    const where = { rig: rig ?? null, subject: m.subject.slice(0, 200), seq: m.seq, error: why };
    log("control", "live lines from the bus refused", where, "warn");
    return { refused: why };
  };
  if (!subject) return refuse("not a live subject");
  if (!rig) return refuse("no rig named");
  if (!store.enrollments.knownRig(rig)) return refuse("no such rig: control has no token for it");
  if (store.retired.get(rig)) return refuse("this rig is retired in control");
  if ("run" in subject && !store.runRegistry.rigsOf(subject.run).includes(rig))
    return refuse("a run control does not give this rig");
  let read: { batch: LiveBatchRead; entries: LiveEntry[]; unknown: Record<string, number> };
  try {
    read = readLiveMessage(JSON.parse(new TextDecoder().decode(m.data)));
  } catch {
    return refuse("not a live message");
  }
  const b = read.batch;
  if (b.rig !== rig) return refuse("rig mismatch");
  const signed = b.signature !== undefined;
  if (signed) {
    const refused = harnessRefusal(store, rig, b);
    if (refused) return refuse(refused[1]);
  } else if (subject.source !== "supervisor")
    return refuse("unsigned lines must be the supervisor's own");
  const lines = read.entries.filter((e) => onSubject(e, subject));
  const leftOut =
    Object.values(read.unknown).reduce((a, n) => a + n, 0) + read.entries.length - lines.length;
  const logId = signed ? b.log_id : `supervisor:${b.log_id}`;
  const added = store.liveLines.add(rig, logId, lines, signed);
  taken.messages++;
  taken.lines += added;
  taken.leftOut += leftOut;
  taken.rigs.set(rig, (taken.rigs.get(rig) ?? 0) + added);
  if (leftOut)
    log("control", "live lines left out", { rig, subject: m.subject, left_out: leftOut }, "debug");
  return { added, leftOut };
}

/**
 * Folds the live stream as it grows: makes sure the stream and control's consumer exist, then
 * takes each message in order and acks it once folded or refused. Runs until the bus is closed.
 */
export async function followLive(bus: Pick<Bus, "follow">, t: LiveIntake): Promise<void> {
  await bus.follow(LIVE_STREAM_CONFIG, LIVE_CONSUMER_CONFIG, (m) => {
    foldLive(t, m);
  });
}
