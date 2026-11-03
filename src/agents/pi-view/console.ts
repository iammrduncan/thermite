import { Refusal } from "../../common/errors.ts";
import type { PiViewCall, PiViewInput } from "../../core/api/harness/console.ts";
import { SCREEN_DATA_MAX } from "../../core/screens.ts";
import type { TerminalInput } from "../../core/terminal-input.ts";
import type { ConsoleTerminal } from "../cli/index.ts";
import {
  DEFAULT_COLS,
  DEFAULT_ROWS,
  type ScreenSnapshot,
  type Terminal,
} from "../terminal/index.ts";
import { piViewCall } from "./commands.ts";

/**
 * The caller's side of a role's Pi view (goal 169), in the harness for a worker or a planner, in
 * the supervisor for an advisor: the owner's console into it, as TrialConsole types into it
 * (console.ts in cli/), and its screen for Live. An input becomes one call (commands.ts), which
 * waits here until the role's process, running as the role's user, asks for it over its call's
 * routes (core/api/harness/console.ts) and says what became of it: typed, once its call is made in
 * the role's loop, or refused, with why. The screen comes from the terminal host that holds the
 * process, and is only ever shown.
 */

/** How long the worker has to take an input and make its call: then it is refused, in words. */
export const PI_VIEW_ANSWER_MS = 15_000;
/** The lines above the screen kept with the view's last screen. */
const LAST_SCROLLBACK = 500;

/** An input that waits for the worker: its call, whether the worker has it, and whom to tell. */
interface Waiting {
  input: PiViewInput;
  taken: boolean;
  settle(why?: string): void;
}

/** A snapshot's last SCREEN_DATA_MAX characters: a longer one starts in its scrollback. */
const kept = (s: ScreenSnapshot): ScreenSnapshot =>
  s.data.length > SCREEN_DATA_MAX ? { ...s, data: s.data.slice(-SCREEN_DATA_MAX) } : s;

export class PiConsole implements ConsoleTerminal {
  private readonly waiting: Waiting[] = [];
  /** The worker's ask for the next input, while it waits for one. */
  private asking: ((i: PiViewInput | null) => void) | undefined;
  private terminal: Terminal | undefined;
  private last: ScreenSnapshot | undefined;
  /** Why the console takes no more input, once the trial is ending. */
  private closed: string | undefined;
  private count = 0;

  /** The terminal host that holds the worker's process, once it runs. */
  attach(t: Terminal): void {
    this.terminal = t;
  }

  /**
   * One input: its call, given to the worker, and settled once the worker says what became of it.
   * Refused in words when it makes no call, when the trial is ending, or when the worker has not
   * answered within PI_VIEW_ANSWER_MS.
   */
  async ownerInput(i: Pick<TerminalInput, "text" | "keys" | "follow_up">): Promise<void> {
    if (this.closed) throw new Refusal(this.closed);
    const call: PiViewCall = piViewCall(i);
    const input: PiViewInput = { id: String(++this.count), call };
    await new Promise<void>((resolve, reject) => {
      const w: Waiting = {
        input,
        taken: false,
        settle: (why) => {
          clearTimeout(timer);
          const at = this.waiting.indexOf(w);
          if (at >= 0) this.waiting.splice(at, 1);
          if (why === undefined) resolve();
          else reject(new Refusal(why));
        },
      };
      const timer = setTimeout(
        () =>
          w.settle(
            w.taken
              ? `the Pi worker took it but did not say within ${PI_VIEW_ANSWER_MS / 1000} s what became of it`
              : `the Pi worker did not take it within ${PI_VIEW_ANSWER_MS / 1000} s`,
          ),
        PI_VIEW_ANSWER_MS,
      );
      timer.unref?.();
      this.waiting.push(w);
      this.give();
    });
  }

  /** The oldest input the worker has not taken, to its ask that waits. */
  private give(): void {
    const ask = this.asking;
    const w = this.waiting.find((x) => !x.taken);
    if (!ask || !w) return;
    this.asking = undefined;
    w.taken = true;
    ask(w.input);
  }

  /**
   * The worker asks for the next input: at once when one waits, else when one comes, or null after
   * `waitMs`, or once the trial is ending. One ask at a time: an older one ends with null.
   */
  next(waitMs: number): Promise<PiViewInput | null> {
    const w = this.waiting.find((x) => !x.taken);
    if (w) {
      w.taken = true;
      return Promise.resolve(w.input);
    }
    if (this.closed || waitMs <= 0) return Promise.resolve(null);
    this.asking?.(null);
    return new Promise((resolve) => {
      const give = (i: PiViewInput | null) => {
        clearTimeout(timer);
        resolve(i);
      };
      const timer = setTimeout(() => {
        if (this.asking === give) this.asking = undefined;
        resolve(null);
      }, waitMs);
      timer.unref?.();
      this.asking = give;
    });
  }

  /** The worker says what became of an input it took. False for one it was not given. */
  done(id: string, outcome: "typed" | "refused", why?: string): boolean {
    const w = this.waiting.find((x) => x.input.id === id && x.taken);
    if (!w) return false;
    w.settle(outcome === "typed" ? undefined : (why ?? "the Pi view refused it"));
    return true;
  }

  /**
   * The trial is ending: its screen is kept now, while the worker still draws it, and nothing
   * more goes in.
   */
  async end(): Promise<void> {
    this.close("the trial is ending: nothing more goes into its Pi view");
    const t = this.terminal;
    if (!t) return;
    try {
      this.last = kept(await t.snapshot(LAST_SCROLLBACK));
    } catch {
      // The worker ended meanwhile: the host's last lines stand in (ended()).
    }
  }

  /** The worker's process has ended; `lines`: its screen's last lines, when no screen was kept. */
  ended(lines?: readonly string[]): void {
    this.close("the trial has ended: nothing more goes into its Pi view");
    this.terminal = undefined;
    if (!this.last && lines?.length)
      this.last = { cols: DEFAULT_COLS, rows: DEFAULT_ROWS, data: lines.join("\r\n") };
  }

  private close(why: string): void {
    this.closed ??= why;
    this.asking?.(null);
    this.asking = undefined;
    for (const w of [...this.waiting]) w.settle(why);
  }

  /** A worker in Pi has no usage window of its own to wait for: its loop waits for its provider. */
  limitShown(): undefined {
    return undefined;
  }

  /** The view now, for Live, or its last screen; undefined before the worker drew one. */
  async screen(): Promise<ScreenSnapshot | undefined> {
    const t = this.terminal;
    if (t && !this.closed) {
      try {
        return await t.snapshot(0);
      } catch {
        // It ended meanwhile: its last screen.
      }
    }
    return this.last;
  }

  lastScreen(): ScreenSnapshot | undefined {
    return this.last;
  }
}
