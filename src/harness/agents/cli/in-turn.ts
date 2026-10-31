import { randomUUID } from "node:crypto";
import {
  readNew,
  type SessionEvent,
  type SessionLogAdapter,
} from "../../../agents/programs/index.ts";
import { messageText, type Prompt } from "../../../agents/prompt.ts";
import { log, logDebug } from "../../../common/log.ts";
import type { InTurn } from "../../../core/agents.ts";
import type { LiveKind } from "../../../core/live.ts";
import type { MessageInbox, TurnDelivery } from "../live-session.ts";

/**
 * What a program's hooks or Thermite's plugin give the CLI trial loop inside the agent's turn
 * (goal 169): the program's signals, which the hooks and the plugin write to the trial's signals
 * file, read into the session-log adapters' events; and the owner's messages the hooks and the
 * plugin take inside the turn (TurnMessages), which the trial's routes offer them.
 */

/**
 * A trial's signals, followed while it runs: each read gives the events its hooks or plugin
 * reported since the last. A signal is a hint, never a record: usage, results and the trial's
 * counts still come from the program's output. Headless, the loop only counts them and says at
 * the trial's end what they said, and which kinds of signal the adapter did not know (a new
 * version of the program); the terminal mode reads them for its live view and its timing.
 */
export class TrialSignals {
  private next = 0;
  private readonly adapter: SessionLogAdapter<unknown>;
  private readonly file: string;
  private readonly state: unknown;
  private readonly count = { signals: 0, toolCalls: 0, turnsEnded: 0 };

  constructor(adapter: SessionLogAdapter<unknown>, file: string) {
    this.adapter = adapter;
    this.file = file;
    this.state = adapter.newState();
  }

  /** The events of the signals written since the last read. */
  read(): SessionEvent[] {
    const r = readNew(this.file, this.next);
    this.next = r.next;
    const lines = r.lines.filter((l) => l.trim());
    if (!lines.length) return [];
    this.count.signals += lines.length;
    const events = this.adapter.read(lines, this.state);
    for (const e of events) {
      if (e.type === "tool.call") this.count.toolCalls++;
      else if (e.type === "turn.ended") this.count.turnsEnded++;
    }
    return events;
  }

  /** At the trial's end: what the signals said, and the kinds the adapter did not know. */
  report(fields: Record<string, unknown>): void {
    this.read();
    const unknown = this.adapter.unknown(this.state);
    if (unknown.size)
      log("harness", "the program's hooks sent signals Thermite does not know", {
        ...fields,
        ...this.count,
        unknown: Object.fromEntries(unknown),
      });
    else logDebug("harness", "the program's hooks' signals", { ...fields, ...this.count });
  }
}

/**
 * How long an offer holds its message back from other offers while it waits for its receipt: a
 * hook that died first leaves the message this long at most. Claude Code and Codex stop a hook
 * after 30 s.
 */
export const OFFER_MS = 60_000;

/** Where a message went in, as a trial's live line says it. */
const WHERE: Record<InTurn, string> = {
  "after-tool": "inside its turn, after a tool",
  "turn-end": "at the end of its turn, and the agent went on with it",
};

/** The most offers a run keeps for their receipts; past it, the oldest is forgotten. */
const OFFERS_MAX = 100;

/** What TurnMessages takes from its trial loop. */
export interface TurnMessagesDeps {
  inbox: MessageInbox | undefined;
  /**
   * One owner's message as the agent's role puts it, a later turn of the trial (or the call), at
   * `turn`, its place in the call; its text does not depend on the place.
   */
  render(m: { id: number; text: string }, turn: number): Prompt;
  /** The next later turn's place in the call, which the continuations share. */
  next(): number;
  /** The messages a continuation carries now. */
  held(): readonly number[];
  /**
   * Whether the trial takes messages now: false once it submitted, as in Pi (its work is over, and
   * the lane's next trial, which can act on them, reads them in its brief), and while its program
   * shows a usage limit (a Stop hook's block would send it on before the reset).
   */
  taking?: (() => boolean) | undefined;
  /** Keeps a later turn once it is given. */
  sent?: ((p: Prompt) => void) | undefined;
  live(entries: { kind: LiveKind; text: string }[]): void;
  /** How the program takes it at each place, in words: "Claude Code's PostToolUse hook". */
  how: Record<InTurn, string>;
  now?: (() => number) | undefined;
}

/**
 * The owner's messages a running trial's program takes inside the agent's turn (goal 169), one
 * at a time, through its hook (Claude Code, Codex) or Thermite's plugin (OpenCode), while a run
 * of the program is under way. Each is rendered by the agent's role as a later turn of the trial
 * (goal 166), offered, and read only once the hook or plugin says the program has it: then its
 * read receipt says how it went in, the later turn is kept with its place in the call, and the
 * trial's live view says where. A message a continuation carries is never offered; one never
 * taken stays waiting, for a later offer or the next continuation (CarriedMessages).
 */
export class TurnMessages implements TurnDelivery {
  private running = false;
  private readonly offers = new Map<
    string,
    { id: number; text: string; at: InTurn; made: number }
  >();
  private readonly o: TurnMessagesDeps;

  constructor(o: TurnMessagesDeps) {
    this.o = o;
  }

  private now(): number {
    return this.o.now?.() ?? Date.now();
  }

  /** A run of the program starts: its hooks may take messages. */
  open(): void {
    this.running = true;
  }

  /** The run ended: what was offered and not taken stays waiting. */
  close(): void {
    this.running = false;
    this.offers.clear();
  }

  offer(at: InTurn): { offer: string; text: string } | undefined {
    if (!this.running || !this.o.inbox || this.o.taking?.() === false) return undefined;
    const now = this.now();
    // An offer held past OFFER_MS no longer holds its message back, but its receipt still counts.
    const held = [...this.offers.values()].filter((x) => now - x.made <= OFFER_MS);
    const busy = new Set([...this.o.held(), ...held.map((x) => x.id)]);
    const m = this.o.inbox.waiting().find((w) => !busy.has(w.id));
    if (!m) return undefined;
    const offer = randomUUID();
    this.offers.set(offer, { id: m.id, text: m.text, at, made: now });
    if (this.offers.size > OFFERS_MAX) this.offers.delete(this.offers.keys().next().value ?? "");
    return { offer, text: messageText(this.o.render(m, 0)) };
  }

  taken(offer: string): number[] {
    const x = this.offers.get(offer);
    if (!x || !this.running) return [];
    this.offers.delete(offer);
    // Read meanwhile some other way: nothing more to record.
    if (!this.o.inbox?.waiting().some((w) => w.id === x.id)) return [];
    this.o.inbox.given([x.id], x.at);
    this.o.sent?.(this.o.render(x, this.o.next()));
    this.o.live([
      {
        kind: "status",
        text: `the owner's message #${x.id} went in ${WHERE[x.at]} (${this.o.how[x.at]})`,
      },
    ]);
    return [x.id];
  }
}
