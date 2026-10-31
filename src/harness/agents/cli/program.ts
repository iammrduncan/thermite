import type {
  CallLink,
  MessageInbox,
  TrialConsole,
  TurnDelivery,
} from "../../../agents/cli/index.ts";
import type { KeptAt, OnCompacted } from "../../../agents/compaction/index.ts";
import type { ModelConfig } from "../../../agents/model/index.ts";
import type { PlanWindows } from "../../../agents/programs/index.ts";
import type { Prompt } from "../../../agents/prompt.ts";
import type { ResearchFolderPaths } from "../../../agents/tools/index.ts";
import type { LiveKind } from "../../../core/live.ts";
import type { CallUsage } from "../../../core/usage.ts";
import type { Runner } from "../../broker/index.ts";
import type { TrialProgress } from "../live-session.ts";
import type { PiConsole } from "../pi-view/index.ts";
import type { ProviderLink } from "../provider-errors.ts";
import type { ResearchTrialSpec } from "../research/index.ts";
import type { SubmitOutcome, TrialSpec } from "../worker/index.ts";

/**
 * What the harness's trial loop (loop.ts) and a planner's call in its terminal take from the
 * harness, beside each program's entry and the one path for a role in its terminal
 * (src/agents/cli/).
 */

/**
 * A trial the loop runs: a code trial, in its workspace, which a submission ends; or a research
 * trial (in a program whose entry says it runs them), in its lane's working area of the run's
 * research folder, which ends when the agent stops. `area`: the research trial's own area in the
 * lane, for the program's home, temporary files and events.
 */
export type CliTrial =
  | { mode: "code"; spec: TrialSpec }
  | { mode: "research"; spec: ResearchTrialSpec; area: string; folder: ResearchFolderPaths };

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

/**
 * What a planner's call in its program's own terminal takes from the harness (goal 169): the
 * shared path's link, whose console, in Pi, comes with its Pi view's own side, which its process
 * asks for the owner's inputs (planner/view.ts).
 */
export interface TerminalCallLink extends CallLink {
  console(c: TrialConsole | undefined, piView?: PiConsole): void;
}
