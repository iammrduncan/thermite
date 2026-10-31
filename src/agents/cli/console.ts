import { errorText, Refusal } from "../../common/errors.ts";
import {
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
  ownerInput(i: Pick<TerminalInput, "text" | "keys" | "follow_up">): Promise<void>;
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
    await this.term.ownerInput(inputOf(i));
    return { outcome: "typed" };
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
