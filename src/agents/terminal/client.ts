import { connect } from "node:net";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { errorText } from "../../common/errors.ts";
import { logDebug, logWarn } from "../../common/log.ts";
import { newToken } from "../../common/secrets.ts";
import type { TerminalKey } from "../programs/index.ts";
import type { RoleRunner, RoleRunOutcome } from "../runner.ts";
import { END_WAIT_MS, SERVER_READY_MS, TERM_WAIT_MS } from "./host.ts";
import {
  ANSWER_MAX,
  ProgramExit,
  RefusedAnswer,
  ScreenSnapshot,
  ScreenText,
  SOCKET_PATH_MAX,
  TERMINAL_SOCKET,
  TerminalStart,
  type TerminalStartInput,
  TerminalStatus,
} from "./protocol.ts";

/**
 * The caller's side of the terminal host (goal 169). It starts the host through its runner
 * (runner.ts: the harness's broker), as the role's user, and asks
 * it, over its socket, to type, interrupt, show its screen and end. The host runs as the role's
 * user, as the agent does, so each answer is read no further than ANSWER_MAX and checked against
 * its schema, and none decides anything: the program's session log and its hooks say what
 * happened.
 */

/** The host's entry, as Node runs it: main.js when built, main.ts from the source. */
export const TERMINAL_HOST = fileURLToPath(
  new URL(`./main${extname(fileURLToPath(import.meta.url))}`, import.meta.url),
);

/** How long a request may take; an end may take its steps and both its waits. */
const ASK_MS = 15_000;
const END_ASK_MS = END_WAIT_MS + TERM_WAIT_MS + 15_000;
/** How long the host has to answer once started: Node's start, its seeds, and a server's. */
export const READY_MS = SERVER_READY_MS + 30_000;
/** The tail of the host's output the broker keeps: its last line says how the program ended. */
const CAPTURE_BYTES = 64 * 1024;

/** One run of a program in its terminal, as its caller asks its runner for it. */
export interface TerminalRun {
  role: string;
  /** The run's own area: the host's working folder, its socket, the copy of the session log. */
  area: string;
  /** The program's environment, which is the host's too. */
  env: Record<string, string>;
  /** The host's start, but its secret, which the caller makes. */
  start: Omit<TerminalStartInput, "secret">;
  /** The run's limits, as a headless run of the program has them; none unless given. */
  timeoutMs?: number | undefined;
  rssLimitBytes?: number | undefined;
  disk?: { path: string; limitBytes: number } | undefined;
  nproc?: number | undefined;
  /** The program's own executable: with the host, it is spared when its commands pass the limit. */
  spareExe?: string | undefined;
}

/** A run that has ended: the broker's outcome, and how the program ended, as the host said. */
export interface TerminalEnded {
  outcome: RoleRunOutcome;
  exit: ProgramExit | undefined;
}

/** The host's last word on the program, from the tail of its output. */
function exitOf(stdout: string): ProgramExit | undefined {
  for (const line of stdout.trim().split("\n").reverse()) {
    try {
      const o = JSON.parse(line) as { msg?: unknown };
      if (o.msg !== "the program ended") continue;
      const e = ProgramExit.safeParse(o);
      return e.success ? e.data : undefined;
    } catch {
      // not a line of its log
    }
  }
  return undefined;
}

/** Why the host itself failed, from the last line of its output or its errors. */
function hostError(o: RoleRunOutcome): string {
  const last = (o.stdout.trim() || o.stderr.trim()).split("\n").at(-1) ?? "";
  try {
    const line = JSON.parse(last) as { error?: unknown };
    if (typeof line.error === "string") return line.error;
  } catch {
    // not a line of its log
  }
  return last.slice(-500) || "no output";
}

/** One request's line to the socket, and the answer's, read no further than ANSWER_MAX. */
function ask(socket: string, body: object, ms: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let buf = "";
    let settled = false;
    const s = connect(socket);
    const finish = (err: Error | undefined, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      s.destroy();
      if (err) reject(err);
      else resolve(value);
    };
    const timer = setTimeout(
      () => finish(new Error(`the terminal host did not answer within ${ms / 1000} s`)),
      ms,
    );
    s.setEncoding("utf8");
    s.on("connect", () => s.write(`${JSON.stringify(body)}\n`));
    s.on("data", (d: string) => {
      buf += d;
      const at = buf.indexOf("\n");
      if (at < 0 && buf.length <= ANSWER_MAX) return;
      if (at < 0 || at > ANSWER_MAX)
        return finish(new Error(`the terminal host's answer is over ${ANSWER_MAX} bytes`));
      try {
        finish(undefined, JSON.parse(buf.slice(0, at)));
      } catch {
        finish(new Error("the terminal host's answer is not JSON"));
      }
    });
    s.on("error", (err) => finish(err));
    s.on("close", () => finish(new Error("the terminal host closed the connection unanswered")));
  });
}

/** A running host, as its caller asks it. */
export class Terminal {
  readonly socket: string;
  /** Resolves when the run has ended: the program has, and the host. */
  readonly done: Promise<TerminalEnded>;
  private readonly secret: string;
  private readonly trial: string | undefined;

  constructor(o: {
    socket: string;
    secret: string;
    trial?: string | undefined;
    done: Promise<TerminalEnded>;
  }) {
    this.socket = o.socket;
    this.secret = o.secret;
    this.trial = o.trial;
    this.done = o.done;
  }

  private async ask<S extends z.ZodType>(
    body: Record<string, unknown>,
    schema: S,
    ms = ASK_MS,
  ): Promise<z.infer<S>> {
    logDebug("terminal", "asking the terminal host", { trial: this.trial, op: body.op });
    const raw = await ask(this.socket, { ...body, secret: this.secret }, ms);
    const refused = RefusedAnswer.safeParse(raw);
    if (refused.success) throw new Error(`the terminal host refused: ${refused.data.error}`);
    return schema.parse(raw);
  }

  status(): Promise<TerminalStatus> {
    return this.ask({ op: "status" }, TerminalStatus);
  }

  /** Text typed into the program, then Enter, sent apart, unless `enter` is false. */
  async type(text: string, enter = true): Promise<void> {
    await this.ask({ op: "type", text, enter }, Done);
  }

  async keys(keys: TerminalKey[]): Promise<void> {
    await this.ask({ op: "keys", keys }, Done);
  }

  /** The program's own steps to interrupt the agent's turn. */
  async interrupt(): Promise<void> {
    await this.ask({ op: "interrupt" }, Done);
  }

  /** The screen as plain lines. */
  screen(): Promise<ScreenText> {
    return this.ask({ op: "screen", form: "text" }, ScreenText);
  }

  /** The screen and at most `scrollback` lines above it, as a string that restores them. */
  snapshot(scrollback = 0): Promise<ScreenSnapshot> {
    return this.ask({ op: "screen", form: "snapshot", scrollback }, ScreenSnapshot);
  }

  /**
   * The program's clean end, then SIGTERM; the host exits after it answers. `steps` false: SIGTERM
   * at once, nothing typed into the program.
   */
  end(o: { steps?: boolean } = {}): Promise<ProgramExit> {
    return this.ask({ op: "end", steps: o.steps ?? true }, ProgramExit, END_ASK_MS);
  }
}

/** An answer with nothing in it but that it was done. */
const Done = z.object({ ok: z.literal(true) });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Starts a program in its terminal: the host, through its runner, as `r.role`, in `r.area`, with
 * its start (and a secret of its own) on its stdin; then waits until the host answers and the
 * program has started, or failed to. If the host never answers, the role's processes are ended.
 */
export async function startTerminal(runner: RoleRunner, r: TerminalRun): Promise<Terminal> {
  const socket = join(r.area, TERMINAL_SOCKET);
  if (Buffer.byteLength(socket) > SOCKET_PATH_MAX)
    throw new Error(`the terminal host's socket would be over ${SOCKET_PATH_MAX} bytes: ${socket}`);
  const secret = newToken().token;
  const start = TerminalStart.parse({ ...r.start, secret });
  let ended: TerminalEnded | undefined;
  const done = runner
    .run({
      role: r.role,
      argv: [process.execPath, TERMINAL_HOST],
      cwd: r.area,
      env: r.env,
      stdin: JSON.stringify(start),
      ...(r.timeoutMs !== undefined ? { timeoutMs: r.timeoutMs } : {}),
      ...(r.rssLimitBytes !== undefined ? { rssLimitBytes: r.rssLimitBytes } : {}),
      ...(r.spareExe ? { spareExe: r.spareExe } : {}),
      spareRoot: true,
      ...(r.disk ? { disk: r.disk } : {}),
      ...(r.nproc !== undefined ? { nproc: r.nproc } : {}),
      captureBytes: CAPTURE_BYTES,
    })
    .then((outcome) => {
      ended = { outcome, exit: exitOf(outcome.stdout) };
      return ended;
    });
  const terminal = new Terminal({ socket, secret, trial: start.trial, done });
  const until = Date.now() + READY_MS;
  for (;;) {
    if (ended) {
      // The program ended already, before the first look: `done` says how.
      const e = ended as TerminalEnded;
      if (e.exit) return terminal;
      throw new Error(
        `the terminal host could not run (exit ${e.outcome.exitCode ?? e.outcome.signal}): ${hostError(e.outcome)}`,
      );
    }
    try {
      const st = await terminal.status();
      if (st.state !== "starting") return terminal;
    } catch (err) {
      // Not listening yet; a refusal would mean another host, which never answers ours.
      if (/refused:/.test(errorText(err)))
        logWarn("terminal", errorText(err), { trial: start.trial });
    }
    if (Date.now() > until) {
      await runner.killRole(r.role).catch(() => 0);
      throw new Error(`the terminal host did not answer within ${READY_MS / 1000} s`);
    }
    await sleep(100);
  }
}
