import { errorText } from "../../common/errors.ts";
import { SCREEN_DATA_MAX, type ScreenFrame } from "../../core/screens.ts";
import {
  TERMINAL_INPUTS_PER_MINUTE,
  type TerminalInput,
  type TerminalOutcome,
} from "../../core/terminal-input.ts";
import type { PiConsole, TrialConsole } from "../agents/index.ts";
import { LedgerError } from "../ledger/index.ts";
import type { ScreenSnapshot } from "../terminal/index.ts";
import type { HarnessService } from "./index.ts";

/**
 * The owner's consoles into the agents' terminals (goal 169), as the harness holds them: each
 * running trial's console (agents/cli/console.ts), set by its trial loop when it starts, and each
 * console of a call outside a trial (a planner's call in its own terminal), set by the call; the
 * owner's input to one (terminal_input, owner only: the command's checks are in commands.ts),
 * recorded word for word with its outcome; and the screens for control's live view, the last
 * screen of each that ended kept in memory, the newest LAST_SCREENS_KEPT. A worker in Pi's console
 * is its Pi view's, whose own side (`piView`) the worker asks for the owner's inputs over its
 * trial's routes.
 */

/**
 * A call outside a trial in its own terminal, as its console's records name it: its run, the lane
 * its records give (`planner`), and the live source its lines go to.
 */
export interface CallConsoleOf {
  run: string;
  lane: string;
  source: string;
}

/** How many ended trials and calls keep their last screen: the newest; the oldest goes first. */
export const LAST_SCREENS_KEPT = 20;

/** Why a trial that is still open has no console to type into. */
const NO_TERMINAL = {
  headless:
    "its program runs headless, with no terminal (on Edit rig, Advanced, Agent programs run: In their own terminal, for the next trials)",
  none: "its program has not started yet",
};

/** The input a command gives, as its record keeps it: its text or its keys, and its wait. */
const words = (p: TerminalInput) => ({
  ...(p.text !== undefined ? { text: p.text } : { keys: [...(p.keys ?? [])] }),
  wait: p.wait,
  ...(p.follow_up ? { follow_up: true as const } : {}),
});

/** A screen cut to SCREEN_DATA_MAX characters, its newest kept. */
const fit = (s: ScreenSnapshot) => ({
  cols: s.cols,
  rows: s.rows,
  data: s.data.length > SCREEN_DATA_MAX ? s.data.slice(-SCREEN_DATA_MAX) : s.data,
});

export class TerminalConsoles {
  private readonly svc: Pick<HarnessService, "ledger" | "live" | "clock">;
  private readonly open = new Map<string, TrialConsole | "headless">();
  /** The calls outside a trial, open or with their last screen kept, by their ids. */
  private readonly calls = new Map<string, CallConsoleOf>();
  /** The Pi views' own sides, of the trials whose worker in Pi draws one. */
  private readonly piViews = new Map<string, PiConsole>();
  /** The last screens of trials that ended, oldest first. */
  private readonly last = new Map<string, ScreenSnapshot>();
  /** When each trial took its inputs in the last minute. */
  private readonly recent = new Map<string, number[]>();

  constructor(svc: Pick<HarnessService, "ledger" | "live" | "clock">) {
    this.svc = svc;
  }

  /** A trial started: its console, or word that its program has none; a Pi view's own side. */
  set(trial: string, c: TrialConsole | "headless", piView?: PiConsole): void {
    this.open.set(trial, c);
    if (piView) this.piViews.set(trial, piView);
  }

  /**
   * A call outside a trial started in its own terminal (a planner's call): its console, under its
   * id, and a planner in Pi's own side of its Pi view. A round's second try takes its first's id,
   * whose last screen goes.
   */
  setCall(id: string, of: CallConsoleOf, c: TrialConsole, piView?: PiConsole): void {
    this.last.delete(id);
    this.calls.set(id, of);
    this.open.set(id, c);
    if (piView) this.piViews.set(id, piView);
  }

  /** The calls outside a trial whose terminals run now, for the rig's report. */
  openCalls(): { id: string; run: string; role: string }[] {
    return [...this.calls]
      .filter(([id]) => this.open.has(id))
      .map(([id, of]) => ({ id, run: of.run, role: of.lane }));
  }

  /**
   * A running trial's or call's Pi view, which its process asks for the owner's inputs; none:
   * undefined.
   */
  piView(id: string): PiConsole | undefined {
    return this.piViews.get(id);
  }

  /**
   * A trial or a call ended: its console goes, its last screen stays, the newest
   * LAST_SCREENS_KEPT.
   */
  ended(trial: string): void {
    const c = this.open.get(trial);
    this.open.delete(trial);
    this.piViews.delete(trial);
    this.recent.delete(trial);
    const screen = c && c !== "headless" ? c.lastScreen() : undefined;
    if (!screen) {
      this.calls.delete(trial);
      return;
    }
    this.last.delete(trial);
    this.last.set(trial, screen);
    for (const old of this.last.keys()) {
      if (this.last.size <= LAST_SCREENS_KEPT) break;
      this.last.delete(old);
      this.calls.delete(old);
    }
  }

  /** Whose terminal an id names: a trial's, from the ledger, or a call's; undefined: neither. */
  private whose(id: string, run: string) {
    const t = this.svc.ledger.trials.get(id);
    if (t && t.run === run)
      return { lane: t.lane, source: `trial:${id}`, ended: Boolean(t.ended_at) };
    const of = this.calls.get(id);
    if (of && of.run === run) return { lane: of.lane, source: of.source, ended: false };
    return undefined;
  }

  /**
   * terminal_input: the owner's input into one running trial's terminal, or a call's, typed now or
   * queued for its usage window's reset. Each outcome is a `terminal_input` event with the input
   * word for word: refused (with why), typed or queued now, and later typed after the reset or
   * dropped.
   */
  async input(
    p: TerminalInput,
    command: string,
    by: string,
  ): Promise<{ run: string; trial: string; lane: string; outcome: string; until?: string }> {
    const { ledger, live } = this.svc;
    const t = this.whose(p.trial, p.run);
    if (!t) throw new LedgerError("not_found", `run ${p.run} has no trial or call ${p.trial}`);
    const record = (outcome: TerminalOutcome, more: { why?: string; until?: string } = {}) =>
      ledger.appendEvent(by, "terminal_input", p.run, {
        command,
        trial: p.trial,
        lane: t.lane,
        ...words(p),
        outcome,
        ...more,
      });
    const refuse = (why: string): never => {
      record("refused", { why });
      throw new LedgerError("conflict", why);
    };
    const c = this.open.get(p.trial);
    if (t.ended || this.last.has(p.trial))
      refuse(`${p.trial} has ended: nothing more goes into its terminal`);
    if (!c || c === "headless")
      refuse(
        `trial ${p.trial} has no terminal to type into: ${NO_TERMINAL[c ? "headless" : "none"]}`,
      );
    const now = this.svc.clock().getTime();
    const times = (this.recent.get(p.trial) ?? []).filter((at) => at > now - 60_000);
    if (times.length >= TERMINAL_INPUTS_PER_MINUTE)
      refuse(
        `${p.trial} took ${TERMINAL_INPUTS_PER_MINUTE} inputs in the last minute, the most it takes: send this one again in a moment`,
      );
    this.recent.set(p.trial, [...times, now]);
    const line = (text: string) =>
      live.append({ source: t.source, kind: "status", text, lane: t.lane, run: p.run });
    let got: Awaited<ReturnType<TrialConsole["input"]>>;
    try {
      got = await (c as TrialConsole).input(p, (outcome, why) => {
        record(outcome, why ? { why } : {});
        line(
          outcome === "typed_after_reset"
            ? "the owner's input went into its terminal after the usage window's reset"
            : `the owner's input that waited for the usage window's reset was dropped: ${why ?? ""}`,
        );
      });
    } catch (err) {
      return refuse(`not typed into ${p.trial}'s terminal: ${errorText(err)}`);
    }
    const until = got.outcome === "queued" ? got.until : undefined;
    record(got.outcome, until ? { until } : {});
    line(
      got.outcome === "typed"
        ? "the owner's input went into its terminal"
        : `the owner's input waits for the usage window's reset${until ? ` (${until})` : ""}`,
    );
    return {
      run: p.run,
      trial: p.trial,
      lane: t.lane,
      outcome: got.outcome,
      ...(until ? { until } : {}),
    };
  }

  /**
   * The screens of the terminals control's viewers watch, for its live view: a running trial's or
   * call's now, an ended one's last, or `none` for one with no terminal here. Only ever shown.
   */
  async screens(trials: readonly string[]): Promise<ScreenFrame[]> {
    const at = () => this.svc.clock().toISOString();
    const out: ScreenFrame[] = [];
    for (const trial of trials) {
      const c = this.open.get(trial);
      const ended = this.last.get(trial);
      if (c && c !== "headless") {
        const s = await c.screen().catch(() => undefined);
        const limit = c.limit();
        out.push({
          trial,
          state: s ? "running" : "none",
          ...(s ? fit(s) : {}),
          ...(limit ? { limit: limit.resetsAt ? { resets_at: limit.resetsAt } : {} } : {}),
          ...(c.queued ? { queued: c.queued } : {}),
          ...(this.piViews.has(trial) ? { pi_view: true as const } : {}),
          at: at(),
        });
      } else if (ended) out.push({ trial, state: "ended", ...fit(ended), at: at() });
      else out.push({ trial, state: "none", at: at() });
    }
    return out;
  }
}
