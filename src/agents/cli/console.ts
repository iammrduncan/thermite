import { errorText, Refusal } from "../../common/errors.ts";
import { SCREEN_DATA_MAX, type ScreenFrame } from "../../core/screens.ts";
import {
  CONFIRM_FIRST,
  TERMINAL_QUEUE_MAX,
  type TerminalInput,
  type TerminalOutcome,
} from "../../core/terminal-input.ts";
import type { ScreenSnapshot } from "../terminal/index.ts";

/**
 * The owner's console into one trial's terminal (goal 169): the owner's inputs (terminal_input),
 * typed into the program by its terminal host, and its screen for the live view. While the
 * program's session log shows a usage limit, an input waits for the reset unless the owner said to
 * send it now (the owner's decision of 2026-10-27): it goes in, in order, once the reset has come
 * and the log shows the program at work again (usage-window.ts waits the window out); at the
 * trial's end, what still waits is dropped. Each input's outcome goes to whoever gave it, at once,
 * and once more later for one that waited.
 */

/**
 * What the console needs of the role's terminal: terminal.ts's RoleTerminal, or a worker's Pi
 * view (pi-view/console.ts).
 */
export interface ConsoleTerminal {
  /**
   * The owner's input, into the program. With `startBy` (milliseconds since the epoch), refused in
   * words, and never typed, when it can't start by then (goal 241).
   */
  ownerInput(
    i: Pick<TerminalInput, "text" | "keys" | "follow_up">,
    startBy?: number,
  ): Promise<void>;
  /** Keys as pressed on Live (goal 187); none for a Pi view, which takes typed lines. */
  ownerRaw?(data: string): Promise<void>;
  limitShown(): { resetsAt?: string | undefined } | undefined;
  screen(): Promise<ScreenSnapshot | undefined>;
  lastScreen(): ScreenSnapshot | undefined;
}

/** What became of an input at once: typed, or waiting for the usage window's reset. */
export type ConsoleNow = { outcome: "typed" } | { outcome: "queued"; until?: string | undefined };

/** What became of an input that waited: typed after the reset, or dropped, with why. */
export type ConsoleLater = (
  outcome: Extract<TerminalOutcome, "typed_after_reset" | "dropped">,
  why?: string,
) => void;

/** The usage limit the screen shows, for the live view: until when, when the program said. */
export type ConsoleLimit = { resetsAt?: string | undefined } | undefined;

/** What goes into the terminal of an input: its text or keys, and follow_up only when given. */
const inputOf = (i: Pick<TerminalInput, "text" | "keys" | "follow_up">) => ({
  text: i.text,
  keys: i.keys,
  ...(i.follow_up ? { follow_up: true as const } : {}),
});

export class TrialConsole {
  private readonly term: ConsoleTerminal;
  /** The inputs waiting for the usage window's reset, oldest first: whom to tell, and the reset. */
  private readonly waiting: {
    input: Pick<TerminalInput, "text" | "keys" | "follow_up">;
    later: ConsoleLater;
    until?: string | undefined;
  }[] = [];
  private flushing = false;
  /** Why the console takes no more input, once the trial ended. */
  private closed: string | undefined;

  constructor(term: ConsoleTerminal) {
    this.term = term;
  }

  /**
   * One input: typed now, or, while the program shows a usage limit and the owner did not say to
   * send it now, kept for after the reset (`later` is told then). Refused in words when the trial
   * has ended, when TERMINAL_QUEUE_MAX inputs wait already, or when no program runs to take it.
   */
  async input(
    i: Pick<TerminalInput, "text" | "keys" | "wait" | "follow_up">,
    later: ConsoleLater,
    startBy?: number,
  ): Promise<ConsoleNow> {
    if (this.closed) throw new Refusal(this.closed);
    const limit = this.term.limitShown();
    if (limit && i.wait === "queue") {
      if (this.waiting.length >= TERMINAL_QUEUE_MAX)
        throw new Refusal(
          `${TERMINAL_QUEUE_MAX} inputs wait for the usage window's reset already: send this one now, or after the reset`,
        );
      this.waiting.push({ input: inputOf(i), later, until: limit.resetsAt });
      return { outcome: "queued", until: limit.resetsAt };
    }
    await this.term.ownerInput(inputOf(i), startBy);
    return { outcome: "typed" };
  }

  /** The line the owner types on Live, as its keys made it, and one whose Enter is held (goal 187). */
  private line = "";
  private heldLine: string | undefined;
  /** Inside a pasted block: its line breaks are text, not Enter. */
  private pasting = false;

  /**
   * Keys the owner pressed on Live (goal 187): to the program as they came, while the line they
   * make up is kept, and at each Enter `typed` is told the line. An Enter on a line that
   * CONFIRM_FIRST matches is held, and left out, once: the next Enter on the same line sends it.
   * Refused in words when the trial has ended, or the terminal takes typed lines only (Pi's view).
   */
  async keystrokes(data: string, typed: (line: string) => void): Promise<void> {
    if (this.closed) throw new Refusal(this.closed);
    const raw = this.term.ownerRaw?.bind(this.term);
    if (!raw)
      throw new Refusal("this terminal is a worker's Pi view, which takes typed lines: send words");
    let out = "";
    for (let i = 0; i < data.length; i++) {
      const ch = data[i] as string;
      if (ch === "\x1b") {
        // An escape: a pasted block's ends, or a key's (the arrows, Home, a function key).
        // biome-ignore lint/suspicious/noControlCharactersInRegex: an escape is what it reads.
        const seq = /^\x1b(?:\[[0-9;?]*[@-~]|O.|.)?/.exec(data.slice(i))?.[0] ?? ch;
        if (seq === "\x1b[200~") this.pasting = true;
        else if (seq === "\x1b[201~") this.pasting = false;
        out += seq;
        i += seq.length - 1;
        continue;
      }
      if (ch === "\r" && !this.pasting) {
        if (CONFIRM_FIRST.test(this.line) && this.heldLine !== this.line) {
          this.heldLine = this.line;
          continue;
        }
        if (this.line.trim()) typed(this.line);
        this.line = "";
        this.heldLine = undefined;
        out += ch;
        continue;
      }
      if (ch === "\x7f" || ch === "\b") this.line = this.line.slice(0, -1);
      else if (ch === "\x15" || ch === "\x03") this.line = "";
      else if (ch >= " " || ch === "\t" || (ch === "\r" && this.pasting))
        this.line += ch === "\r" ? "\n" : ch;
      if (this.heldLine !== undefined && this.line !== this.heldLine) this.heldLine = undefined;
      out += ch;
    }
    if (out) await raw(out);
  }

  /** A line whose Enter is held, for the live view to say so; undefined when none is. */
  get held(): string | undefined {
    return this.heldLine;
  }

  /** How many inputs wait for the reset. */
  get queued(): number {
    return this.waiting.length;
  }

  /** The usage limit the program shows now, if any. */
  limit(): ConsoleLimit {
    return this.term.limitShown();
  }

  /**
   * The program takes the input that waits first: its log shows no limit, a turn having begun, and
   * the reset it waited for has come (a turn the owner's input sent now began is before it).
   */
  private taking(): boolean {
    const until = this.waiting[0]?.until;
    return !this.term.limitShown() && (until === undefined || Date.now() >= Date.parse(until));
  }

  /**
   * After each read of the session log: once the program takes input again after the reset, the
   * inputs that waited go in, in order. One that can't go in is dropped, with why.
   */
  flush(): void {
    if (this.flushing || !this.waiting.length || !this.taking()) return;
    this.flushing = true;
    void (async () => {
      try {
        while (this.waiting.length && !this.closed && this.taking()) {
          const w = this.waiting.shift() as (typeof this.waiting)[number];
          try {
            await this.term.ownerInput(w.input);
            w.later("typed_after_reset");
          } catch (err) {
            w.later("dropped", errorText(err));
          }
        }
      } finally {
        this.flushing = false;
      }
    })();
  }

  /** The trial ended: no more input, and what still waits is dropped with `why`. */
  close(why: string): void {
    this.closed = "the trial has ended: nothing more goes into its terminal";
    for (const w of this.waiting.splice(0)) w.later("dropped", why);
  }

  /** The screen now, or the last one; undefined before the program drew one. */
  screen(): Promise<ScreenSnapshot | undefined> {
    return this.term.screen();
  }

  /** The program's last screen, once the trial ended. */
  lastScreen(): ScreenSnapshot | undefined {
    return this.term.lastScreen();
  }
}

/** A screen cut to SCREEN_DATA_MAX characters, its newest kept. */
const fit = (s: ScreenSnapshot) => ({
  cols: s.cols,
  rows: s.rows,
  data: s.data.length > SCREEN_DATA_MAX ? s.data.slice(-SCREEN_DATA_MAX) : s.data,
});

/**
 * One terminal's frame for control's live view (core/screens.ts), wherever its console is (the
 * harness's or the supervisor's): a running one's screen now, with its usage limit and the inputs
 * that wait for its reset; an ended one's last screen; or `none`, for one with no terminal here.
 * Only ever shown.
 */
export async function screenFrame(o: {
  id: string;
  console?:
    | (Pick<TrialConsole, "screen" | "limit" | "queued"> & { held?: string | undefined })
    | undefined;
  last?: ScreenSnapshot | undefined;
  /** Its screen is a worker's or a planner's Pi view. */
  piView?: boolean | undefined;
  at: string;
}): Promise<ScreenFrame> {
  const c = o.console;
  if (c) {
    const s = await c.screen().catch(() => undefined);
    const limit = c.limit();
    return {
      trial: o.id,
      state: s ? "running" : "none",
      ...(s ? fit(s) : {}),
      ...(limit ? { limit: limit.resetsAt ? { resets_at: limit.resetsAt } : {} } : {}),
      ...(c.queued ? { queued: c.queued } : {}),
      ...(c.held ? { held: c.held.slice(0, 500) } : {}),
      ...(o.piView ? { pi_view: true as const } : {}),
      at: o.at,
    };
  }
  if (o.last) return { trial: o.id, state: "ended", ...fit(o.last), at: o.at };
  return { trial: o.id, state: "none", at: o.at };
}
