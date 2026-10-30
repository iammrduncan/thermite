import { createServer } from "node:net";
import { join } from "node:path";
import {
  newSessionTally,
  readNew,
  type SessionEvent,
  type SessionLogAdapter,
  tallyEvents,
} from "../../../agents/programs/index.ts";
import { errorText, Refusal } from "../../../common/errors.ts";
import { log, logWarn } from "../../../common/log.ts";
import type { LaneLimitValues } from "../../../core/contract.ts";
import { MAX_RUN_MS } from "../../../core/kit.ts";
import { type LiveKind, liveText, summarizeArgs } from "../../../core/live.ts";
import { SCREEN_DATA_MAX } from "../../../core/screens.ts";
import type { TerminalKey } from "../../../core/terminal-input.ts";
import type { Runner, RunOutcome } from "../../broker/index.ts";
import {
  DEFAULT_COLS,
  DEFAULT_ROWS,
  type ScreenSnapshot,
  startTerminal,
  type Terminal,
  type TerminalEnded,
} from "../../terminal/index.ts";
import type { CliProgram, CliRun, CliTally } from "./program.ts";

/**
 * The trial loop's terminal mode (goal 169): a program in its own terminal UI, held by the
 * terminal host (src/harness/terminal/), which the broker runs as the lane's user under the lane's
 * limits, instead of one headless run for each turn. One host holds the program while it runs: its
 * first message is typed into it once it is ready, never put on its command line, which other
 * processes on the rig can read, and each later turn once the turn before has ended.
 *
 * What happened comes from the program's session log, which the host copies where the harness may
 * read it (OpenCode's events come from Thermite's plugin, in the trial's signals file), read with
 * the program's adapter into the tally the headless reader fills. A turn has ended when the log
 * says so and nothing begins for SETTLE_MS: never from the screen. A program that exits by itself
 * is resumed in a new host at the next turn, as a headless run's session is continued (one going
 * on by itself after a usage window is followed: usage-window.ts). At the trial's end, a stop or
 * its submission, the loop keeps the last screen in memory (for the live view; no decision reads
 * it), and the host ends the program its own way. The owner's console (console.ts) types into the
 * same host, one input at a time with the loop's own.
 */

/** How long a turn's end must stand in the log before the loop takes it: a late line reopens it. */
const SETTLE_MS = 1_000;
/**
 * Text typed in pieces of at most this many characters: one request to the host holds at most
 * 132 KiB, and a character can take 6 bytes of JSON.
 */
const TYPE_PIECE = 16 * 1024;
/**
 * A new host's program is typed into once it has written something and then nothing for
 * READY_STILL_MS, or after READY_MAX_MS: how much it wrote only times the typing.
 */
const READY_STILL_MS = 750;
const READY_MAX_MS = 20_000;
/** The lines above the screen kept at the end, for the live view after the trial. */
const SCREEN_SCROLLBACK = 500;

/** A snapshot's last SCREEN_DATA_MAX characters: a longer one starts in its scrollback. */
const kept = (s: ScreenSnapshot): ScreenSnapshot =>
  s.data.length > SCREEN_DATA_MAX ? { ...s, data: s.data.slice(-SCREEN_DATA_MAX) } : s;
/**
 * How long past the trial's end the broker lets a host run (at most a day in all, the broker's
 * longest run): the loop's own end of the program comes first.
 */
const BACKSTOP_MS = 60_000;

/** How a run of the program ended, as the loop reads it: its turn, its program, or a limit. */
export type RunEnd = Pick<RunOutcome, "exitCode" | "signal" | "killedFor"> &
  Partial<Pick<RunOutcome, "peakRssBytes" | "peakDiskBytes" | "peakEntries">>;

/** A turn that ended in the log, the program still running. */
const TURN_ENDED: RunEnd = { exitCode: 0, signal: null, killedFor: null };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A port on localhost that is free now, for a program's own server (OpenCode's). */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const a = s.address();
      s.close(() => (a && typeof a === "object" ? resolve(a.port) : reject(new Error("no port"))));
    });
  });
}

/** Text typed into the program, then Enter: in pieces, Enter after the last. */
async function typeIn(host: Terminal, text: string): Promise<void> {
  for (let at = 0; at < text.length; ) {
    let end = Math.min(at + TYPE_PIECE, text.length);
    // A character in two halves stays whole.
    if (end < text.length && /[\uD800-\uDBFF]/.test(text.charAt(end - 1))) end--;
    await host.type(text.slice(at, end), end >= text.length);
    at = end;
  }
}

/** Once the program has written and then been still, or after READY_MAX_MS, or it has ended. */
async function ready(host: Terminal, stopping: () => boolean): Promise<void> {
  const until = Date.now() + READY_MAX_MS;
  let output = -1;
  let since = Date.now();
  while (Date.now() < until && !stopping()) {
    const st = await host.status();
    if (st.state !== "running") return;
    if (st.output !== output) {
      output = st.output;
      since = Date.now();
    } else if (output > 0 && Date.now() - since >= READY_STILL_MS) return;
    await sleep(100);
  }
}

/** What the terminal mode takes from the loop. */
export interface TerminalTrialDeps<T extends CliTally> {
  runner: Runner;
  /** Where the program works, and its environment as a headless run has it. */
  cwd: string;
  env: Record<string, string>;
  limits: LaneLimitValues;
  /** The trial's signals file, where OpenCode's events are. */
  signalsFile: string;
  /** The tally the loop reads, which the session log fills. */
  tally: T;
}

/** One trial's program in its own terminal: one host at a time, for as long as the trial runs. */
export class TerminalTrial<T extends CliTally> {
  private readonly p: CliProgram<T>;
  private readonly run: CliRun;
  private readonly o: TerminalTrialDeps<T>;
  private readonly adapter: SessionLogAdapter<unknown>;
  private readonly state: unknown;
  /** The log's events added up, as the headless readers count them. */
  private readonly counts = newSessionTally();
  private readonly logFile: string;
  private next = 0;
  private host: Terminal | undefined;
  /** The run under way: resolves with how it ended, once. */
  private ends: ((e: RunEnd) => void) | undefined;
  private giving: Promise<void> | undefined;
  /** Since its text went in: a turn began, one is open, and when the last one ended. */
  private began = false;
  private open = false;
  private endedAt: number | undefined;
  private failure: string | undefined;
  private stopping = false;
  /**
   * The usage limit the log showed last, with its reset, until a turn begins: meanwhile the program
   * is ended by SIGTERM alone (its screen may take any key as an answer: a menu that buys more).
   */
  private limit: { resetsAt?: string | undefined } | undefined;
  /** The program's last screen, once it ended or was ended, and the host it was taken from. */
  private last: ScreenSnapshot | undefined;
  private lastOf: Terminal | undefined;
  /** What is typed into the program, one input at a time: the loop's turns and the owner's. */
  private typing: Promise<unknown> = Promise.resolve();

  constructor(p: CliProgram<T>, run: CliRun, o: TerminalTrialDeps<T>) {
    this.p = p;
    this.run = run;
    this.o = o;
    this.adapter = p.terminal.log.adapter();
    this.state = this.adapter.newState();
    this.logFile =
      p.terminal.log.from === "signals" ? o.signalsFile : join(run.area, this.copyName());
  }

  /** The host's copy of the session log, in the trial's area. */
  private copyName(): string {
    return `${this.p.prefix}-session.jsonl`;
  }

  private fields(more: Record<string, unknown> = {}): Record<string, unknown> {
    return { trial: this.run.trialId, program: this.p.id, ...more };
  }

  /** Before the first run (Claude Code: its version); else why not, in words. */
  async prepare(): Promise<string | undefined> {
    if (!this.p.exe()) return this.p.exitWords(127, `${this.p.bin()}: not found`, "");
    return this.p.terminal.prepare?.(this.run, this.o.runner);
  }

  /** Why the terminal could not run, once, when it could not: the trial ends with it. */
  takeFailure(): string | undefined {
    const f = this.failure;
    this.failure = undefined;
    return f;
  }

  /**
   * One run: `text` is typed into the program, running, or in a new host (a new session, or one
   * that resumed its session after the program exited) once it is ready. Resolves when the log
   * says the turn has ended, when the program has, or after a stop.
   */
  turn(text: string, remaining: number): Promise<RunEnd> {
    this.began = false;
    this.open = false;
    this.endedAt = undefined;
    const ended = new Promise<RunEnd>((resolve) => {
      this.ends = resolve;
    });
    this.giving = this.give(text, remaining).catch((err) =>
      this.fail(`${this.p.name} could not run in its terminal: ${errorText(err)}`),
    );
    return ended;
  }

  /**
   * A run in which nothing is typed: the turn its program began by itself (Claude Code after its
   * usage window reset), or the owner's input did. Resolves as `turn` does; at once without one.
   */
  follow(): Promise<RunEnd> {
    const ended = new Promise<RunEnd>((resolve) => (this.ends = resolve));
    if (!this.host) this.settle({ exitCode: null, signal: null, killedFor: null });
    return ended;
  }

  /** Whether its program runs now: a host holds it, and it is not being ended. */
  running(): boolean {
    return this.host !== undefined && !this.stopping;
  }

  /** It waits for its provider until `at`, which its log did not say: the console holds input. */
  waitsUntil(at: string): void {
    this.limit = { resetsAt: this.limit?.resetsAt ?? at };
  }

  private settle(e: RunEnd): void {
    const ends = this.ends;
    this.ends = undefined;
    ends?.(e);
  }

  /** The run under way failed before its program could: the trial ends with why. */
  private fail(why: string): void {
    if (!this.ends) return;
    this.failure = why;
    logWarn("harness", why, this.fields());
    this.settle({ exitCode: null, signal: null, killedFor: null });
  }

  private async give(text: string, remaining: number): Promise<void> {
    let host = this.host;
    const started = !host;
    if (!host) {
      host = await this.startHost(this.counts.session, remaining);
      if (this.stopping) return;
    }
    try {
      if (started) await ready(host, () => this.stopping);
      if (!this.stopping && this.host === host) await this.typed(() => typeIn(host, text));
    } catch (err) {
      // The program ended meanwhile: its end settles the run, and the next turn resumes it.
      const gone = await Promise.race([host.done.then(() => true), sleep(2_000).then(() => false)]);
      if (!gone) throw err;
    }
  }

  /** A host for a new session, or one resumed. */
  private async startHost(resumed: string | undefined, remaining: number): Promise<Terminal> {
    const p = this.p;
    const exe = p.exe() ?? p.bin();
    const session = resumed ?? p.terminal.newSession?.() ?? "";
    const plan = p.terminal.start(this.run, {
      cwd: this.o.cwd,
      session,
      resume: resumed !== undefined,
      port: p.terminal.server ? await freePort() : undefined,
    });
    const limits = this.o.limits;
    const host = await startTerminal(this.o.runner, {
      role: this.run.role,
      area: this.run.area,
      env: { ...this.o.env, ...plan.env },
      start: {
        trial: this.run.trialId,
        program: p.id,
        argv: [exe, ...plan.args],
        cwd: this.o.cwd,
        seeds: plan.seeds,
        ...(plan.token !== undefined ? { token: plan.token } : {}),
        ...(plan.log ? { mirror: { ...plan.log, to: this.copyName() } } : {}),
        ...(plan.server
          ? { server: { argv: [exe, ...plan.server.args], port: plan.server.port } }
          : {}),
      },
      // The loop ends the program at the trial's end; the broker only if that fails.
      ...(Number.isFinite(remaining)
        ? { timeoutMs: Math.min(MAX_RUN_MS, Math.ceil(remaining) + BACKSTOP_MS) }
        : {}),
      rssLimitBytes: limits.runRssMib * 1024 * 1024,
      spareExe: exe,
      disk: { path: this.run.area, limitBytes: limits.workspaceMib * 1024 * 1024 },
      nproc: limits.processes,
    });
    this.host = host;
    log(
      "harness",
      `${p.name} started in its terminal`,
      this.fields({ session: session || undefined, resumed: resumed !== undefined }),
    );
    void host.done.then((e) => this.hostEnded(host, e));
    return host;
  }

  /** The host ended: the program exited, by itself or ended, and the run under way with it. */
  private hostEnded(host: Terminal, e: TerminalEnded): void {
    if (this.host === host) this.host = undefined;
    const exit = e.exit;
    // A program that exited by itself leaves its screen's last lines.
    if (this.lastOf !== host && exit?.screen?.length)
      this.last = { cols: DEFAULT_COLS, rows: DEFAULT_ROWS, data: exit.screen.join("\r\n") };
    log(
      "harness",
      `${this.p.name}'s terminal ended`,
      this.fields({ how: exit?.how, code: exit?.code, killedFor: e.outcome.killedFor }),
    );
    // Its last words on the screen and its error, for the words of a failure, as a headless
    // run's last lines of output are.
    const notes = [...(exit?.screen ?? []), ...(exit?.error ? [exit.error] : [])];
    if (notes.length) this.o.tally.notes = notes.slice(-5).map((l) => l.slice(0, 500));
    this.settle({
      exitCode: exit ? exit.code : e.outcome.exitCode,
      signal: exit ? exit.signal : e.outcome.signal,
      killedFor: e.outcome.killedFor,
      peakRssBytes: e.outcome.peakRssBytes,
      peakDiskBytes: e.outcome.peakDiskBytes,
      peakEntries: e.outcome.peakEntries,
    });
  }

  /**
   * What the session log said since the last read: into the tally (as the headless reader fills
   * it), the live view's lines, and the end of the turn under way. `more`: the read stopped at its
   * size, and the log holds more now.
   */
  read(): { live: { kind: LiveKind; text: string }[]; lines: number; more: boolean } {
    const r = readNew(this.logFile, this.next);
    this.next = r.next;
    const lines = r.lines.filter((l) => l.trim());
    const live: { kind: LiveKind; text: string }[] = [];
    if (lines.length) {
      const events = this.adapter.read(lines, this.state);
      tallyEvents(this.counts, events, this.adapter.turns);
      for (const e of events) {
        this.p.terminal.take?.(e, this.o.tally, live.length);
        this.liveOf(e, live);
        if (e.type === "limit") this.limit = { resetsAt: e.resetsAt };
        else if (e.type === "turn.ended" && e.reason === "limit") this.limit ??= {};
        if (e.type === "turn.started") {
          this.began = true;
          this.open = true;
          this.endedAt = undefined;
          this.limit = undefined;
        } else if (e.type === "turn.ended") {
          this.open = false;
          this.endedAt = Date.now();
        }
      }
      this.fill();
    }
    if (
      this.ends &&
      this.began &&
      !this.open &&
      this.endedAt !== undefined &&
      Date.now() - this.endedAt >= SETTLE_MS
    )
      this.settle(TURN_ENDED);
    return { live, lines: lines.length, more: r.more };
  }

  /** The loop's tally, from the log's counts: the same fields a headless reader fills. */
  private fill(): void {
    const t = this.o.tally;
    const c = this.counts;
    t.turns = c.turns;
    t.toolCalls = c.toolCalls;
    t.tokensIn = c.tokensIn;
    t.tokensOut = c.tokensOut;
    if (c.session) t.session = c.session;
    t.lastText = c.lastText;
    t.tools.push(...c.tools.splice(0));
    t.errors.push(...c.errors.splice(0));
    t.calls.push(...c.calls.splice(0));
  }

  /** An event's line in the live view, as a headless reader shows the same. */
  private liveOf(e: SessionEvent, live: { kind: LiveKind; text: string }[]): void {
    if (e.type === "assistant.text" && e.text) live.push({ kind: "text", text: liveText(e.text) });
    else if (e.type === "tool.call")
      live.push({ kind: "tool", text: liveText(`${e.name} ${summarizeArgs(e.input)}`) });
    else if (e.type === "tool.result") {
      const tool = this.counts.names.get(e.id) ?? "tool";
      live.push({
        kind: "result",
        text: `${tool}${e.ok === false ? " failed" : ""}: ${e.output.slice(0, 1200)}`,
      });
    } else if (e.type === "turn.ended" && (e.reason === "error" || e.reason === "limit"))
      live.push({ kind: "text", text: liveText(`(${this.p.name}: ${e.error ?? e.reason})`) });
  }

  /** The usage limit the program's log shows now, if any, with its reset when it gave one. */
  limitShown(): { resetsAt?: string | undefined } | undefined {
    return this.limit;
  }

  /** `work` once what was typed before it has gone in. */
  private typed<R>(work: () => Promise<R>): Promise<R> {
    const next = this.typing.then(work);
    this.typing = next.catch(() => undefined);
    return next;
  }

  /**
   * The owner's input (terminal_input), into the program now: text, then Enter, or keys by name,
   * after what the loop is typing. Refused in words when no program runs: it is being ended, or
   * it exited and starts again in its session at the trial's next turn; and with follow_up, which
   * only a worker in Pi takes.
   */
  async ownerInput(i: {
    text?: string | undefined;
    keys?: readonly TerminalKey[] | undefined;
    follow_up?: true | undefined;
  }) {
    const host = this.host;
    if (i.follow_up)
      throw new Refusal(
        `follow_up is for a worker in Pi: ${this.p.name} takes what is typed into it as it comes`,
      );
    if (this.stopping) throw new Refusal(`${this.p.name} is being ended: nothing more goes in`);
    if (!host)
      throw new Refusal(
        `${this.p.name} is not running now: it starts again in its session at the trial's next turn`,
      );
    await this.typed(() =>
      i.text !== undefined ? typeIn(host, i.text) : host.keys([...(i.keys ?? [])]),
    );
  }

  /**
   * The program's screen now, for the live view, or its last one once it has ended; undefined
   * before it drew one. Only ever shown: no decision reads it.
   */
  async screen(): Promise<ScreenSnapshot | undefined> {
    const host = this.host;
    if (host && !this.stopping) {
      try {
        return await host.snapshot(0);
      } catch {
        // It ended meanwhile: its last screen.
      }
    }
    return this.last;
  }

  /** The program's last screen, kept in memory when the trial ended. */
  lastScreen(): ScreenSnapshot | undefined {
    return this.last;
  }

  /**
   * Ends the program its own way, its screen kept first: its turn interrupted when one is under
   * way, then its end steps (`/exit`, then SIGTERM); while it shows a usage limit, by SIGTERM
   * alone, nothing typed. If the host can't be asked, the broker ends the lane's processes.
   * Resolves once the host has ended, and so has the run under way.
   */
  async stop(): Promise<void> {
    this.stopping = true;
    await this.giving;
    const host = this.host;
    if (host) {
      await this.keepScreen(host);
      const typing = !this.limit;
      try {
        if (this.open && typing) await host.interrupt();
        await host.end({ steps: typing });
      } catch (err) {
        logWarn("harness", `could not end ${this.p.name} its own way`, {
          ...this.fields(),
          error: errorText(err),
        });
        await this.o.runner.killRole(this.run.role).catch(() => 0);
      }
      await host.done;
    }
    this.settle({ exitCode: null, signal: null, killedFor: null });
    this.stopping = false;
  }

  /** The screen and the lines above it, kept in memory before the program is ended. */
  private async keepScreen(host: Terminal): Promise<void> {
    try {
      this.last = kept(await host.snapshot(SCREEN_SCROLLBACK));
      this.lastOf = host;
    } catch (err) {
      logWarn("harness", `could not keep ${this.p.name}'s screen`, {
        ...this.fields(),
        error: errorText(err),
      });
    }
  }
}
