import { ADVISOR_ROLES, type AdvisorRole, type MessageHow } from "../core/agents.ts";
import { type Contract, MAX_LANES } from "../core/contract.ts";
import type { LiveLog } from "../core/live.ts";
import type { RigSettings } from "../core/rig-settings.ts";
import { lanesAtWork } from "./agents/index.ts";
import { type Ledger, LedgerError, type MessageRow } from "./ledger/index.ts";

/**
 * The owner's messages to a run's agents (message_agent), with who read each one and when.
 *
 * Recipients and readers:
 * - `all` (everyone working): every lane reads it once, and so does the planner, while it is on
 *   (a research run's too, goal 117);
 * - `lane-N`: that lane; `trial:ID`: that trial, or, if it ended before reading it, its lane's
 *   next trial, which is told so;
 * - `planner`: the planner, at its next plan;
 * - `advisors`: the teachers, the auditor and the review panel, each once; `teachers`,
 *   `auditor` and `review_panel`: that role.
 *
 * A message is waiting for a reader until that reader has received it: a read is recorded only
 * when the text was given to an agent (in its brief, at its next step, in a continued session or
 * in an advisor's package), never when it was only fetched. A message kept in force (`all` or a
 * lane) also goes into every new trial's brief until the owner unkeeps it.
 *
 * Every send, first read by each reader, unkeep and advisor answer is an event in the run's
 * ledger, so control can show the messages and their receipts from events alone. The text is the
 * owner's own (a signed owner command), so it may go into the ledger.
 */

export type { AdvisorRole };

export interface OwnerMessage {
  id: number;
  to: string;
  text: string;
  keep: boolean;
  at: string;
  /** Said with the text when it reaches a trial it was not sent to. */
  note?: string | undefined;
}

/** A message as an agent is given it: its text, and a note when it was sent elsewhere first. */
export function messageText(m: Pick<OwnerMessage, "text" | "note">): string {
  return m.note ? `${m.text}\n\n(${m.note})` : m.text;
}

const ROLE_NAME: Record<AdvisorRole, string> = {
  teachers: "the teachers",
  auditor: "the auditor",
  review_panel: "the review panel",
};

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

const toMessage = (r: MessageRow): OwnerMessage => ({
  id: Number(r.id),
  to: r.target,
  text: r.text,
  keep: Number(r.keep) === 1,
  at: r.created_at,
});

export interface SendResult {
  message: number;
  to: string;
  keep: boolean;
  /** Who will read it: lanes, the planner, advisor roles (for a trial: its lane). */
  readers: string[];
  note?: string | undefined;
}

export class OwnerMessages {
  private readonly ledger: Ledger;
  private readonly live: LiveLog;
  private readonly clock: () => Date;
  private readonly settings: () => RigSettings;
  private readonly contractFor: (run: string) => Contract;

  constructor(o: {
    ledger: Ledger;
    live: LiveLog;
    clock: () => Date;
    settings: () => RigSettings;
    contractFor: (run: string) => Contract;
  }) {
    this.ledger = o.ledger;
    this.live = o.live;
    this.clock = o.clock;
    this.settings = o.settings;
    this.contractFor = o.contractFor;
  }

  private now(): string {
    return this.clock().toISOString();
  }

  /**
   * Who would read a message to `to` in this run, now. A recipient that would never read it is
   * refused with the reason, so control shows the message as failed rather than delivered.
   */
  private readersOf(run: string, to: string): { readers: string[]; note?: string | undefined } {
    const status = this.ledger.runs.get(run)?.status;
    if (!status) throw new LedgerError("not_found", `no run ${run}`);
    if (status === "closed")
      throw new LedgerError("invalid", `run ${run} is closed: nothing will read this message`);
    const contract = this.contractFor(run);
    const s = this.settings();
    const lanes = Math.min(contract.lanes.count, MAX_LANES);
    // The lanes at work now, as the scheduler counts them: the owner's lane count first.
    const working = lanesAtWork(this.ledger, run, contract);
    // A run without agents (a try) has no lanes and no planner to read anything.
    const noAgents = this.ledger.runs.get(run)?.agents === false;
    if (
      noAgents &&
      (to === "all" || to === "planner" || /^lane-\d+$/.test(to) || to.startsWith("trial:"))
    )
      throw new LedgerError(
        "invalid",
        `run ${run} has no agents (the judge alone tries the kit): nothing would read this message`,
      );
    // A research run's planner reads them too (goals 047 and 117), while it is on.
    const planner = (): string | undefined =>
      s.planner
        ? undefined
        : "the planner is off on this rig (Edit rig), so nothing would read this message";
    const advisor = (role: AdvisorRole): string | undefined => {
      if (role === "teachers")
        return s.teachers
          ? undefined
          : "the teachers are off on this rig (Edit rig), so nothing would read this message";
      if (role === "auditor") {
        if (!s.auditor)
          return "the auditor is off on this rig (Edit rig), so nothing would read this message";
        return contract.mode === "research"
          ? "a research run has no audits, so the auditor would never read this message"
          : undefined;
      }
      if (!s.review)
        return "the review panel is off on this rig (Edit rig), so nothing would read this message";
      // A research run's questions are reviewed too (goal 112).
      return contract.mode === "research" ||
        (contract.mode === "goal" && contract.goals.some((g) => g.verify.type === "review"))
        ? undefined
        : "this run has no goal the review panel reviews, so the review panel would never read this message";
    };
    if (to === "all") {
      const readers = Array.from({ length: working }, (_, i) => `lane-${i + 1}`);
      return planner() ? { readers } : { readers: [...readers, "planner"] };
    }
    if (to === "planner") {
      const why = planner();
      if (why) throw new LedgerError("invalid", why);
      return { readers: ["planner"] };
    }
    if (to === "teachers" || to === "auditor" || to === "review_panel") {
      const why = advisor(to);
      if (why) throw new LedgerError("invalid", why);
      return { readers: [to] };
    }
    if (to === "advisors") {
      const readers = ADVISOR_ROLES.filter((r) => !advisor(r));
      if (!readers.length)
        throw new LedgerError(
          "invalid",
          `none of the advisors would read this message: ${ADVISOR_ROLES.map((r) => advisor(r)).join("; ")}`,
        );
      return { readers: [...readers] };
    }
    const lane = /^lane-(\d+)$/.exec(to);
    if (lane) {
      if (Number(lane[1]) > lanes)
        throw new LedgerError("invalid", `run ${run} has ${lanes} lane${lanes === 1 ? "" : "s"}`);
      return { readers: [to] };
    }
    const trial = this.ledger.trials.get(to.slice("trial:".length));
    if (trial?.run !== run)
      throw new LedgerError("not_found", `no ${to.replace(":", " ")} in run ${run}`);
    return {
      readers: [trial.lane],
      ...(trial.ended_at
        ? { note: `${to.replace(":", " ")} has ended; ${trial.lane}'s next trial reads this` }
        : {}),
    };
  }

  /** A new message: recorded, an event (with its text), and a line in the live view. */
  send(
    p: { run: string; to: string; text: string; keep?: boolean | undefined },
    by: string,
  ): SendResult {
    const { readers, note } = this.readersOf(p.run, p.to);
    const keep = p.keep === true;
    const at = this.now();
    const id = this.ledger.tx(() => {
      const id = this.ledger.messages.add({ run: p.run, to: p.to, text: p.text, by, at, keep });
      this.ledger.appendEvent(by, "agent_message", p.run, {
        id,
        to: p.to,
        keep,
        text: p.text,
        chars: p.text.length,
      });
      return id;
    });
    const trialLane = p.to.startsWith("trial:") ? readers[0] : undefined;
    this.live.append({
      source: p.to.startsWith("trial:") ? p.to : p.to === "planner" ? "planner" : "supervisor",
      kind: "message",
      text: `Owner to ${p.to} (#${id}${keep ? ", kept in force" : ""}): ${p.text}`,
      run: p.run,
      ...(p.to.startsWith("lane-") ? { lane: p.to } : trialLane ? { lane: trialLane } : {}),
    });
    return { message: id, to: p.to, keep, readers, ...(note ? { note } : {}) };
  }

  /** The owner ends a message kept in force: new briefs no longer carry it. */
  unkeep(run: string, id: number, by: string): { message: number; unkept: true } {
    const m = this.ledger.messages.get(id);
    if (!m || m.run !== run) throw new LedgerError("not_found", `no message ${id} in run ${run}`);
    if (Number(m.keep) !== 1)
      throw new LedgerError("invalid", `message ${id} is not kept in force`);
    if (m.unkept_at)
      throw new LedgerError(
        "conflict",
        `message ${id} was already removed from force at ${m.unkept_at}`,
      );
    this.ledger.tx(() => {
      this.ledger.messages.unkeep(id, this.now());
      this.ledger.appendEvent(by, "agent_message_unkept", run, { message: id });
    });
    this.live.append({
      source: "supervisor",
      kind: "status",
      text: `the owner's message #${id} is no longer in force`,
      run,
      ...(m.target.startsWith("lane-") ? { lane: m.target } : {}),
    });
    return { message: id, unkept: true };
  }

  /** Messages kept in force for a new trial of this lane: to everyone working, or to the lane. */
  inForce(run: string, lane: string): OwnerMessage[] {
    return this.ledger.messages.inForce(run, lane).map(toMessage);
  }

  /**
   * Messages a trial has not received yet and its lane has not read: to the trial, to its lane,
   * to everyone working, and those sent to an earlier trial of its lane that ended before
   * reading them (with a note that says so). A message removed from force is no longer given.
   */
  waitingForTrial(trial: { id: string; run: string; lane: string }): OwnerMessage[] {
    return this.ledger.messages.unreadByTrial(trial).map((r) => {
      const m = toMessage(r);
      return r.target.startsWith("trial:") && r.target !== `trial:${trial.id}`
        ? {
            ...m,
            note: `The owner sent this to ${r.target.replace(":", " ")}, an earlier trial of your lane, which ended before it read it.`,
          }
        : m;
    });
  }

  /** Messages the planner has not read: to it, and to everyone working (hill-climb and goal). */
  waitingForPlanner(run: string): OwnerMessage[] {
    return this.ledger.messages.unreadByPlanner(run).map(toMessage);
  }

  /** Messages an advisor role has not read: to it, and to all the advisors. */
  waitingForAdvisor(run: string, role: AdvisorRole, limit = 20): OwnerMessage[] {
    return this.ledger.messages.unreadByRole(run, role, limit).map(toMessage);
  }

  /**
   * The teachers' view: the messages it has not read (to answer), then the five it read in
   * the last day, as the owner's standing wishes (read before; whether it answered them is in
   * the advisor_answer events).
   */
  forTeachers(run: string): (OwnerMessage & { read: boolean })[] {
    const since = new Date(this.clock().getTime() - 24 * 3_600_000).toISOString();
    const read = this.ledger.messages.readByTeachers(run, since).map(toMessage).reverse();
    return [
      ...read.map((m) => ({ ...m, read: true })),
      ...this.waitingForAdvisor(run, "teachers").map((m) => ({ ...m, read: false })),
    ];
  }

  /** The messages waiting for each advisor role (their ids), for the supervisor's loop. */
  waitingIds(run: string): Record<AdvisorRole, number[]> {
    return {
      teachers: this.waitingForAdvisor(run, "teachers", 50).map((m) => m.id),
      auditor: this.waitingForAdvisor(run, "auditor", 50).map((m) => m.id),
      review_panel: this.waitingForAdvisor(run, "review_panel", 50).map((m) => m.id),
    };
  }

  /**
   * Records that a reader received messages (a lane in a trial, the planner, an advisor role):
   * the first read by each reader is an event, and every read a line on the reader's live
   * source. Reading the same message twice in one trial records it once. `at.trial`: the trial a
   * lane read them in, and `at.how`, how its agent was given them (goal 169); `at.round`: the
   * planner's round that read them, so control can show its answer (the rules it made, its
   * notes) with them.
   */
  read(
    ids: number[],
    reader: string,
    at: {
      trial?: { id: string; run: string; lane: string } | undefined;
      round?: number | undefined;
      how?: MessageHow | undefined;
    } = {},
  ): void {
    const { trial, round, how } = at;
    const now = this.now();
    const done: MessageRow[] = [];
    this.ledger.tx(() => {
      for (const id of [...new Set(ids)]) {
        const m = this.ledger.messages.get(id);
        if (!m || (trial && m.run !== trial.run)) continue;
        const seen = this.ledger.messages.readIn(id, reader);
        if (seen.includes(trial?.id ?? null)) continue;
        this.ledger.messages.recordRead(id, reader, trial?.id ?? null, now);
        if (!seen.length)
          this.ledger.appendEvent(
            trial ? `trial:${trial.id}` : reader === "planner" ? "planner" : "supervisor",
            "agent_message_read",
            m.run,
            {
              message: id,
              by: reader,
              ...(trial ? { trial: trial.id } : {}),
              ...(round !== undefined ? { round } : {}),
              ...(how ? { how } : {}),
            },
          );
        done.push(m);
      }
    });
    for (const m of done) {
      const what = `the owner's message #${m.id}${Number(m.keep) === 1 ? " (in force)" : ""}: ${clip(m.text, 300)}`;
      if (trial)
        this.live.append({
          source: `trial:${trial.id}`,
          kind: "status",
          text: `read ${what}`,
          lane: trial.lane,
          run: trial.run,
        });
      else if (reader === "planner")
        this.live.append({ source: "planner", kind: "status", text: `read ${what}`, run: m.run });
      else
        this.live.append({
          source: "supervisor",
          kind: "status",
          text: `${ROLE_NAME[reader as AdvisorRole] ?? reader} read ${what}`,
          run: m.run,
        });
    }
  }

  /**
   * An advisor's answer to a message it was given: a read by its role, an advisor_answer event
   * and a line in the live view. The message must be one the role reads.
   */
  answer(input: {
    run: string;
    role: AdvisorRole;
    message: number;
    text: string;
    advisor?: string | undefined;
  }): void {
    this.requireFor(input.run, input.role, input.message);
    this.read([input.message], input.role);
    const text = input.text.slice(0, 2000);
    this.ledger.appendEvent("supervisor", "advisor_answer", input.run, {
      message: input.message,
      role: input.role,
      text,
      ...(input.advisor ? { advisor: input.advisor } : {}),
    });
    this.live.append({
      source: "supervisor",
      kind: "text",
      text: `${ROLE_NAME[input.role]}${input.advisor ? ` (${input.advisor})` : ""} answered the owner's message #${input.message}: ${text}`,
      run: input.run,
    });
  }

  /** Checks that a message is in the run and addressed to the advisor role. */
  requireFor(run: string, role: AdvisorRole, id: number): void {
    const m = this.ledger.messages.get(id);
    if (!m || m.run !== run) throw new LedgerError("not_found", `no message ${id} in run ${run}`);
    if (m.target !== role && m.target !== "advisors")
      throw new LedgerError("invalid", `message ${id} is not for ${ROLE_NAME[role]}`);
  }
}
