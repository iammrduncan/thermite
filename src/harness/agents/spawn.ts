import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MODEL_ENV_NAMES,
  type ModelConfig,
  modelEnv,
  STALL_SETTING,
} from "../../agents/model/index.ts";
import { errorText } from "../../common/errors.ts";
import { logWarn } from "../../common/log.ts";
import type { Role, Runner, RunOutcome } from "../broker/index.ts";
import { startTerminal, type TerminalEnded } from "../terminal/index.ts";
import { type PiConsole, VIEW_FLAG, VIEW_RESULT } from "./pi-view/index.ts";
import type { ResearchTrialSpec } from "./research/index.ts";
import { TrialResult, type TrialSpec } from "./worker/index.ts";

export type AnyTrial =
  | { kind: "code"; spec: TrialSpec }
  | { kind: "research"; spec: ResearchTrialSpec };

/**
 * What a worker process gets: the model route and the harness URL. No tokens, no broker. How long
 * a model call's stream may be silent (goal 079) goes with any route.
 */
const ALWAYS = ["NODE_OPTIONS", "LANG", STALL_SETTING];
const MODEL_ENV = [...MODEL_ENV_NAMES, ...ALWAYS];

/**
 * The route a Pi process gets, a worker's or a planner's. A ChatGPT sign-in's token is renewed
 * hourly and stays in the harness: the process reaches the model through the harness's proxy with
 * `credential`, its trial's token or its call's, which stops working when the trial or call ends.
 */
export function piRoute(model: ModelConfig, apiPort: number, credential: string): ModelConfig {
  if (model.api !== "chatgpt") return model;
  return {
    ...model,
    baseUrl: `http://127.0.0.1:${apiPort}/v1/model-proxy`,
    apiKey: credential,
    keyNow: undefined,
  };
}

/**
 * A Pi process's environment: its route, when it has one (else the harness's own model settings
 * pass through), and the harness's URL. Only the process's own user can read it.
 */
export function piEnv(
  model: ModelConfig | undefined,
  apiPort: number,
  credential: string,
): Record<string, string> {
  return {
    ...Object.fromEntries(
      (model ? ALWAYS : MODEL_ENV)
        .filter((k) => process.env[k] !== undefined)
        .map((k) => [k, process.env[k] as string]),
    ),
    ...(model ? modelEnv(piRoute(model, apiPort, credential)) : {}),
    THERMITE_HARNESS_URL: `http://127.0.0.1:${apiPort}`,
  };
}

/** The most bytes of a result a worker in its Pi view leaves in its folder that are read. */
const RESULT_MAX = 1024 * 1024;
/** A Pi process's memory limit, with the terminal host that holds it in its Pi view. */
export const PI_PROCESS_RSS = 2 * 1024 * 1024 * 1024;

/** How Node runs one of the harness's entries: `name`.js when built, `name`.ts from the source. */
export function entryArgv(name: string): string[] {
  const file = fileURLToPath(
    new URL(`./${name}${extname(fileURLToPath(import.meta.url))}`, import.meta.url),
  );
  return [process.execPath, ...process.execArgv, file];
}

/**
 * A Pi process in its Pi view (goal 169), a worker's or a planner's: the terminal host runs it as
 * `role`, in `dir`, on a terminal of its own, where it draws its view; `view` is its console, given
 * the host to show the screen. Resolves when the process has ended. The host and the process are
 * both Node: neither is the agent's commands, so both are spared at the memory limit, which ends
 * the run as it would headless. Throws when the host can't start.
 */
export async function runInView(
  runner: Runner,
  o: {
    role: Role;
    dir: string;
    env: Record<string, string>;
    /** The trial's id, or the call's. */
    id: string;
    argv: string[];
    timeoutMs?: number | undefined;
    nproc?: number | undefined;
  },
  view: PiConsole,
): Promise<TerminalEnded> {
  const term = await startTerminal(runner, {
    role: o.role,
    area: o.dir,
    env: o.env,
    start: { trial: o.id, program: "pi", argv: [...o.argv, VIEW_FLAG], cwd: o.dir },
    timeoutMs: o.timeoutMs,
    rssLimitBytes: PI_PROCESS_RSS,
    spareExe: process.execPath,
    nproc: o.nproc,
  });
  view.attach(term);
  const ended = await term.done;
  view.ended(ended.exit?.screen);
  return ended;
}
/**
 * The folder of the trials' own folders, in the harness's scratch area: one that each worker's
 * user may pass through to reach its own folder by its full path (its terminal host's socket is
 * there), but may not list. Each trial's folder is its worker's alone (spawnTrial).
 */
function agentsFolder(scratchDir: string): string {
  const dir = join(scratchDir, "agents");
  mkdirSync(dir, { recursive: true });
  // Set every time: mkdir's mode goes through the umask, and a folder made before keeps its own.
  chmodSync(dir, 0o711);
  return dir;
}

/**
 * Runs one trial's worker process. Under the broker it runs as the lane's own agent user
 * (`agent-N`), which can read none of the harness's state, kits, secrets or lane files and
 * cannot reach the broker: its tools go through the harness API with its trial token. Its
 * directory (with the spec and its token) belongs to it alone. A hard wall limit applies, and an
 * abort kills it.
 *
 * With `view` (the rig runs its agents in their own terminal, goal 169), the terminal host runs
 * it, as the same user under the same limits, on a terminal of its own, where it draws its Pi
 * view; `view` is its console, given the host to show the screen. Its folder is then one the
 * harness's group may enter, for the host's socket and the worker's result, and no other user may.
 */
export async function spawnTrial(
  trial: AnyTrial,
  runner: Runner,
  scratchDir: string,
  apiPort: number,
  signal?: AbortSignal,
  /** The route the trial uses; without one, the harness's own model settings pass through. */
  model?: ModelConfig | undefined,
  view?: PiConsole | undefined,
): Promise<TrialResult> {
  const spec = trial.spec;
  const lane = /^lane-(\d+)$/.exec(spec.lane)?.[1];
  if (!lane) throw new Error(`not a lane: ${spec.lane}`);
  const role = `agent-${lane}` as Role;
  const dir = join(agentsFolder(scratchDir), spec.trialId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const specFile = join(dir, "trial.json");
  writeFileSync(specFile, JSON.stringify(trial), { mode: 0o600 });
  await runner.handOver(dir, role, view ? { harnessReads: true } : {});
  const abort = () => void runner.killRole(role).catch(() => 0);
  if (signal?.aborted) abort();
  signal?.addEventListener("abort", abort, { once: true });
  // Relative to its folder, where its process starts.
  const argv = [...entryArgv("worker-main"), "trial.json"];
  // Only the worker's own user can read its environment; the lane's commands run as another.
  const env = piEnv(model, apiPort, `trial.${spec.token ?? ""}`);
  // The trial's own length, when it has one, and two minutes to hand its result over.
  const timeoutMs = spec.wallMs !== undefined ? spec.wallMs + 120_000 : undefined;
  // The contract's process limit for the lane's users; without it, the broker's default.
  const nproc = spec.limits?.processes;
  try {
    if (view) {
      const ended = await runInView(
        runner,
        { role, dir, env, id: spec.trialId, argv, timeoutMs, nproc },
        view,
      );
      const said = readResult(dir);
      if (!said)
        logWarn("harness", "a worker in Pi left no result in its terminal", {
          trial: spec.trialId,
          lane: spec.lane,
          how: ended.exit?.how,
          code: ended.exit?.code ?? ended.outcome.exitCode,
          killedFor: ended.outcome.killedFor,
          error: ended.exit?.error,
        });
      return resultOf(said, ended.outcome);
    }
    const r = await runner.run({
      role,
      argv,
      cwd: dir,
      env,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      rssLimitBytes: PI_PROCESS_RSS,
      ...(nproc !== undefined ? { nproc } : {}),
      captureBytes: 1024 * 1024,
    });
    return resultOf(r.stdout.trim().split("\n").pop() ?? "", r);
  } catch (err) {
    // The terminal host could not start: the trial ends with why, as a worker that gave nothing.
    if (!view) throw err;
    view.ended();
    logWarn("harness", "a worker in Pi could not start in its terminal", {
      trial: spec.trialId,
      lane: spec.lane,
      error: errorText(err),
    });
    return failed(`could not start in its terminal: ${errorText(err)}`);
  } finally {
    signal?.removeEventListener("abort", abort);
    await runner.killRole(role).catch(() => 0);
    await runner.remove(dir).catch(() => undefined);
  }
}

/** A worker's result that is none: the trial ended with an error, in words. */
const failed = (why: string): TrialResult => ({
  stopped: "error",
  turns: 0,
  toolCalls: 0,
  tokensIn: 0,
  tokensOut: 0,
  error: `worker process ${why}`,
});

/** The result a worker in its Pi view left in its folder: at most RESULT_MAX bytes, else none. */
function readResult(dir: string): string {
  const file = join(dir, VIEW_RESULT);
  try {
    if (statSync(file).size > RESULT_MAX) return "";
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

/**
 * The worker's result, from what it said (a headless worker's last line, or its file in its Pi
 * view). It runs as the lane's agent user: what it said is read as data, through the result's
 * schema. What it says it submitted is not taken: the scheduler reads the trial's attempt from
 * the ledger, where the harness linked it as the trial submitted.
 */
function resultOf(
  text: string,
  r: Pick<RunOutcome, "killedFor" | "exitCode" | "signal" | "stderr">,
) {
  let said: unknown;
  try {
    said = JSON.parse(text);
  } catch {
    said = undefined;
  }
  const result = TrialResult.safeParse(said);
  if (result.success) return result.data;
  return failed(
    said === undefined
      ? `gave no result (${r.killedFor ?? r.exitCode ?? r.signal}): ${r.stderr.slice(-500)}`
      : `gave a result that is not a trial's: ${result.error.issues
          .slice(0, 3)
          .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("; ")}`,
  );
}
