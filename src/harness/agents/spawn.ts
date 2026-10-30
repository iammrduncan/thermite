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
import { startTerminal } from "../terminal/index.ts";
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
 * The route a worker process gets. A ChatGPT sign-in's token is renewed hourly and stays in the
 * harness: the worker reaches the model through the harness's proxy with its trial's own token,
 * which stops working when the trial ends.
 */
export function workerRoute(
  model: ModelConfig,
  apiPort: number,
  trialToken: string | undefined,
): ModelConfig {
  if (model.api !== "chatgpt") return model;
  return {
    ...model,
    baseUrl: `http://127.0.0.1:${apiPort}/v1/model-proxy`,
    apiKey: `trial.${trialToken ?? ""}`,
    keyNow: undefined,
  };
}

/** The most bytes of a result a worker in its Pi view leaves in its folder that are read. */
const RESULT_MAX = 1024 * 1024;
/** The worker process's memory limit, with the terminal host that holds it in its Pi view. */
const WORKER_RSS = 2 * 1024 * 1024 * 1024;
/** The worker's entry, as Node runs it: worker-main.js when built, worker-main.ts from the source. */
const WORKER_MAIN = fileURLToPath(
  new URL(`./worker-main${extname(fileURLToPath(import.meta.url))}`, import.meta.url),
);

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
  const route = model ? workerRoute(model, apiPort, spec.token) : undefined;
  await runner.handOver(dir, role, view ? { harnessReads: true } : {});
  const abort = () => void runner.killRole(role).catch(() => 0);
  if (signal?.aborted) abort();
  signal?.addEventListener("abort", abort, { once: true });
  // Relative to its folder, where its process starts.
  const argv = [process.execPath, ...process.execArgv, WORKER_MAIN, "trial.json"];
  const env = {
    ...Object.fromEntries(
      (model ? ALWAYS : MODEL_ENV)
        .filter((k) => process.env[k] !== undefined)
        .map((k) => [k, process.env[k] as string]),
    ),
    // Only the worker's own user can read its environment; the lane's commands run as another.
    ...(route ? modelEnv(route) : {}),
    THERMITE_HARNESS_URL: `http://127.0.0.1:${apiPort}`,
  };
  // The trial's own length, when it has one, and two minutes to hand its result over.
  const timeoutMs = spec.wallMs !== undefined ? spec.wallMs + 120_000 : undefined;
  // The contract's process limit for the lane's users; without it, the broker's default.
  const nproc = spec.limits?.processes;
  try {
    if (view) {
      const term = await startTerminal(runner, {
        role,
        area: dir,
        env,
        start: { trial: spec.trialId, program: "pi", argv: [...argv, VIEW_FLAG], cwd: dir },
        timeoutMs,
        rssLimitBytes: WORKER_RSS,
        // The host and the worker are both Node: neither is the agent's commands, which run as
        // the lane's user, so both are spared, and the limit ends the run as it would headless.
        spareExe: process.execPath,
        nproc,
      });
      view.attach(term);
      const ended = await term.done;
      view.ended(ended.exit?.screen);
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
      rssLimitBytes: WORKER_RSS,
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
