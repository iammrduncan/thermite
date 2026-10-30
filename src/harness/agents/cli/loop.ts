import { dirname, join } from "node:path";
import { CliCompactions } from "../../../agents/compaction/index.ts";
import { readNew, SIGNALS_VAR } from "../../../agents/programs/index.ts";
import { messageText, type Prompt } from "../../../agents/prompt.ts";
import {
  renderResearchWorker,
  renderResearchWorkerTurn,
  renderWorker,
  renderWorkerTurn,
  windowFit,
} from "../../../agents/roles/index.ts";
import { throughProxy } from "../../../core/agents.ts";
import { type LaneLimitValues, laneLimits } from "../../../core/contract.ts";
import type { Role, Runner, RunOutcome } from "../../broker/index.ts";
import { afterProgramFailure, type FailureCount, failingOf } from "../provider-errors.ts";
import { stopNudging, type TrialResult } from "../worker/index.ts";
import {
  AFTER_SUBMIT_MS,
  breachError,
  CarriedMessages,
  compareSessionLog,
  takeUsage,
  trialEnd,
  turnsUp,
} from "./common.ts";
import { TrialConsole } from "./console.ts";
import { TrialSignals, TurnMessages } from "./in-turn.ts";
import type { CliProgram, CliRun, CliSetup, CliTally, CliTrial, CliTrialDeps } from "./program.ts";
import { type RunEnd, TerminalTrial } from "./terminal.ts";
import { waitOutWindow } from "./usage-window.ts";

/**
 * Sets a program up in its run's area (or its call's folder), as the run's user: relative to that
 * folder, since the user may not walk the harness's directories by name. Undefined when it is set
 * up; else why not.
 */
export async function setUp(
  name: string,
  s: CliSetup,
  runner: Runner,
  at: { role: Role; cwd: string },
): Promise<string | undefined> {
  const r = await runner.run({
    role: at.role,
    argv: ["sh", "-c", s.script, ...(s.args ?? [])],
    cwd: at.cwd,
    timeoutMs: 30_000,
    ...(s.stdin !== undefined ? { stdin: s.stdin } : {}),
    captureBytes: 4096,
  });
  return r.exitCode === 0 ? undefined : `could not set ${name} up: ${r.stderr.slice(-300)}`;
}

/**
 * One run of a program as its run's user, in `cwd`, under the lane's limits. Its output goes to
 * its events file, which the harness follows while it runs.
 */
function startRun<T extends CliTally>(
  p: CliProgram<T>,
  runner: Runner,
  run: CliRun,
  o: {
    cwd: string;
    env: Record<string, string>;
    /** What the program is sent: the trial's first message, or a later turn (goal 166). */
    prompt: Prompt;
    session: string | undefined;
    remaining: number;
    limits: LaneLimitValues;
  },
): Promise<RunOutcome> {
  const exe = p.exe();
  // By its full path, so the broker knows the program's processes from its commands'.
  const argv = [exe ?? p.bin(), ...p.args(run, o.session)];
  const into = ` >> "$${p.eventsVar}" 2>&1`;
  return runner.run({
    role: run.role,
    argv: p.shell ? p.shell(argv, into) : ["sh", "-c", `exec "$@"${into}`, "sh", ...argv],
    cwd: o.cwd,
    env: o.env,
    // The prompt on stdin: one argument holds at most 128 KiB on Linux, and a brief has no such
    // limit (goal 171).
    stdin: p.stdin ? p.stdin(messageText(o.prompt), run) : messageText(o.prompt),
    // No time limit unless the trial has one (goal 079).
    ...(Number.isFinite(o.remaining) ? { timeoutMs: o.remaining } : {}),
    rssLimitBytes: o.limits.runRssMib * 1024 * 1024,
    // Over the memory limit, the program's commands are killed and the program carries on, as a
    // lane command under Pi would be; the trial ends only if the program alone is over.
    ...(exe ? { spareExe: exe } : {}),
    disk: { path: run.area, limitBytes: o.limits.workspaceMib * 1024 * 1024 },
    nproc: o.limits.processes,
    captureBytes: 4096,
  });
}

/**
 * One worker trial in a program: its home and configuration in the lane's own area, then the
 * program in the trial's working place until the trial ends.
 *
 * A code trial works in its workspace until the agent submits or the trial's time ends. A run that
 * ends without a submission is continued in the same session, twice at most, and after that for
 * as long as the owner's messages wait and the agent keeps working. A research trial works in its
 * lane's working area of the research folder and ends when the agent stops; a run that ends with
 * the owner's messages waiting is continued with them, for as long as they wait and the agent keeps
 * working. A program with hooks or Thermite's plugin takes an owner's message inside the agent's
 * turn, after a tool or at the turn's end (goal 169; in-turn.ts); a message still waiting when a
 * run ends goes into the continuation's prompt. A run cut short by a provider's failure waits and
 * goes on in its session. A turn cap, when the rig sets one, is kept by counting its turns.
 *
 * Headless, each run is one run of the program, which reads its prompt and exits at its turn's
 * end. In the terminal mode (`deps.terminal`, goal 169; terminal.ts) each run is one turn of the
 * program in its own terminal, which goes on running between turns: its session log, not its
 * output, fills the tally, and a later turn is typed into it. The decisions after each run are the
 * same in both, but for a full usage window, which a trial in its terminal waits out
 * (usage-window.ts).
 */
export async function runCliTrial<T extends CliTally>(
  p: CliProgram<T>,
  trial: CliTrial,
  deps: CliTrialDeps,
): Promise<TrialResult> {
  const { spec } = trial;
  const code = trial.mode === "code";
  if (!code && !p.research) throw new Error(`${p.name} runs no research trials`);
  // A research trial makes no submission, and its ends name none.
  const submitted = () => (code ? deps.submitted?.() : undefined);
  const before = code ? " before a submission" : "";
  const area = code ? (trial.spec.workspaceRoot ?? dirname(trial.spec.workspace)) : trial.area;
  const events = join(area, `${p.prefix}-events.jsonl`);
  // What its hooks or plugin say inside the agent's turn (goal 169).
  const signalsFile = join(area, `${p.prefix}-signals.jsonl`);
  const signals = p.signals ? new TrialSignals(p.signals.adapter(), signalsFile) : undefined;
  const tally = p.newTally();
  const result: TrialResult = {
    stopped: code ? "no_submission" : "finished",
    turns: 0,
    toolCalls: 0,
    tokensIn: 0,
    tokensOut: 0,
  };
  const limits = spec.limits ?? laneLimits({ lanes: { count: 1, trials_per_epoch: 1 } });
  const auth = `trial.${spec.token ?? ""}`;
  const title = `Trial ${spec.trialId} (${spec.lane})`;
  const run: CliRun = {
    trialId: spec.trialId,
    role: spec.lane as Role,
    title,
    model: deps.model,
    apiUrl: deps.apiUrl,
    area,
    home: join(area, `${p.prefix}-home`),
    tmp: join(area, `${p.prefix}-tmp`),
    auth,
    // The kit's MCP servers, and Thermite's own with the knowledge base's tools (goal 175).
    mcp:
      spec.mcpServers?.length || spec.kbWrites
        ? { apiUrl: deps.apiUrl, auth, servers: spec.mcpServers ?? [], kb: Boolean(spec.kbWrites) }
        : undefined,
    keptAt: deps.keptAt,
    wallMs: spec.wallMs,
    env: deps.env,
  };
  const env = {
    ...p.env(run),
    // What a code trial's submission takes: the workspace and the paths it may change.
    ...(code
      ? {
          THERMITE_EDITABLE_PATHS: JSON.stringify(trial.spec.editablePaths),
          THERMITE_WORKSPACE: trial.spec.workspace,
        }
      : {}),
    [p.eventsVar]: events,
    ...(signals ? { [SIGNALS_VAR]: signalsFile } : {}),
  };
  // Each compaction the program reported, with its own conversation before it (goal 070).
  const compactions = new CliCompactions({
    title,
    harness: p.name,
    on: deps.compacted,
    own: p.own(run, tally),
  });
  const setupError = await setUp(p.name, p.setup(run), deps.runner, { role: run.role, cwd: area });
  if (setupError) return { ...result, stopped: "error", error: setupError };
  const cwd = code ? trial.spec.workspace : trial.folder.work;
  const term = deps.terminal
    ? new TerminalTrial(p, run, { runner: deps.runner, cwd, env, limits, signalsFile, tally })
    : undefined;
  const unprepared = await term?.prepare();
  if (unprepared) return { ...result, stopped: "error", error: unprepared };
  // The owner's console into its terminal (goal 169), or word that its program has none.
  const ownerConsole = term ? new TrialConsole(term) : undefined;
  deps.console?.(ownerConsole ?? "headless");
  const started = Date.now();
  // A trial's length only when the campaign or the rig sets one (goal 079).
  const deadline = spec.wallMs !== undefined ? started + spec.wallMs : Number.POSITIVE_INFINITY;
  const minutes = spec.wallMs !== undefined ? Math.round(spec.wallMs / 60_000) : undefined;
  // Failed model calls in a row, rate limits in a row, and since when the calls fail (goal 079).
  const count: FailureCount = { failures: 0, rateWaits: 0 };
  // Its prompt, from its role's definition (goal 166).
  const mcpServers = run.mcp?.servers ?? [];
  // Cut to the model's window, when the route says it (decision 8).
  const fit = windowFit(deps.model.contextWindow, deps.model.compactAt);
  const sent = code
    ? renderWorker({
        program: p,
        brief: spec.brief,
        mcpServers,
        kbWrites: spec.kbWrites,
        limits,
        editablePaths: trial.spec.editablePaths,
        minutes,
        maxTurns: spec.maxTurns,
        endsAt: deadline,
        fit,
        addition: spec.addition,
      })
    : renderResearchWorker({
        program: p,
        brief: spec.brief,
        mcpServers,
        kbWrites: spec.kbWrites,
        folder: trial.folder,
        limits,
        minutes,
        fit,
        addition: spec.addition,
      });
  let message = sent;
  // In its terminal, the next run follows a turn its program began by itself: nothing is typed.
  let following = false;
  let offset = 0;
  const carried = new CarriedMessages(deps.messages);
  // The later turns of this trial (goal 166), numbered after its first message.
  let said = 0;
  // The owner's messages its hooks or plugin take inside the agent's turn (goal 169), each as
  // the role's later turn, numbered with the continuations.
  const inTurn = p.signals
    ? new TurnMessages({
        inbox: deps.messages,
        render: (text, turn) =>
          code
            ? renderWorkerTurn({ program: p.id, turn, kind: "owner", text })
            : renderResearchWorkerTurn({ program: p.id, turn, kind: "owner", text }),
        next: () => ++said,
        held: () => carried.holding(),
        taking: () => !submitted(),
        sent: deps.sent,
        live: deps.live,
        how: p.signals.how,
      })
    : undefined;
  if (inTurn) deps.inTurn?.(inTurn);
  /**
   * What a continued run goes on from: its role's later turn after a provider's error (`failed`:
   * its words), or else the one that tells it to go on, with the owner's messages that wait for it.
   */
  const goOn = (failed?: string): Prompt => {
    const at = { program: p.id, turn: ++said, owner: carried.take(tally).map((m) => m.text) };
    if (code)
      return renderWorkerTurn(
        failed !== undefined ? { ...at, kind: "failed", words: failed } : { ...at, kind: "nudge" },
      );
    return renderResearchWorkerTurn(
      failed !== undefined ? { ...at, kind: "failed", words: failed } : { ...at, kind: "go-on" },
    );
  };
  /** The program's output headless, or its session log in its terminal: into the tally. */
  const readOutput = () => {
    if (term) return term.read();
    const r = readNew(events, offset);
    offset = r.next;
    return { live: p.read(r.lines, tally), lines: r.lines.length, more: r.more };
  };
  /** Ends the program: its own way in its terminal, else by ending the lane's processes. */
  const halt = async () => {
    if (term) await term.stop();
    else await deps.runner.killRole(spec.lane).catch(() => 0);
  };
  /** One read of the output into the tally; true when the output holds more than it read. */
  const pump = (): boolean => {
    const r = readOutput();
    // Input the owner queued for a usage window's reset goes in once the log shows work again.
    ownerConsole?.flush();
    signals?.read();
    const live = r.live;
    if (live.length) deps.live(live);
    compactions.take(live, p.found(tally, { area, count: compactions.count, at: live.length }));
    takeUsage(tally, deps.modelUsage);
    carried.check(tally);
    if (r.lines) {
      deps.progress({
        turns: tally.turns,
        tool_calls: tally.toolCalls,
        tokens_in: tally.tokensIn,
        tokens_out: tally.tokensOut,
      });
      const windows = p.windows?.(tally);
      if (windows) deps.usage?.(windows);
    }
    return r.more;
  };
  for (let nudges = 0; ; nudges++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      result.stopped = "wall";
      break;
    }
    const errorsBefore = tally.errors.length;
    const progressBefore = tally.turns + tally.toolCalls;
    const callsBefore = tally.toolCalls;
    const runStarted = Date.now();
    // Claude Code's prompt file, headless only: in its terminal the message is its argument or typed.
    const unready = term ? undefined : await p.beforeRun?.(messageText(message), run, deps.runner);
    if (unready) {
      result.stopped = "error";
      result.error = unready;
      break;
    }
    // Kept whole as it is sent, the first message and each later turn (goal 166).
    if (!following) deps.sent?.(message);
    inTurn?.open();
    const running: Promise<RunEnd> = term
      ? following
        ? term.follow()
        : term.turn(messageText(message), remaining)
      : startRun(p, deps.runner, run, {
          cwd,
          env,
          prompt: message,
          session: tally.session,
          remaining,
          limits,
        });
    following = false;
    let done = false;
    void running.finally(() => {
      done = true;
    });
    let submittedAt: number | undefined;
    while (!done) {
      await new Promise((r) => setTimeout(r, deps.pollMs ?? 1000));
      pump();
      if (deps.signal?.aborted) {
        await halt();
        break;
      }
      // A submission ends the trial: its command finishes, and the agent's next reply is not waited for.
      // Without one, the trial's turns used up end it (goal 163: code trials keep the cap too).
      if (submitted()) {
        submittedAt ??= Date.now();
        if (Date.now() - submittedAt >= (deps.afterSubmitMs ?? AFTER_SUBMIT_MS)) await halt();
      } else if (turnsUp(spec, tally)) {
        await halt();
        break;
      } else if (term && Date.now() >= deadline) {
        // Headless, the broker ends the run at the trial's end; in its terminal, the loop does.
        await halt();
        break;
      }
    }
    const outcome = await running;
    inTurn?.close();
    // The rest of the run's output, a read's size at a time.
    while (pump()) {}
    // Headless only: in its terminal, its session log gave each call's usage as it came.
    if (p.closeRun && !term) {
      p.closeRun(tally);
      takeUsage(tally, deps.modelUsage);
    }
    carried.drop();
    // A run that made progress had calls that worked: the calls no longer fail (goal 079).
    if (tally.turns + tally.toolCalls > progressBefore) count.failing = undefined;
    if (deps.signal?.aborted) {
      result.stopped = "interrupted";
      break;
    }
    // Its terminal could not run (the host did not start): nothing more can.
    const failed = term?.takeFailure();
    if (failed) {
      result.stopped = "error";
      result.error = failed;
      break;
    }
    // After a submission the trial is over: messages still waiting go to the lane's next trial,
    // which can act on them.
    if (submitted()) break;
    if (turnsUp(spec, tally)) {
      result.stopped = "turns";
      result.error = `the trial reached its limit of ${spec.maxTurns} turns${before}`;
      break;
    }
    const own = p.stopAfterRun?.(tally);
    if (own) {
      Object.assign(result, own);
      break;
    }
    // A memory or disk limit ends the program with everything it ran: say which, with the figures.
    const breach = breachError(outcome, limits, p.name);
    if (breach) {
      result.stopped = "error";
      result.error = breach;
      break;
    }
    // In its terminal, a full usage window is waited out, or the trial ends (usage-window.ts).
    if (term?.limitShown()) {
      const w = await waitOutWindow(term, p, deps, {
        trialId: run.trialId,
        since: runStarted,
        deadline,
        words: tally.errors.at(-1) ?? `${p.name} shows a usage limit`,
        pump,
      });
      if ("end" in w) {
        Object.assign(result, w.end);
        break;
      }
      nudges--;
      following = "followed" in w;
      if ("goOn" in w) message = goOn(w.goOn);
      continue;
    }
    if (outcome.killedFor === "timeout" || Date.now() >= deadline) {
      result.stopped = "wall";
      break;
    }
    const progressed = tally.turns + tally.toolCalls > progressBefore;
    // A run that ended with the provider's error (goal 079): by its kind, the trial ends (no
    // credits, a refused key, an unserved model, or the campaign's limit), or waits and goes on
    // in the same session. The failure is not one of the nudges.
    if (tally.errors.length > errorsBefore) {
      if (progressed) count.failures = 0;
      const step = await afterProgramFailure({
        error: tally.errors.at(-1) as string,
        answer: deps.providerAnswer?.(runStarted),
        proxied: throughProxy(deps.model.api),
        count,
        failuresInARow: limits.failuresInARow,
        deadline,
        signal: deps.signal,
        // In its terminal, the owner's input waits with a rate limit's wait (console.ts).
        waiting: (w) => {
          if (w.kind === "rate_limit") term?.waitsUntil(w.until);
          deps.waiting?.(w);
        },
        pauseMs: deps.pauseMs,
      });
      if (!("goOn" in step)) {
        Object.assign(result, trialEnd(step));
        break;
      }
      nudges--;
      message = goOn(step.goOn);
      continue;
    }
    if (outcome.exitCode !== 0 && !tally.session) {
      result.stopped = "error";
      result.error = p.exitWords(
        outcome.exitCode ?? outcome.signal,
        tally.notes.at(-1) ?? "no output",
        tally.notes.join("\n"),
      );
      break;
    }
    // A code trial is continued to get a submission (goal 079) for as long as the agent keeps
    // working (a tool call in this run), with no number unless the campaign sets
    // lanes.limits.nudges; a nudge it answers without any work ends the trial, its own choice. The
    // owner's messages continue either trial while they wait and the agent keeps working. A
    // message is read only once the agent starts on the prompt: none is ever dropped.
    const ends = code
      ? stopNudging(nudges, tally.toolCalls > callsBefore, progressed, limits.nudges, deps.messages)
      : !(progressed && deps.messages?.waiting().length);
    if (ends) break;
    message = goOn();
  }
  // In its terminal, the program is ended now, its screen kept (terminal.ts), and the owner's
  // input still waiting for a usage window's reset is dropped.
  await term?.stop();
  ownerConsole?.close("the trial ended before the program's usage window reset");
  const sub = submitted();
  if (sub) {
    result.submitted = sub;
    result.stopped = "submitted";
  } else if (result.stopped === "wall") {
    result.error = `the trial reached its ${minutes}-minute limit${before}`;
  } else if (result.stopped === "no_submission" && tally.errors.length) {
    result.error = tally.errors.at(-1);
  }
  const failing = failingOf(count);
  if (failing && !sub) result.failing = failing;
  result.turns = tally.turns;
  result.toolCalls = tally.toolCalls;
  result.tokensIn = tally.tokensIn;
  result.tokensOut = tally.tokensOut;
  if (compactions.count) result.compactions = compactions.count;
  // Headless: its session log against its output. In its terminal, the log is the tally's source.
  if (!term) compareSessionLog(p, run, tally);
  signals?.report({ trial: run.trialId, program: p.id });
  if (inTurn) deps.inTurn?.(undefined);
  return result;
}
