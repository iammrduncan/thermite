import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { LiveKind } from "../../core/live.ts";
import type { CallUsage } from "../../core/usage.ts";
import { CliCompactions, type OnceKeeping } from "../compaction/index.ts";
import type { McpAccess } from "../mcp/index.ts";
import type { ModelConfig } from "../model/index.ts";
import { type PlanWindows, SIGNALS_VAR } from "../programs/index.ts";
import { messageText, type Prompt } from "../prompt.ts";
import type { RoleRunner } from "../runner.ts";
import { TrialConsole } from "./console.ts";
import { type MessageInbox, TrialSignals, type TurnDelivery, TurnMessages } from "./in-turn.ts";
import type { CliProgram, CliRun, CliTally } from "./program.ts";
import { setUp, takeUsage } from "./shared.ts";
import { RoleTerminal } from "./terminal.ts";
import { type WindowLink, waitOutWindow } from "./usage-window.ts";

/**
 * A call of a role outside a trial in its program's own terminal (goal 169; the owner's decision
 * of 2026-10-31): a planner's, on the one path every role takes there (terminal.ts; a planner in
 * Pi takes the same link to its Pi view, src/harness/agents/planner/view.ts). It is a CliRun of
 * the program's own entry, as a trial is, in a folder of its own under the lanes' area, run as
 * the role's user: its prompt is typed in, the owner's messages go in inside its turn through its
 * hooks or Thermite's plugin, the owner's console types into it, Live shows its screen, and a full
 * usage window is waited out as a trial's is. It ends when its first turn does (one an owner's
 * message sent on at its end goes on), with the tally of its session log; its answer is its last
 * text, or the newest text that ends one of its turns and that its caller takes as an answer
 * (`answer`): the owner may type into it, and its turn that answers the owner in other words is
 * not its answer.
 */

/** A fresh folder for one call, which its user will own, removed when the call ends. */
export function callFolder(scratchDir: string, prefix: string): string {
  // The program finds its home by name, so the folder must be reachable by name: under the lanes'
  // area, not the controller's own (which only its processes may walk).
  const parent = join(scratchDir, "lanes", `${prefix}-ask`);
  mkdirSync(parent, { recursive: true, mode: 0o711 });
  chmodSync(parent, 0o711);
  const dir = join(parent, randomUUID());
  mkdirSync(dir, { mode: 0o700 });
  return dir;
}

/** A later turn of the call, as its role puts it: an owner's message, or what it goes on from. */
export type CallTurn =
  | { kind: "owner"; id: number; text: string }
  | { kind: "failed"; words: string };

/** What a call in its own terminal takes from its caller: its id, its credential and its links. */
export interface CallLink extends WindowLink {
  /** Its id for the console and the screens (plannerCallId). */
  id: string;
  /**
   * Its credential, bound to it (`call.<token>`): for the model proxy, the MCP gateway and the turn
   * routes, until the call ends.
   */
  auth: string;
  /** The title its kept conversations get: "The planner". */
  title: string;
  /** The owner's messages for it, which its hooks or plugin take inside its turn. */
  messages?: MessageInbox | undefined;
  /** One later turn, as its role puts it, at `n`, its place in the call. */
  turn(t: CallTurn, n: number): Prompt;
  /** Keeps each later turn as it is sent (goal 166). */
  sent?: ((p: Prompt) => void) | undefined;
  /** Lines for its live source, from its session log. */
  live(entries: { kind: LiveKind; text: string }[]): void;
  /** Given its console when its terminal starts, and undefined when it ends. */
  console(c: TrialConsole | undefined): void;
  /** Lets its hooks or plugin take the owner's messages inside its turn; undefined at its end. */
  inTurn(d: TurnDelivery | undefined): void;
  /** Whether the rig drains: a call that waits for its usage window ends. */
  draining?: (() => boolean) | undefined;
  /** How often its session log is read (tests make it short). */
  pollMs?: number | undefined;
}

/** What a call in its own terminal takes from its caller's runtime. */
export interface CallDeps {
  runner: RoleRunner;
  /** The API as the call's user reaches it, for example http://127.0.0.1:8700. */
  apiUrl: string;
  /** Where its folder is made (callFolder). */
  scratchDir: string;
}

/** What a call in its terminal is: who runs it, what it may use, and where its usage goes. */
export interface TerminalCallOptions {
  role: string;
  link: CallLink;
  signal?: AbortSignal | undefined;
  /** The MCP servers it may use, and whether Thermite's own (the knowledge base's) too. */
  mcp?: Pick<McpAccess, "servers" | "kb"> | undefined;
  /** Where its conversation is kept before each compaction, and who records it (goal 070). */
  compaction?: OnceKeeping | undefined;
  /** The tools it may use, in a program that takes a list (Claude Code's; "": none). */
  tools?: string | undefined;
  /** Each model usage its session log reports (goal 075), and its subscription's windows. */
  usage?: ((u: CallUsage) => void) | undefined;
  windows?: ((w: PlanWindows) => void) | undefined;
  /**
   * Whether a turn's last text is an answer (a planner's: it holds a plan). The newest one taken is
   * the tally's last text; none taken, or no `answer`: its last text, as the log said it.
   */
  answer?: ((text: string) => boolean) | undefined;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One prompt through `p` in its own terminal, as `o.role`; returns what its session log said. */
export async function terminalCall<T extends CliTally>(
  p: CliProgram<T>,
  model: ModelConfig,
  prompt: string,
  deps: CallDeps,
  o: TerminalCallOptions,
): Promise<T> {
  const link = o.link;
  const dir = callFolder(deps.scratchDir, p.prefix);
  const run: CliRun = {
    id: link.id,
    role: o.role,
    title: link.title,
    model,
    apiUrl: deps.apiUrl,
    area: dir,
    home: join(dir, `${p.prefix}-home`),
    tmp: join(dir, `${p.prefix}-tmp`),
    auth: link.auth,
    // Its MCP servers at the gateway, with its own credential (goal 068).
    mcp:
      o.mcp?.servers.length || o.mcp?.kb
        ? { apiUrl: deps.apiUrl, auth: link.auth, servers: o.mcp.servers, kb: o.mcp.kb }
        : undefined,
    keptAt: o.compaction?.keptAt,
    wallMs: undefined,
    env: undefined,
    tools: o.tools,
  };
  const signalsFile = join(dir, `${p.prefix}-signals.jsonl`);
  const tally = p.newTally();
  // Its caller's group enters the folder: the host's socket, the copy of its log, its signals.
  await deps.runner.handOver(dir, o.role, { harnessReads: true });
  try {
    const setupError = await setUp(p.name, p.setup(run), deps.runner, { role: o.role, cwd: dir });
    if (setupError) {
      tally.errors.push(setupError);
      return tally;
    }
    if (o.signal?.aborted) return tally;
    const env = {
      ...p.env(run),
      [p.eventsVar]: join(dir, `${p.prefix}-events.jsonl`),
      ...(p.signals ? { [SIGNALS_VAR]: signalsFile } : {}),
    };
    const term = new RoleTerminal(p, run, {
      runner: deps.runner,
      cwd: dir,
      env,
      signalsFile,
      tally,
    });
    const unprepared = await term.prepare();
    if (unprepared) {
      tally.errors.push(unprepared);
      return tally;
    }
    await converse(p, term, run, { prompt, signalsFile, tally }, o);
  } finally {
    link.console(undefined);
    link.inTurn(undefined);
    await deps.runner.killRole(o.role).catch(() => 0);
    await deps.runner.remove(dir).catch(() => undefined);
  }
  return tally;
}

/**
 * The call's turns in its terminal: its prompt, then, after a full usage window, what it goes on
 * from, until a turn ends with no limit shown, the program ends, or the call is stopped.
 */
async function converse<T extends CliTally>(
  p: CliProgram<T>,
  term: RoleTerminal<T>,
  run: CliRun,
  { prompt, signalsFile, tally }: { prompt: string; signalsFile: string; tally: T },
  o: TerminalCallOptions,
): Promise<void> {
  const link = o.link;
  const signals = p.signals ? new TrialSignals(p.signals.adapter(), signalsFile) : undefined;
  const keeping = o.compaction;
  const compactions = keeping
    ? new CliCompactions({
        title: keeping.title,
        harness: p.name,
        on: keeping.compacted,
        own: p.own(run, tally),
      })
    : undefined;
  const ownerConsole = new TrialConsole(term);
  link.console(ownerConsole);
  // Its later turns (goal 166), numbered after its first message.
  let said = 0;
  const inTurn =
    p.signals && link.messages
      ? new TurnMessages({
          inbox: link.messages,
          render: (m, n) => link.turn({ kind: "owner", id: m.id, text: m.text }, n),
          next: () => ++said,
          held: () => [],
          // None while its terminal shows a usage limit, so none sends it on before the reset.
          taking: () => !term.limitShown(),
          sent: link.sent,
          live: link.live,
          how: p.signals.how,
        })
      : undefined;
  if (inTurn) link.inTurn(inTurn);
  /** One read of its session log; true when the log holds more than it read. */
  const pump = (): boolean => {
    const r = term.read();
    ownerConsole.flush();
    signals?.read();
    if (r.live.length) link.live(r.live);
    compactions?.take(
      r.live,
      p.found(tally, { area: run.area, count: compactions.count, at: r.live.length }),
    );
    takeUsage(tally, o.usage);
    const windows = p.windows?.(tally);
    if (windows) o.windows?.(windows);
    return r.more;
  };
  let message = prompt;
  let following = false;
  for (;;) {
    const since = Date.now();
    inTurn?.open();
    const running = following ? term.follow() : term.turn(message, Number.POSITIVE_INFINITY);
    following = false;
    let done = false;
    void running.finally(() => {
      done = true;
    });
    while (!done) {
      await sleep(link.pollMs ?? 1000);
      pump();
      if (o.signal?.aborted) {
        await term.stop();
        break;
      }
    }
    const outcome = await running;
    inTurn?.close();
    while (pump()) {}
    if (o.signal?.aborted) break;
    const failed = term.takeFailure();
    if (failed) {
      tally.errors.push(failed);
      break;
    }
    // A full usage window is waited out, as a trial's is (usage-window.ts).
    if (term.limitShown()) {
      const w = await waitOutWindow(
        term,
        p,
        { ...link, signal: o.signal },
        {
          id: link.id,
          since,
          deadline: Number.POSITIVE_INFINITY,
          words: tally.errors.at(-1) ?? `${p.name} shows a usage limit`,
          pump,
        },
      );
      if ("end" in w) {
        tally.errors.push(w.end.error ?? `${p.name} stopped while it waited for its usage window`);
        break;
      }
      following = "followed" in w;
      if ("goOn" in w) {
        const next = link.turn({ kind: "failed", words: w.goOn }, ++said);
        link.sent?.(next);
        message = messageText(next);
      }
      continue;
    }
    if (outcome.exitCode !== 0 && !tally.errors.length)
      tally.errors.push(
        p.exitWords(
          outcome.exitCode ?? outcome.signal,
          tally.notes.at(-1) ?? "no output",
          tally.notes.join("\n"),
        ),
      );
    break;
  }
  await term.stop();
  ownerConsole.close("the call ended before the program's usage window reset");
  signals?.report({ trial: link.id, program: p.id });
  const answer = o.answer;
  const taken = answer ? [...term.turnTexts()].reverse().find((t) => answer(t)) : undefined;
  if (taken !== undefined) tally.lastText = taken;
}
