import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, constants, fchmodSync, mkdirSync, openSync, writeSync } from "node:fs";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import { errorText } from "../../common/errors.ts";
import { log, logWarn } from "../../common/log.ts";
import { TERMINAL_PROFILES, type TerminalKey, type TerminalStep } from "../programs/index.ts";
import { ENTER, ENTER_GAP_MS, KEY_GAP_MS, keyBytes, typedText } from "./keys.ts";
import { Mirror } from "./mirror.ts";
import type {
  HOST_STATES,
  ProgramExit,
  ScreenSnapshot,
  ScreenText,
  TerminalStart,
  TerminalStatus,
} from "./protocol.ts";
import { type PtyExit, type PtyProgram, startOnPty } from "./pty.ts";
import { Screen } from "./screen.ts";

/**
 * The terminal host's work for one run of one program (goal 169): it writes the program's seeds,
 * starts its server when it has one, starts the program on a pseudo-terminal with the screen kept
 * by the emulator, copies its session log for the harness, and types into it, interrupts it and
 * ends it as the harness asks, one input at a time. The run ends when the program does: a session
 * resumed after a crash is a new host's run. The host never answers the program's questions and
 * never reads its screen to decide anything.
 */

/** How long the program has to exit after its end steps, and then after SIGTERM. */
export const END_WAIT_MS = 10_000;
export const TERM_WAIT_MS = 5_000;
/** How long a server has to take connections before the program starts without it. */
export const SERVER_READY_MS = 30_000;
/** How long a server has to exit after SIGTERM; the broker ends what is left. */
const SERVER_STOP_MS = 3_000;
/** How often the session log is copied. */
export const MIRROR_EVERY_MS = 250;
/** The most bytes of a server's output kept, for the words of its failure. */
const SERVER_OUTPUT_MAX = 8 * 1024;
/** The screen's last lines that come with the program's end. */
const LAST_LINES = 12;

type HostState = (typeof HOST_STATES)[number];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Resolves with `p`'s value, or undefined after `ms`. */
const within = <T>(p: Promise<T>, ms: number): Promise<T | undefined> =>
  Promise.race([p, sleep(ms).then(() => undefined)]);

/** True once something on localhost takes connections on `port`, or false after `ms`. */
async function listening(port: number, ms: number, alive: () => boolean): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until && alive()) {
    const ok = await new Promise<boolean>((resolve) => {
      const s = connect({ host: "127.0.0.1", port }, () => {
        s.destroy();
        resolve(true);
      });
      s.on("error", () => resolve(false));
    });
    if (ok) return true;
    await sleep(100);
  }
  return false;
}

/**
 * Writes the seeds as the lane's user, each file never through a link, with its mode, and the
 * folders above it (0700) where they are missing.
 */
function writeSeeds(seeds: TerminalStart["seeds"]): void {
  for (const s of seeds) {
    mkdirSync(dirname(s.path), { recursive: true, mode: 0o700 });
    const fd = openSync(
      s.path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
      s.mode,
    );
    try {
      fchmodSync(fd, s.mode);
      writeSync(fd, s.content);
    } finally {
      closeSync(fd);
    }
  }
}

export class TerminalHost {
  private readonly start: TerminalStart;
  private readonly env: Record<string, string>;
  private readonly screen: Screen;
  private readonly mirror: Mirror | undefined;
  private state: HostState = "starting";
  private program: PtyProgram | undefined;
  private server: ChildProcess | undefined;
  private output = 0;
  private exit: ProgramExit | undefined;
  /** The inputs, one at a time, in the order they came. */
  private inputs: Promise<unknown> = Promise.resolve();
  private ending: Promise<ProgramExit> | undefined;
  private endedBy: ProgramExit["how"] = "by itself";
  /** An end asked for before the program started: it does not start. */
  private cancelled = false;
  /** Resolved when the host stops waiting for a program that would not end. */
  private giveUp: () => void = () => undefined;
  private readonly givenUp = new Promise<undefined>((r) => {
    this.giveUp = () => r(undefined);
  });
  /** Resolved with the program's end, once the host has it. */
  private finish: (e: ProgramExit) => void = () => undefined;
  private readonly finished = new Promise<ProgramExit>((r) => {
    this.finish = r;
  });

  /** `area`: the host's own folder, where the copy of the session log goes. */
  constructor(start: TerminalStart, env: Record<string, string>, area: string) {
    this.start = start;
    // The terminal is an xterm's; its size is the terminal's, not the environment's.
    this.env = {
      ...Object.fromEntries(Object.entries(env).filter(([k]) => k !== "COLUMNS" && k !== "LINES")),
      TERM: "xterm-256color",
    };
    this.screen = new Screen({
      cols: start.cols,
      rows: start.rows,
      scrollback: start.scrollback,
      reply: (d) => this.program?.write(d),
    });
    this.mirror = start.mirror
      ? new Mirror({ ...start.mirror, to: join(area, start.mirror.to) })
      : undefined;
  }

  private note(msg: string, fields: Record<string, unknown> = {}): void {
    log("terminal", msg, { trial: this.start.trial, program: this.start.program, ...fields });
  }

  /** The program's run, from its seeds to its end; then its server's end. */
  async run(): Promise<ProgramExit> {
    try {
      writeSeeds(this.start.seeds);
    } catch (err) {
      return this.ended(
        { code: null, signal: null, error: `its seeds: ${errorText(err)}` },
        "not started",
      );
    }
    if (this.start.server) {
      const why = await this.startServer(this.start.server);
      if (why) return this.ended({ code: null, signal: null, error: why }, "not started");
    }
    if (this.cancelled)
      return this.ended(
        { code: null, signal: null, error: "ended before it started" },
        "not started",
      );
    let program: PtyProgram;
    try {
      program = startOnPty({
        argv: this.start.argv,
        cwd: this.start.cwd,
        env: this.env,
        cols: this.start.cols,
        rows: this.start.rows,
        token: this.start.token,
        output: (d) => {
          this.output += Buffer.byteLength(d);
          this.screen.write(d);
        },
      });
    } catch (err) {
      return this.ended({ code: null, signal: null, error: errorText(err) }, "not started");
    }
    this.program = program;
    if (this.state === "starting") this.state = "running";
    this.note("the program started", {
      pid: program.pid,
      exe: this.start.argv[0],
      size: `${this.start.cols}x${this.start.rows}`,
    });
    const copying = setInterval(() => this.mirror?.step(), MIRROR_EVERY_MS);
    const e = await Promise.race([program.exited, this.givenUp]);
    clearInterval(copying);
    this.mirror?.step();
    if (!e) return this.ended({ code: null, signal: null }, "left to the broker");
    return this.ended(e, this.endedBy);
  }

  private async ended(e: PtyExit, how: ProgramExit["how"]): Promise<ProgramExit> {
    await this.stopServer();
    const lines = (await this.screen.text()).lines.filter((l) => l.trim()).slice(-LAST_LINES);
    this.exit = {
      how,
      code: e.code,
      signal: e.signal,
      ...(e.error ? { error: e.error } : {}),
      ...(lines.length ? { screen: lines } : {}),
    };
    this.state = "ended";
    // The harness reads this line from the host's output (client.ts): with the screen's last
    // lines, for the words of a failure.
    this.note("the program ended", this.exit);
    this.finish(this.exit);
    return this.exit;
  }

  /** Starts the server and waits for it to take connections; else why not, in words. */
  private async startServer(s: NonNullable<TerminalStart["server"]>): Promise<string | undefined> {
    let output = "";
    let gone = false;
    const child = spawn(s.argv[0] as string, s.argv.slice(1), {
      cwd: this.start.cwd,
      env: this.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.server = child;
    const keep = (d: Buffer) => {
      output = (output + d.toString("utf8")).slice(-SERVER_OUTPUT_MAX);
    };
    child.stdout?.on("data", keep);
    child.stderr?.on("data", keep);
    child.on("error", (err) => {
      gone = true;
      output += errorText(err);
    });
    child.on("exit", () => {
      gone = true;
    });
    if (await listening(s.port, SERVER_READY_MS, () => !gone)) {
      this.note("its server takes connections", { pid: child.pid, port: s.port });
      return undefined;
    }
    return `its server ${gone ? "exited" : `took no connection on port ${s.port} within ${SERVER_READY_MS / 1000} s`}: ${output.trim().split("\n").slice(-5).join(" | ") || "no output"}`;
  }

  /** Ends the server, which outlives the program (OpenCode's): SIGTERM, then the broker's kill. */
  private async stopServer(): Promise<void> {
    const child = this.server;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise((r) => child.once("exit", r));
    child.kill("SIGTERM");
    if (!(await within(exited, SERVER_STOP_MS)))
      logWarn("terminal", "its server did not exit after SIGTERM", { trial: this.start.trial });
  }

  status(): TerminalStatus {
    return {
      state: this.state,
      ...(this.program?.pid !== undefined ? { pid: this.program.pid } : {}),
      cols: this.start.cols,
      rows: this.start.rows,
      output: this.output,
      ...(this.mirror ? { mirror: this.mirror.state() } : {}),
      ...(this.exit ? { exit: this.exit } : {}),
    };
  }

  screenText(): Promise<ScreenText> {
    return this.screen.text();
  }

  screenSnapshot(scrollback: number): Promise<ScreenSnapshot> {
    return this.screen.snapshot(scrollback);
  }

  /** Runs `work` after the inputs before it, while the program runs. */
  private input<T>(what: string, work: (p: PtyProgram) => Promise<T>): Promise<T> {
    const next = this.inputs.then(async () => {
      const p = this.program;
      if (!p || this.state !== "running")
        throw new Error(
          `the program is ${this.state === "running" ? "not started" : this.state}: ${what} not sent`,
        );
      return work(p);
    });
    this.inputs = next.catch(() => undefined);
    return next;
  }

  private async text(p: PtyProgram, text: string, enter: boolean): Promise<void> {
    await this.screen.settled();
    p.write(typedText(text, this.screen.bracketedPaste));
    if (!enter) return;
    await sleep(ENTER_GAP_MS);
    p.write(ENTER);
  }

  private async keys(p: PtyProgram, keys: readonly TerminalKey[]): Promise<void> {
    await this.screen.settled();
    for (const [i, k] of keys.entries()) {
      if (i) await sleep(KEY_GAP_MS);
      p.write(keyBytes(k, this.screen.applicationCursor));
    }
  }

  private async steps(p: PtyProgram, steps: readonly TerminalStep[]): Promise<void> {
    for (const s of steps) {
      if ("keys" in s) await this.keys(p, s.keys);
      else if ("text" in s) await this.text(p, s.text, true);
      else await sleep(s.pauseMs);
    }
  }

  /** Text typed into the program, then Enter, sent apart, unless `enter` is false. */
  type(text: string, enter: boolean): Promise<void> {
    this.note("text typed", { chars: text.length, enter });
    return this.input("text", (p) => this.text(p, text, enter));
  }

  sendKeys(keys: readonly TerminalKey[]): Promise<void> {
    this.note("keys sent", { keys });
    return this.input("keys", (p) => this.keys(p, keys));
  }

  /** The program's own steps to interrupt the agent's turn. */
  interrupt(): Promise<void> {
    this.note("interrupt");
    return this.input("the interrupt", (p) =>
      this.steps(p, TERMINAL_PROFILES[this.start.program].interrupt),
    );
  }

  /**
   * Ends the program: its end steps (unless `steps` is false: nothing is typed), then SIGTERM,
   * then, if it still runs, the host stops waiting and the broker ends it with the run. Asked
   * again, the same end.
   */
  end(steps = true): Promise<ProgramExit> {
    if (this.state === "starting") this.cancelled = true;
    this.ending ??= this.input("the end", async (p) => {
      this.state = "ending";
      this.note("ending the program", { steps });
      // A program with no end steps (the Pi view) goes straight to SIGTERM.
      const own = TERMINAL_PROFILES[this.start.program].end;
      if (steps && own.length) {
        this.endedBy = "end steps";
        await this.steps(p, own);
        if (await within(p.exited, END_WAIT_MS)) return;
      }
      this.endedBy = "sigterm";
      p.signal("SIGTERM");
      if (await within(p.exited, TERM_WAIT_MS)) return;
      this.giveUp();
    })
      .catch(() => {
        // Not running: it has not started, it has ended, or it is ending by itself.
      })
      .then(() => this.finished);
    return this.ending;
  }
}
