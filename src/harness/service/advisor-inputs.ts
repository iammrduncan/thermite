import { randomUUID } from "node:crypto";
import type { ConsoleLater, ConsoleNow, TrialConsole } from "../../agents/cli/index.ts";
import { Refusal } from "../../common/errors.ts";
import type { AdvisorInput, AdvisorOutcome } from "../../core/api/harness/terminals.ts";
import type { TerminalInput } from "../../core/terminal-input.ts";

/**
 * The owner's inputs to the advisors' terminals (goal 169), on their way to the rig's supervisor,
 * which runs each advisor's call in its program's own terminal. The harness checks and records each
 * input as it does a trial's (consoles.ts), then hands it here. The supervisor takes what waits with
 * a call it holds open until there is some (take), types it into the call's terminal, and says what
 * became of it (outcome), as it does the knowledge base's asks. An input the supervisor has not
 * taken in INPUT_UNTAKEN_MS, or not answered in INPUT_UNANSWERED_MS, is refused in words; one
 * queued for its program's usage window waits for its later outcome, the newest LATER_MAX.
 */

/** How long an input waits for the supervisor to take it: then it is refused, in words. */
export const INPUT_UNTAKEN_MS = 15_000;
/** How long a taken input waits for what became of it: typing it takes seconds at most. */
export const INPUT_UNANSWERED_MS = 30_000;
/** The most inputs one take hands over; the rest wait for the next. */
export const TAKE_MAX = 20;
/** The longest a take is held open, in milliseconds. */
export const TAKE_WAIT_MAX_MS = 30_000;
/** The most inputs waiting at once: one more is refused at once. */
export const WAITING_MAX = 100;
/** The most queued inputs whose later outcome is still awaited; past it, the oldest is forgotten. */
export const LATER_MAX = 200;

/** A console as the harness's consoles use it: a trial's, a call's, or an advisor's call's here. */
export type OwnerConsole = Pick<
  TrialConsole,
  "input" | "screen" | "lastScreen" | "limit" | "queued"
>;

interface Waiting {
  out: AdvisorInput;
  taken: boolean;
  done: (o: AdvisorOutcome) => void;
  timer: NodeJS.Timeout;
}

export class AdvisorInputs {
  private readonly waiting = new Map<string, Waiting>();
  private readonly later = new Map<string, ConsoleLater>();
  private readonly untakenMs: number;
  private readonly unansweredMs: number;
  /** Takes held open, each woken when an input arrives. */
  private takers: (() => void)[] = [];

  /** The waits, INPUT_UNTAKEN_MS and INPUT_UNANSWERED_MS unless told (tests tell shorter ones). */
  constructor(o: { untakenMs?: number; unansweredMs?: number } = {}) {
    this.untakenMs = o.untakenMs ?? INPUT_UNTAKEN_MS;
    this.unansweredMs = o.unansweredMs ?? INPUT_UNANSWERED_MS;
  }

  /**
   * An advisor's call's console in the harness: the owner's input goes on to the supervisor, which
   * holds the call's terminal and sends its screens itself.
   */
  console(call: string): OwnerConsole {
    return {
      input: (i, later) => this.forward(call, i, later),
      screen: async () => undefined,
      lastScreen: () => undefined,
      limit: () => undefined,
      queued: 0,
    };
  }

  /**
   * One input, checked and recorded already, for the supervisor: typed, or queued for the usage
   * window's reset (`later` is told then). Refused in words when the supervisor refuses it, or
   * does not take it or answer in time.
   */
  forward(
    call: string,
    i: Pick<TerminalInput, "text" | "keys" | "wait" | "follow_up">,
    later: ConsoleLater,
  ): Promise<ConsoleNow> {
    if (this.waiting.size >= WAITING_MAX)
      throw new Refusal(
        `${WAITING_MAX} inputs wait for the advisors' terminals already: send this one again in a moment`,
      );
    const id = randomUUID();
    return new Promise<ConsoleNow>((resolve, reject) => {
      const done = (o: AdvisorOutcome) => {
        const w = this.waiting.get(id);
        if (!w) return;
        clearTimeout(w.timer);
        this.waiting.delete(id);
        if (o.outcome === "typed") resolve({ outcome: "typed" });
        else if (o.outcome === "queued") {
          this.keepLater(id, later);
          resolve({ outcome: "queued", until: o.until });
        } else reject(new Refusal(o.why ?? "the rig's supervisor did not type it"));
      };
      const timer = setTimeout(
        () =>
          done({
            id,
            outcome: "refused",
            why: "the rig's supervisor did not take it: it may be restarting. Send it again in a moment",
          }),
        this.untakenMs,
      );
      const out: AdvisorInput = {
        id,
        call,
        ...(i.text !== undefined ? { text: i.text } : { keys: [...(i.keys ?? [])] }),
        wait: i.wait,
        // An advisor in Pi's view takes it; the supervisor's other terminals refuse it in words.
        ...(i.follow_up ? { follow_up: true as const } : {}),
      };
      this.waiting.set(id, { out, taken: false, done, timer });
      for (const wake of this.takers.splice(0)) wake();
    });
  }

  private keepLater(id: string, later: ConsoleLater): void {
    this.later.set(id, later);
    if (this.later.size > LATER_MAX) this.later.delete(this.later.keys().next().value ?? "");
  }

  /**
   * The inputs waiting to be taken, at most TAKE_MAX, each handed over once; with none, the call
   * waits up to `waitMs` (at most TAKE_WAIT_MAX_MS) for one to arrive.
   */
  async take(waitMs: number): Promise<AdvisorInput[]> {
    const ready = () => [...this.waiting.values()].filter((w) => !w.taken);
    if (!ready().length && waitMs > 0)
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(waitMs, TAKE_WAIT_MAX_MS));
        this.takers.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    const out = ready().slice(0, TAKE_MAX);
    for (const w of out) {
      w.taken = true;
      clearTimeout(w.timer);
      w.timer = setTimeout(
        () =>
          w.done({
            id: w.out.id,
            outcome: "refused",
            why: `the rig's supervisor did not say in ${Math.round(this.unansweredMs / 1000)} seconds whether it typed it`,
          }),
        this.unansweredMs,
      );
    }
    return out.map((w) => w.out);
  }

  /**
   * What became of an input the supervisor took, or later of one it queued. False: none waits
   * with this id (too late).
   */
  outcome(o: AdvisorOutcome): boolean {
    const w = this.waiting.get(o.id);
    if (w) {
      w.done(o);
      return true;
    }
    const later = this.later.get(o.id);
    if (!later || (o.outcome !== "typed_after_reset" && o.outcome !== "dropped")) return false;
    this.later.delete(o.id);
    later(o.outcome, o.why);
    return true;
  }
}
