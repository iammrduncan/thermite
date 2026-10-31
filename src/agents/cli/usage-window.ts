import { log } from "../../common/log.ts";
import type { LiveKind } from "../../core/live.ts";
import { type ProviderAnswer, retryAtFrom } from "../model/index.ts";
import type { CliProgram, CliTally, CliTerminal, OwnStop } from "./program.ts";

/**
 * A full usage window in a program's own terminal (goal 169; the owner's decisions of 2026-10-27):
 * the program's session log shows its limit, and the trial waits it out instead of ending. What
 * each program does there:
 *
 * - Claude Code waits for the reset and goes on by itself (`autoContinueAtUsageLimit`, which
 *   Thermite's settings turn on), for a reset less than a day away. Its transcript gives the reset
 *   as a number, then the prompt it goes on with (`auto-continuation`). Nothing is typed into it
 *   meanwhile. If it has not gone on GO_ON_GRACE_MS after the reset, it is ended by SIGTERM,
 *   nothing typed into its screen, and its session goes on in a new terminal.
 * - Codex stops its turn at the limit and does not wait: its rollout says so, but gives the reset
 *   only in words, so the reset comes from the error answer the model proxy saw (its Retry-After,
 *   or 15 minutes for a full ChatGPT plan, which gives none). OpenCode stops its turn too, its
 *   events give the reset. For both, the harness types its continuation after the reset. (Codex
 *   0.162.1 does not know a full ChatGPT plan's code as a usage limit: its turn ends with an error,
 *   and the loop's wait for a provider's error does the same, the owner's input held meanwhile.)
 *
 * The wait is the run's (`agents_wait_for_limit`, through `waiting`): no new trial or plan of the
 * run starts before the reset, and a research run's clock stops. The trial ends instead, as at a
 * full window headless, when the limit gives no reset (the security review's rule: nothing is
 * typed into a program that may show a menu), when the reset is more than a day away (a weekly
 * window: Claude Code then opens a menu that waits for a key), when it comes after the trial's own
 * end, or when the rig drains. The owner's input queued for the reset (console.ts) goes in once the
 * log shows the program at work again.
 */

/**
 * The longest wait for a reset that a trial waits out in its terminal: Claude Code goes on by
 * itself only for a reset less than a day away, and a longer one is a weekly window, which ends
 * the trial (the owner's decision of 2026-10-27).
 */
export const TERMINAL_WAIT_MAX_MS = 24 * 3_600_000;

/**
 * How long after the reset a program that goes on by itself is given to do so: Claude Code went on
 * 40 s after the reset in goal 169's spike.
 */
export const GO_ON_GRACE_MS = 3 * 60_000;

/**
 * What a run in its program's own terminal learns of its provider from whoever runs it (the
 * harness's model proxy): the newest error answer it saw for the run since `since` (ms), who is
 * told of each wait, and how long a wait really lasts (tests shorten it).
 */
export interface WindowLink {
  providerAnswer?:
    | ((since: number) => (ProviderAnswer & { body?: string | undefined }) | undefined)
    | undefined;
  waiting?: ((w: { until: string; kind: "rate_limit"; words: string }) => void) | undefined;
  pauseMs?: ((ms: number) => number) | undefined;
}

/** What the wait takes from the trial loop, or from a call (call.ts). */
export interface WindowDeps extends WindowLink {
  signal?: AbortSignal | undefined;
  /** Whether the rig drains: a run that waits for its usage window ends. */
  draining?: (() => boolean) | undefined;
  /** How often the log is read (tests make it short). */
  pollMs?: number | undefined;
  /** Lines for the live view. */
  live(entries: { kind: LiveKind; text: string }[]): void;
}

/** What the wait needs of the role's terminal (terminal.ts's RoleTerminal). */
export interface WindowTerminal {
  /** The usage limit the program's log shows now, if any, with its reset when it gave one. */
  limitShown(): { resetsAt?: string | undefined } | undefined;
  /** Whether the program runs now. */
  running(): boolean;
  /** The reset it waits for, where its log gave none: for the console and the live view. */
  waitsUntil(at: string): void;
  /** Ends the program: while it shows a limit, by SIGTERM alone, nothing typed. */
  stop(): Promise<void>;
}

/**
 * What the trial does after the wait: it ends (`end`, the result's fields); it follows the turn
 * its program began by itself (`followed`); or its next turn is the harness's continuation, with
 * the limit's words (`goOn`).
 */
export type WindowStep = { end: OwnStop } | { followed: true } | { goOn: string };

/** The run that met the limit, as the loop (or a call, call.ts) gives it. */
export interface WindowRun {
  /** The trial's id, or the call's. */
  id: string;
  /** When the run began (ms): the model proxy's error answers since then are its. */
  since: number;
  /** The trial's end (ms), or Infinity. */
  deadline: number;
  /** The limit's words, as the log gave them. */
  words: string;
  /** One read of the program's log, and the rest of the loop's poll: the console's input too. */
  pump(): void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The trial's terminal shows a usage limit: waits it out, or says why the trial ends. */
export async function waitOutWindow(
  term: WindowTerminal,
  p: Pick<CliProgram<CliTally>, "id" | "name"> & {
    terminal: Pick<CliTerminal<CliTally>, "goesOnAfterLimit">;
  },
  deps: WindowDeps,
  r: WindowRun,
): Promise<WindowStep> {
  const now = Date.now();
  const name = p.name;
  const goesOn = p.terminal.goesOnAfterLimit === true;
  const fields = { trial: r.id, program: p.id };
  // The model proxy's answer, for a reset the log does not give (Codex).
  const answer = deps.providerAnswer?.(r.since);
  const logged = term.limitShown()?.resetsAt;
  const resetsAt =
    logged ?? (answer ? retryAtFrom(answer.body ?? "", answer.headers, now) : undefined);
  const limited = { stopped: "error", errorKind: "rate_limit" } as const;
  if (!resetsAt) {
    log("harness", `${name}'s usage limit gives no reset: the trial ends`, fields);
    return { end: { ...limited, error: r.words } };
  }
  const until = Date.parse(resetsAt);
  const ends = (why: string): WindowStep => {
    log("harness", `${name}'s usage window is full: the trial ends`, { ...fields, why });
    return {
      end: {
        ...limited,
        retryAfter: resetsAt,
        error: `${name}'s usage window is full until ${resetsAt}, ${why} (${r.words})`,
      },
    };
  };
  if (until - now > TERMINAL_WAIT_MAX_MS) return ends("more than a day away");
  if (until > r.deadline) return ends("after the trial's own end");
  if (deps.draining?.()) return ends("and the rig drains");
  log("harness", `${name} waits for its usage window's reset in its terminal`, {
    ...fields,
    until: resetsAt,
    goesOn: goesOn ? "by itself" : "the harness types its continuation",
  });
  if (!logged) term.waitsUntil(resetsAt);
  deps.waiting?.({ until: resetsAt, kind: "rate_limit", words: r.words });
  const pause = deps.pauseMs ?? ((ms: number) => ms);
  const reset = now + pause(Math.max(0, until - now));
  const giveUp = reset + pause(GO_ON_GRACE_MS);
  for (;;) {
    await sleep(deps.pollMs ?? 1000);
    r.pump();
    if (deps.signal?.aborted) return { end: { stopped: "interrupted" } };
    // At work again: it went on by itself, or the owner's input sent now began a turn.
    if (!term.limitShown()) {
      log("harness", `${name} is at work again after its usage window`, fields);
      return { followed: true };
    }
    const t = Date.now();
    if (t >= r.deadline) return { end: { stopped: "wall" } };
    if (deps.draining?.()) return ends("and the rig drains");
    if (goesOn && term.running()) {
      if (t < giveUp) continue;
      const why = `${name} did not go on by itself after its usage window reset: it is ended, and its session goes on in a new terminal`;
      log("harness", why, fields);
      deps.live([{ kind: "status", text: why }]);
      await term.stop();
      return { goOn: r.words };
    }
    if (t >= reset) {
      log("harness", `${name}'s usage window reset: its continuation is typed`, fields);
      return { goOn: r.words };
    }
  }
}
