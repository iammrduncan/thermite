import {
  type ConsoleLater,
  type ConsoleNow,
  screenFrame,
  type TrialConsole,
} from "../../../agents/cli/index.ts";
import type { ScreenSnapshot } from "../../../agents/terminal/index.ts";
import { Refusal } from "../../../common/errors.ts";
import type { AdvisorInput, AdvisorTerminal } from "../../../core/api/harness/terminals.ts";
import type { ScreenFrame } from "../../../core/screens.ts";

/**
 * The supervisor's own consoles into its advisors' terminals (goal 169): each advisor's call in its
 * program's terminal sets its console here while it runs, under its id (advisorCallId); the last
 * screen of each that ended stays in memory, the newest LAST_SCREENS_KEPT, never on disk. The
 * owner's input comes only from the harness, which checked and recorded it (relay.ts); the screens
 * go to control with the harness's (live/screens.ts).
 */

/** How many ended calls keep their last screen: the newest; the oldest goes first. */
export const LAST_SCREENS_KEPT = 20;

export class AdvisorConsoles {
  private readonly open = new Map<string, { of: AdvisorTerminal; console: TrialConsole }>();
  private readonly last = new Map<string, ScreenSnapshot>();
  private readonly heard: (() => void)[] = [];

  /** `f` hears each call that starts or ends in its terminal. */
  onChange(f: () => void): void {
    this.heard.push(f);
  }

  private changed(): void {
    for (const f of this.heard) f();
  }

  /** A call started in its terminal: its console, its run and its advisor's name. */
  set(of: AdvisorTerminal, console: TrialConsole): void {
    this.last.delete(of.id);
    this.open.set(of.id, { of, console });
    this.changed();
  }

  /** A call ended: its console goes, its last screen stays, the newest LAST_SCREENS_KEPT. */
  ended(id: string): void {
    const c = this.open.get(id);
    if (!c) return;
    this.open.delete(id);
    const screen = c.console.lastScreen();
    if (screen) {
      this.last.set(id, screen);
      for (const old of this.last.keys()) {
        if (this.last.size <= LAST_SCREENS_KEPT) break;
        this.last.delete(old);
      }
    }
    this.changed();
  }

  /** The calls that run in their terminals now, as the harness and the rig's report list them. */
  calls(): AdvisorTerminal[] {
    return [...this.open.values()].map((c) => c.of);
  }

  /** Whether a terminal is one of the supervisor's: open, or with its last screen kept. */
  has(id: string): boolean {
    return this.open.has(id) || this.last.has(id);
  }

  /** The screens of the supervisor's terminals among `ids`, for control's live view. */
  async frames(ids: readonly string[]): Promise<ScreenFrame[]> {
    const out: ScreenFrame[] = [];
    for (const id of ids.filter((x) => this.has(x)))
      out.push(
        await screenFrame({
          id,
          console: this.open.get(id)?.console,
          last: this.last.get(id),
          at: new Date().toISOString(),
        }),
      );
    return out;
  }

  /**
   * One owner's input the harness checked and recorded: typed into the call's terminal now, or
   * queued for its usage window's reset (`later` is told then). Refused in words when the call is
   * not running.
   */
  input(i: AdvisorInput, later: ConsoleLater): Promise<ConsoleNow> {
    const c = this.open.get(i.call);
    if (!c)
      return Promise.reject(
        new Refusal(`${i.call} is not running in its terminal now: nothing more goes into it`),
      );
    return c.console.input(
      { ...(i.text !== undefined ? { text: i.text } : { keys: i.keys }), wait: i.wait },
      later,
    );
  }
}
