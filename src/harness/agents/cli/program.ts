import type {
  FoundCompaction,
  KeptAt,
  OnCompacted,
  OwnConversation,
} from "../../../agents/compaction/index.ts";
import type { McpAccess } from "../../../agents/mcp/index.ts";
import type { ModelConfig } from "../../../agents/model/index.ts";
import type {
  PlanWindows,
  SessionEvent,
  SessionLogAdapter,
  SessionTally,
  TerminalLog,
  TerminalSeed,
} from "../../../agents/programs/index.ts";
import type { Prompt } from "../../../agents/prompt.ts";
import type { ResearchFolderPaths } from "../../../agents/tools/index.ts";
import type { Harness, InTurn } from "../../../core/agents.ts";
import type { LiveKind } from "../../../core/live.ts";
import type { CallUsage } from "../../../core/usage.ts";
import type { Role, Runner } from "../../broker/index.ts";
import type { MessageInbox, TrialProgress, TurnDelivery } from "../live-session.ts";
import type { PiConsole } from "../pi-view/index.ts";
import type { ProviderLink } from "../provider-errors.ts";
import type { ResearchTrialSpec } from "../research/index.ts";
import type { SubmitOutcome, TrialResult, TrialSpec } from "../worker/index.ts";
import type { TrialConsole } from "./console.ts";

/**
 * The agent programs that run as command-line programs (OpenCode, Claude Code, Codex), as one
 * trial loop (cli/loop.ts) and one one-prompt call (cli/once.ts) see them (goal 125, T7): each
 * program's entry holds only what differs between them, and the loop and the call do the rest.
 */

/** The agent programs that run as command-line programs, by their ids. */
export type CliHarness = Exclude<Harness, "pi">;

/**
 * A trial the loop runs: a code trial, in its workspace, which a submission ends; or a research
 * trial (in a program whose entry says it runs them), in its lane's working area of the run's
 * research folder, which ends when the agent stops. `area`: the research trial's own area in the
 * lane, for the program's home, temporary files and events.
 */
export type CliTrial =
  | { mode: "code"; spec: TrialSpec }
  | { mode: "research"; spec: ResearchTrialSpec; area: string; folder: ResearchFolderPaths };

/** What every program's output has said so far: the fields each program's tally has. */
export interface CliTally {
  turns: number;
  toolCalls: number;
  tokensIn: number;
  tokensOut: number;
  /** The session a run continues (OpenCode's and Claude Code's session, Codex's thread). */
  session?: string | undefined;
  errors: string[];
  lastText: string;
  /** Completed tool calls: their tool and what they returned (the model check reads these). */
  tools: { tool: string; output: string; ok: boolean }[];
  /** Its last lines that were not JSON. */
  notes: string[];
  /** The model usage it reported since it was last taken (goal 075). */
  calls: CallUsage[];
}

/** One trial's run of a program, as its entry sees it. */
export interface CliRun {
  trialId: string;
  /** The lane's user, which sets the program up and runs it. */
  role: Role;
  /** The title its kept conversations get: `Trial <id> (<lane>)`. */
  title: string;
  model: ModelConfig;
  /** The harness API as the lane reaches it, for example http://127.0.0.1:8700. */
  apiUrl: string;
  /** The trial's own area in the lane, and the program's home and temporary folders there. */
  area: string;
  home: string;
  tmp: string;
  /** The trial's credential: `trial.<token>`. */
  auth: string;
  /** The MCP servers the run's kit gives its workers (goal 068), at the gateway with `auth`. */
  mcp: McpAccess | undefined;
  /** Where the harness keeps the conversation before each compaction (goal 070). */
  keptAt: KeptAt | undefined;
  /** The trial's length, when one is set (goal 079). */
  wallMs: number | undefined;
  /** The lane's build caches (ccache and the like). */
  env: Record<string, string> | undefined;
}

/**
 * One one-prompt call of a program outside a trial (a planner call, a model check), as its entry
 * sees it: in a folder of its own, which the call's user owns, removed afterwards.
 */
export interface CliCall {
  model: ModelConfig;
  /** The call's folder, and the program's home and temporary folder in it. */
  dir: string;
  home: string;
  tmp: string;
  /** The harness API as the call's user reaches it, for example http://127.0.0.1:8700. */
  apiUrl: string;
  /** A credential for the harness's model proxy, minted for this call when the entry asks. */
  proxyAuth(): string;
  /** The MCP servers the call may use (a planner's), at the gateway with their credential. */
  mcp: McpAccess | undefined;
  /** Where its conversation is kept before each compaction (goal 070). */
  keptAt: KeptAt | undefined;
  /** None unless given: a planner call runs until it answers or its run stops (goal 079). */
  timeoutMs: number | undefined;
  /** The tools it may use, in a program that takes a list (Claude Code's; "": none). */
  tools: string | undefined;
}

/**
 * What a program's setup runs in the trial's area (or the call's folder), as the lane (or the
 * call's user): a shell line and its input.
 */
export interface CliSetup {
  script: string;
  /** The shell's positional arguments ($0 first). */
  args?: string[] | undefined;
  stdin?: string | undefined;
}

/** Why a program stops a trial on its own, after a run (Claude Code: a full usage window). */
export type OwnStop = Pick<TrialResult, "stopped" | "error" | "errorKind" | "retryAfter">;

/**
 * One program, as the trial loop and the one-prompt call run it. Its compaction settings go in
 * through its setup, its environment or its command line (Codex's configuration, Claude Code's
 * environment and hook settings, OpenCode's configuration and plugin); `found` and `own` say how
 * its compactions are found and read.
 */
export interface CliProgram<T extends CliTally> {
  id: CliHarness;
  /** Its name in what people read: "Codex", "Claude Code", "OpenCode". */
  name: string;
  /** It runs research trials too (only OpenCode does). */
  research?: boolean | undefined;
  /** The start of its folders' and events file's names in the trial's area: `<prefix>-home`. */
  prefix: string;
  /** The variable that names its events file to the shell that starts it. */
  eventsVar: string;
  /** What one turn is, as the trial's budget says it. */
  turnWords: string;
  /** What the program itself uses, in words, when it is known (the limits note says it). */
  memory?: string | undefined;
  /** Its binary's name, and its absolute path when it is found. */
  bin(): string;
  exe(): string | undefined;
  /** Its home, configuration and events file, made in the trial's area as the lane. */
  setup(run: CliRun): CliSetup;
  /** Its environment, apart from the trial's workspace, editable paths and events file. */
  env(run: CliRun): Record<string, string>;
  /** Its command line after the binary; `session`: the one to continue. */
  args(run: CliRun, session: string | undefined): string[];
  /** The shell that starts it, with `into` (where a trial's output goes) after it. */
  shell?(argv: string[], into?: string): string[];
  /** Its standard input (else the prompt), in a trial or a call. */
  stdin?(prompt: string, run: { model: ModelConfig }): string;
  newTally(): T;
  /** Reads lines of its output into the tally; returns them as live-view lines. */
  read(lines: string[], t: T): { kind: LiveKind; text: string }[];
  /**
   * The compactions found in one read (goal 070): in its output, or in the area. `count`: those
   * taken already; `at`: how many live entries the read gave (one found outside the output comes
   * after them).
   */
  found(t: T, read: { area: string; count: number; at: number }): FoundCompaction[];
  /** Its own conversation before each compaction, as it keeps it. */
  own(run: CliRun, t: T): OwnConversation;
  /** Why it exited, in words: `note`, its last line; `output`, its last lines. */
  exitWords(code: number | string | null, note: string, output: string): string;
  /** Before each run (Claude Code: its prompt into a file); else why not, in words. */
  beforeRun?(prompt: string, run: CliRun, runner: Runner): Promise<string | undefined>;
  /** After each run (Claude Code: a run cut short keeps the usage its output showed). */
  closeRun?(t: T): void;
  /** Its subscription's usage windows, as its output reported them (Claude Code). */
  windows?(t: T): PlanWindows | undefined;
  /** Its own reason to end the trial after a run (Claude Code: a full usage window). */
  stopAfterRun?(t: T): OwnStop | undefined;
  /**
   * Its own session log, read whole into a tally, where a headless run writes one the harness
   * can read (Codex's rollout; Claude Code keeps its transcript to the lane's user, and OpenCode
   * writes none): the loop compares it with its output once, at the trial's end (goal 169).
   * Undefined when there is none to read.
   */
  sessionLog?(run: CliRun, t: T): { tally: SessionTally; unknown: Map<string, number> } | undefined;
  /**
   * Its hooks or Thermite's plugin in a trial (goal 169): the adapter that reads the signals they
   * write to the trial's signals file into events, and how the program takes the owner's
   * messages inside the agent's turn, at each place, in words.
   */
  signals?: { adapter(): SessionLogAdapter<unknown>; how: Record<InTurn, string> } | undefined;
  /** The program in its own terminal, for a trial in the loop's terminal mode (cli/terminal.ts). */
  terminal: CliTerminal<T>;
  /** A one-prompt call in it (cli/once.ts). */
  call: CliCallEntry<T>;
  /** Its answer to a one-prompt call (else its last text). */
  answer?(t: T): string | undefined;
  /** The tools a planner call may use, in a program that takes a list (`read`: past research). */
  plannerTools?(read: boolean): string;
  /**
   * The model check in it: the tool its prompt names (else its shell tool), where its route goes
   * in the report, and why it failed when its output says more than an error.
   */
  check: {
    tool?: string | undefined;
    baseUrl?(m: ModelConfig): string;
    why?(t: T): string | undefined;
  };
}

/**
 * One run of a program in its own terminal (goal 169), as the terminal host starts it: a new
 * session, or the session it had before a crash, resumed. Its messages are typed into it, never
 * put on its command line.
 */
export interface TerminalAt {
  /** Where it works: a code trial's workspace, or a research trial's working area. */
  cwd: string;
  /** A new session's id, for a program that takes one (Claude Code), or the one to resume. */
  session: string;
  resume: boolean;
  /** A port on localhost that was free, for a program with a server of its own (OpenCode). */
  port: number | undefined;
}

/**
 * What the terminal host starts for one run (goal 169): the program's command line after its
 * binary, what its terminal adds to its environment, the files seeded before it starts so that no
 * screen waits for an answer, Claude Code's sign-in for file descriptor 3, where its session log is
 * for the host to copy, and the server it attaches to (OpenCode's), as arguments after the binary.
 */
export interface TerminalPlan {
  args: string[];
  env?: Record<string, string> | undefined;
  seeds: TerminalSeed[];
  token?: string | undefined;
  log?: TerminalLog | undefined;
  server?: { args: string[]; port: number } | undefined;
}

/**
 * A program in its own terminal (goal 169), as the trial loop's terminal mode runs it. Its own
 * profile (how the host interrupts and ends it) is src/agents/programs/'s; this is what the loop
 * needs besides: its start, its session log's adapter and where the log is read, and what its own
 * tally takes from the log's events.
 */
export interface CliTerminal<T extends CliTally> {
  /** Before the first run, as the lane (Claude Code: its version, for its seeds); else why not. */
  prepare?(run: CliRun, runner: Runner): Promise<string | undefined>;
  /** A new session's id, where the harness gives it (Claude Code); else the program names it. */
  newSession?(): string;
  /** It attaches to a server of its own (OpenCode), on a port the loop finds free. */
  server?: boolean | undefined;
  start(run: CliRun, at: TerminalAt): TerminalPlan;
  /**
   * Its session log: the adapter that reads it, and where it is read, the host's copy of the
   * program's own log, or the trial's signals file (OpenCode's events, which Thermite's plugin
   * writes there).
   */
  log: { adapter(): SessionLogAdapter<unknown>; from: "copy" | "signals" };
  /**
   * At a full usage window it waits for the reset and goes on by itself (Claude Code); else the
   * harness types its continuation after the reset (usage-window.ts).
   */
  goesOnAfterLimit?: boolean | undefined;
  /**
   * What its own tally takes from one of the log's events (a compaction); `at`: the live entries
   * the read gave before it.
   */
  take?(e: SessionEvent, t: T, at: number): void;
}

/** What a program's entry gives a one-prompt call in its folder, as the call's user. */
export interface CliCallEntry<T extends CliTally> {
  /** Its home, configuration and folders, made in the call's folder. */
  setup(c: CliCall): CliSetup;
  env(c: CliCall): Record<string, string>;
  /** Its command line after the binary. */
  args(c: CliCall): string[];
  /** Before the folder is handed to the call's user, as the controller (Claude Code: the prompt). */
  prepare?(c: CliCall, prompt: string): void;
  /**
   * The compactions its own files in the folder record (OpenCode's plugin), read once the
   * controller has the folder back; `at`: the live entries the call gave. Without it, those its
   * output reported (`found`).
   */
  kept?(c: CliCall, at: number): FoundCompaction[];
  /** Its own conversation before each compaction, from the call's folder (goal 070). */
  own(c: CliCall, title: string, t: T): OwnConversation;
}

/** What the trial loop takes from the harness. */
export interface CliTrialDeps extends ProviderLink {
  runner: Runner;
  model: ModelConfig;
  /** The harness API as the lane reaches it, for example http://127.0.0.1:8700. */
  apiUrl: string;
  /** Lines for the live view, and the session's counters. */
  live(entries: { kind: LiveKind; text: string }[]): void;
  progress(p: TrialProgress): void;
  /** The trial's submission, once it has one (from the ledger); a research trial makes none. */
  submitted?(): SubmitOutcome | undefined;
  /**
   * The owner's messages for this trial. A program with hooks or Thermite's plugin takes them
   * inside the agent's turn (`inTurn`); one still waiting when a run ends is given by continuing
   * the session with it, and is read once the agent starts on that prompt.
   */
  messages?: MessageInbox | undefined;
  /**
   * Lets the trial's hooks or plugin take the owner's messages inside the agent's turn, through
   * the trial's routes (goal 169): set when the trial starts, undefined when it ends.
   */
  inTurn?: ((d: TurnDelivery | undefined) => void) | undefined;
  /** The subscription's windows, whenever the program reports them (Claude Code). */
  usage?: ((u: PlanWindows) => void) | undefined;
  /** The lane's build caches (ccache and the like). */
  env?: Record<string, string> | undefined;
  signal?: AbortSignal | undefined;
  /** How often the output is read (tests make it short). */
  pollMs?: number | undefined;
  /** How long the run goes on after a submission (AFTER_SUBMIT_MS; tests make it short). */
  afterSubmitMs?: number | undefined;
  /** Each model usage the program's output reports (goal 075). */
  modelUsage?: ((u: CallUsage) => void) | undefined;
  /**
   * Where the harness keeps the conversation before each compaction (goal 070): with it, the
   * program's summary names the file, and each compaction it reports is kept and recorded
   * (`compacted`).
   */
  keptAt?: KeptAt | undefined;
  compacted?: OnCompacted | undefined;
  /** Keeps the prompt that starts the trial, as it is sent (goal 166). */
  sent?: ((p: Prompt) => void) | undefined;
  /**
   * Runs the program in its own terminal (goal 169; the rig's program_mode), held by the terminal
   * host, instead of headless; a worker in Pi draws its Pi view there. Unset: headless.
   */
  terminal?: boolean | undefined;
  /** Whether the rig drains: a trial that waits in its terminal for its usage window ends. */
  draining?: (() => boolean) | undefined;
  /**
   * Given the owner's console into the trial's terminal (goal 169) when the trial starts, or
   * "headless" when its program runs without one; with a worker's Pi view, that view's own side
   * too, which the worker asks over its trial's routes.
   */
  console?: ((c: TrialConsole | "headless", piView?: PiConsole) => void) | undefined;
}
