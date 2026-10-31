import { z } from "zod";
import { stalledFor } from "../../agents/model/index.ts";
import { log } from "../../common/env.ts";
import type { InTurn } from "../../core/agents.ts";
import { ExperimentText } from "../../core/commands.ts";
import type { LiveKind } from "../../core/live.ts";
import { measurementIn, measurementRefusal } from "../../core/research-check.ts";
import {
  holdUntil,
  KIND_WORDS,
  type MessageInbox,
  type ProviderErrorKind,
  Registry,
  type TurnDelivery,
} from "../agents/index.ts";
import { Journal } from "../journal.ts";
import { LedgerError } from "../ledger/index.ts";
import { messageText, type OwnerMessages } from "../messages.ts";
import { NOTE_REPEATS } from "../research/index.ts";
import type { HarnessService } from "./index.ts";
import type { ReplyNow } from "./watch.ts";

/**
 * What a running trial says to the harness (its session's lines and counters, a wait for its
 * provider, its ideas and field notes), and the owner's messages given to the trials and the
 * planner.
 */

/** A worker's idea for its run's queue (`thermite-trial idea`, or Pi's idea tool). */
export const IdeaRequest = z.strictObject({
  title: ExperimentText.title,
  details: ExperimentText.details.optional(),
  family: ExperimentText.family.optional(),
  why: ExperimentText.why.optional(),
  /** In a research run, the question the task is about, an index from 0 (goal 117). */
  question: z.number().int().min(0).optional(),
});

/**
 * A worker's idea for its run's queue: proposed, by its lane, until the planner queues or drops
 * it (or the owner does first). The trial (found by its token) decides the run and the lane.
 * No limit on how many: none is set by default (the rules for every goal). In a research run,
 * an idea that asks for a measurement is refused in words (goal 117): it is a next experiment.
 */
export function proposeIdea(
  svc: HarnessService,
  token: string,
  input: unknown,
): { experiment: string; state: "proposed" } {
  const t = new Registry(svc.ledger).openTrial(token);
  const idea = IdeaRequest.parse(input);
  if (svc.ledger.runs.get(t.run)?.mode === "research") {
    const measures = measurementIn(
      [idea.title, idea.details ?? "", idea.why ?? "", idea.family ?? ""].join("\n"),
    );
    if (measures) throw new LedgerError("invalid", measurementRefusal(measures));
  }
  const x = svc.queue.add(t.run, { ...idea, by: t.lane, state: "proposed", trial: t.id }, t.lane);
  svc.live.append({
    source: `trial:${t.id}`,
    kind: "status",
    text: `idea for the queue: ${x.title}`,
    lane: t.lane,
    run: t.run,
  });
  return { experiment: x.id, state: "proposed" };
}

/**
 * A worker's field note (`thermite-trial note`, or Pi's note tool). The trial (found by its
 * token) decides the run, the lane, the trial and who wrote it (the lane); the note cannot.
 * In a research run, a note that repeats one of the run's last NOTE_REPEATS field notes word
 * for word, once folded, is refused in words (goal 117).
 */
export function writeTrialNote(
  svc: HarnessService,
  token: string,
  input: unknown,
): { note: number } {
  const t = new Registry(svc.ledger).openTrial(token);
  if (svc.ledger.runs.get(t.run)?.mode === "research") {
    const same = svc.journal.repeatOf(t.run, Journal.parse(input).text, NOTE_REPEATS);
    if (same)
      throw new LedgerError(
        "invalid",
        `this note repeats field note #${same.id} (by ${same.by}, ${same.at}) word for word: it is not recorded again. Note what is new, or go on with the work`,
      );
  }
  const n = svc.journal.write(t.run, input, {
    by: t.lane,
    actor: `trial:${t.id}`,
    source: `trial:${t.id}`,
    lane: t.lane,
    trial: t.id,
  });
  return { note: n.id };
}

/** What a trial's harness reports of its session: its lines, its counters, its open model call. */
export interface TrialLines {
  entries?: { kind: LiveKind; text: string }[] | undefined;
  progress?:
    | { turns: number; tool_calls: number; tokens_in: number; tokens_out: number }
    | undefined;
  /** A Pi worker's open model call; null: it ended (goal 143). */
  reply?: ReplyNow | null | undefined;
}

/** A trial's own session lines and counters, as its harness reports them. */
export function trialReport(
  svc: HarnessService,
  trial: { id: string; run: string; lane: string },
  r: TrialLines,
): void {
  if (r.reply !== undefined) svc.watch.reply(trial.id, r.reply, svc.clock().toISOString());
  if (r.progress) {
    svc.trialProgress.set(trial.id, r.progress);
    // Kept in the trial's record too, so a restart that interrupts it keeps its counters
    // (goal 079).
    svc.ledger.trials.setCounters(trial.id, r.progress);
  }
  for (const e of r.entries ?? [])
    svc.live.append({
      source: `trial:${trial.id}`,
      kind: e.kind,
      text: e.text,
      lane: trial.lane,
      run: trial.run,
    });
  if (r.entries?.length || r.progress?.turns || r.progress?.tokens_in) svc.trialAtWork(trial.id);
}

/**
 * A trial waits for its provider and then goes on in the same conversation (goal 079): a line in
 * its session, and for a rate limit, a wait the scheduler and the research clock read: no new
 * trial of its run starts before it ends, at most one trial's length from now (holdUntil), and a
 * research run's clock stops meanwhile. A planner's call in its own terminal waits the same way
 * for its usage window (goal 169), its line in the planner's session (`source`).
 */
export function trialWait(
  svc: HarnessService,
  trial: { id: string; run: string; lane: string; source?: string | undefined },
  w: { until: string; kind: string; words: string },
): void {
  const at = new Date(w.until);
  const when = Number.isNaN(at.getTime()) ? w.until : at.toISOString().slice(11, 19);
  // A call broken off because its stream went silent (goal 079) says so in its own words.
  const silent = w.kind === "server" ? stalledFor(w.words) : undefined;
  if (silent !== undefined)
    log("harness", "a model call's stream went silent: retried", {
      trial: trial.id,
      run: trial.run,
      seconds: Number(silent),
    });
  svc.live.append({
    source: trial.source ?? `trial:${trial.id}`,
    kind: "status",
    text:
      silent !== undefined
        ? `the model's stream went silent for ${silent} s: retried at ${when} UTC, in the same conversation.`
        : `waiting until ${when} UTC: ${KIND_WORDS[w.kind as ProviderErrorKind] ?? w.kind} (${w.words.slice(0, 300)}). The trial goes on in the same conversation.`,
    lane: trial.lane,
    run: trial.run,
  });
  if (w.kind === "rate_limit" && !Number.isNaN(at.getTime())) {
    const minutes = svc.settings.get().trial_minutes;
    const until = holdUntil(
      svc.ledger,
      trial.run,
      svc.contractFor(trial.run),
      minutes === null ? undefined : minutes * 60_000,
      at.toISOString(),
    );
    svc.ledger.appendEvent("scheduler", "agents_wait_for_limit", trial.run, {
      until,
      trial: trial.id,
      reason: w.words.slice(0, 600),
      in_trial: true,
    });
  }
}

/**
 * The owner's messages each running trial is given (the service holds one): those waiting for it,
 * and those its brief carries, read once its agent is at work.
 */
export class TrialInboxes {
  private readonly svc: { messages: OwnerMessages };
  /**
   * The owner's messages in each starting trial's brief. They count as read only when its agent
   * is at work (its first line or counters), so a trial that fails first leaves them waiting.
   */
  private readonly briefMessages = new Map<
    string,
    { trial: { id: string; run: string; lane: string }; ids: number[] }
  >();

  constructor(svc: { messages: OwnerMessages }) {
    this.svc = svc;
  }

  /**
   * A running trial's inbox: the owner's messages waiting for it (to the trial, its lane,
   * everyone working, or an earlier trial of its lane that ended before reading them), and how
   * its harness says it gave them to the agent. Only messages waiting for this trial can be
   * marked; a read is recorded only when they were given.
   */
  trialInbox(trial: { id: string; run: string; lane: string }): MessageInbox {
    // Messages its brief already carries are not given again.
    const waiting = () => {
      const briefed = new Set(this.briefMessages.get(trial.id)?.ids ?? []);
      return this.svc.messages.waitingForTrial(trial).filter((m) => !briefed.has(m.id));
    };
    return {
      waiting: () => waiting().map((m) => ({ id: m.id, text: messageText(m) })),
      given: (ids, how) => {
        const ok = new Set(waiting().map((m) => m.id));
        this.svc.messages.read(
          ids.filter((id) => ok.has(id)),
          trial.lane,
          { trial, how },
        );
      },
    };
  }

  /** The owner's messages a starting trial's brief carries: read once its agent is at work. */
  briefed(trial: { id: string; run: string; lane: string }, ids: number[]): void {
    if (ids.length) this.briefMessages.set(trial.id, { trial, ids });
  }

  /** A trial's agent is at work: the messages in its brief are read now. */
  trialAtWork(id: string): void {
    const b = this.briefMessages.get(id);
    if (!b) return;
    this.briefMessages.delete(id);
    this.svc.messages.read(b.ids, b.trial.lane, { trial: b.trial, how: "brief" });
  }

  /**
   * Each running trial in Claude Code, Codex or OpenCode whose hook or plugin can take the
   * owner's messages inside its turn (goal 169): its trial loop sets it while the trial runs.
   */
  private readonly turns = new Map<string, TurnDelivery>();

  /** A trial's way to take messages inside its turn; undefined: it has none now. */
  inTurn(id: string, d: TurnDelivery | undefined): void {
    if (d) this.turns.set(id, d);
    else this.turns.delete(id);
  }

  /** The next message offered to a trial's hook or plugin; undefined: none, or no way in now. */
  turnOffer(id: string, at: InTurn): { offer: string; text: string } | undefined {
    return this.turns.get(id)?.offer(at);
  }

  /** The hook or plugin gave an offer's text to its program: the ids read. */
  turnTaken(id: string, offer: string): number[] {
    return this.turns.get(id)?.taken(offer) ?? [];
  }

  /** A trial ended: its brief's messages and its way in are no longer kept for it. */
  forget(id: string): void {
    this.briefMessages.delete(id);
    this.turns.delete(id);
  }
}

/** A trial's waiting messages, given to it now (each read at once). */
export function takeMessages(
  svc: HarnessService,
  trial: { id: string; run: string; lane: string },
): string[] {
  const inbox = svc.trialInbox(trial);
  const msgs = inbox.waiting();
  inbox.given(msgs.map((m) => m.id));
  return msgs.map((m) => m.text);
}

/** The planner's waiting messages, given to it now (each read at once). */
export function takePlannerMessages(svc: HarnessService, run: string): string[] {
  const msgs = svc.messages.waitingForPlanner(run);
  svc.messages.read(
    msgs.map((m) => m.id),
    "planner",
  );
  return msgs.map((m) => m.text);
}
