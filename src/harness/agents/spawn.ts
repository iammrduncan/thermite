import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MODEL_ENV_NAMES,
  type ModelConfig,
  modelEnv,
  STALL_SETTING,
} from "../../agents/model/index.ts";
import type { Role, Runner } from "../broker/index.ts";
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

/**
 * Runs one trial's worker process. Under the broker it runs as the lane's own agent user
 * (`agent-N`), which can read none of the harness's state, kits, secrets or lane files and
 * cannot reach the broker: its tools go through the harness API with its trial token. Its
 * directory (with the spec and its token) belongs to it alone. A hard wall limit applies, and an
 * abort kills it.
 */
export async function spawnTrial(
  trial: AnyTrial,
  runner: Runner,
  scratchDir: string,
  apiPort: number,
  signal?: AbortSignal,
  /** The route the trial uses; without one, the harness's own model settings pass through. */
  model?: ModelConfig | undefined,
): Promise<TrialResult> {
  const spec = trial.spec;
  const lane = /^lane-(\d+)$/.exec(spec.lane)?.[1];
  if (!lane) throw new Error(`not a lane: ${spec.lane}`);
  const role = `agent-${lane}` as Role;
  const dir = join(scratchDir, "agents", spec.trialId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const specFile = join(dir, "trial.json");
  writeFileSync(specFile, JSON.stringify(trial), { mode: 0o600 });
  const route = model ? workerRoute(model, apiPort, spec.token) : undefined;
  await runner.handOver(dir, role);
  const main = fileURLToPath(new URL("./worker-main.js", import.meta.url));
  const abort = () => void runner.killRole(role).catch(() => 0);
  if (signal?.aborted) abort();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const r = await runner.run({
      role,
      // Relative to its directory: the agent may not traverse the controller's scratch area.
      argv: [process.execPath, ...process.execArgv, main, "trial.json"],
      cwd: dir,
      env: {
        ...Object.fromEntries(
          (model ? ALWAYS : MODEL_ENV)
            .filter((k) => process.env[k] !== undefined)
            .map((k) => [k, process.env[k] as string]),
        ),
        // Only the worker's own user can read its environment; the lane's commands run as another.
        ...(route ? modelEnv(route) : {}),
        THERMITE_HARNESS_URL: `http://127.0.0.1:${apiPort}`,
      },
      // The trial's own length, when it has one, and two minutes to hand its result over.
      ...(spec.wallMs !== undefined ? { timeoutMs: spec.wallMs + 120_000 } : {}),
      rssLimitBytes: 2 * 1024 * 1024 * 1024,
      // The contract's process limit for the lane's users; without it, the broker's default.
      ...(spec.limits ? { nproc: spec.limits.processes } : {}),
      captureBytes: 1024 * 1024,
    });
    // The worker runs as the lane's agent user: its last line is read as data, through the
    // result's schema. What it says it submitted is not taken: the scheduler reads the trial's
    // attempt from the ledger, where the harness linked it as the trial submitted.
    const last = r.stdout.trim().split("\n").pop() ?? "";
    let said: unknown;
    try {
      said = JSON.parse(last);
    } catch {
      said = undefined;
    }
    const result = TrialResult.safeParse(said);
    if (result.success) return result.data;
    const why =
      said === undefined
        ? `gave no result (${r.killedFor ?? r.exitCode ?? r.signal}): ${r.stderr.slice(-500)}`
        : `gave a result that is not a trial's: ${result.error.issues
            .slice(0, 3)
            .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
            .join("; ")}`;
    return {
      stopped: "error",
      turns: 0,
      toolCalls: 0,
      tokensIn: 0,
      tokensOut: 0,
      error: `worker process ${why}`,
    };
  } finally {
    signal?.removeEventListener("abort", abort);
    await runner.killRole(role).catch(() => 0);
    await runner.remove(dir).catch(() => undefined);
  }
}
