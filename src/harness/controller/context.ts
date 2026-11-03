import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  optionalSecretFromFile,
  requireEnv,
  secretFromFile,
  waitForFile,
} from "../../common/env.ts";
import { HARNESS_INBOX_DIR } from "../../core/paths.ts";
import { ROUTE_FILE } from "../agents/index.ts";
import type { ApiTokens } from "../api/index.ts";
import { BrokerClient, LocalRunner, type Runner } from "../broker/index.ts";
import type { PromotionPolicy } from "../judge/index.ts";
import type { HarnessPaths } from "../service/index.ts";
import { harnessNumbers } from "../settings.ts";

/**
 * What the controller's parts share. main.ts builds it once, at its start (controllerContext),
 * and gives it to its parts in this folder: targets.ts, state.ts, agents.ts, checks.ts, judges.ts
 * and loops.ts. It holds the controller's settings and places, read from its environment, control's
 * key, the tokens its API takes, and the runner through which it runs work as other users.
 */
export interface ControllerContext {
  env: NodeJS.ProcessEnv;
  numbers: ReturnType<typeof harnessNumbers>;
  rig: string;
  paths: HarnessPaths;
  controlPublicKeyPem: string;
  tokens: ApiTokens;
  runner: Runner;
  /** The route control sets for this rig: kept in the state directory, root only. */
  routeFile: string;
}

/**
 * Reads the controller's settings from its environment and makes its places; waits for control's
 * key, reads the tokens and chooses the runner. A bad value stops the controller here.
 */
export async function controllerContext(env: NodeJS.ProcessEnv): Promise<ControllerContext> {
  const numbers = harnessNumbers(env);
  const rig = requireEnv("THERMITE_RIG_ID");
  const paths = {
    stateDir: env.THERMITE_STATE_DIR ?? "/var/lib/thermite",
    // Under the broker the scratch root belongs to root; the controller works in its own area.
    scratchDir: join(
      env.THERMITE_SCRATCH_DIR ?? "/scratch",
      env.THERMITE_BROKER_SOCKET ? "thermite" : "",
    ),
    inboxDir: env.THERMITE_INBOX_DIR ?? HARNESS_INBOX_DIR,
    outboxDir: env.THERMITE_OUTBOX_DIR ?? "/outbox",
  };
  for (const d of [paths.stateDir, paths.scratchDir, paths.outboxDir])
    mkdirSync(d, { recursive: true });
  // In pull mode the broker starts the harness only once root has put control's key here.
  const controlPublicKeyPem = await waitForFile(
    requireEnv("THERMITE_CONTROL_PUBKEY_FILE"),
    120_000,
  );
  const tokens = {
    // The broker passes secret values in the environment (it alone can read the files).
    supervisor: env.THERMITE_SUPERVISOR_TOKEN || secretFromFile("THERMITE_SUPERVISOR_TOKEN_FILE"),
    proposer: env.THERMITE_PROPOSER_TOKEN || optionalSecretFromFile("THERMITE_PROPOSER_TOKEN_FILE"),
  };
  const runner: Runner = env.THERMITE_BROKER_SOCKET
    ? new BrokerClient(env.THERMITE_BROKER_SOCKET)
    : new LocalRunner(paths.scratchDir);
  return {
    env,
    numbers,
    rig,
    paths,
    controlPublicKeyPem,
    tokens,
    runner,
    routeFile: join(paths.stateDir, ROUTE_FILE),
  };
}

/**
 * The promotion policy: confirmed wins promote on their own (auto), after an auditor's clear
 * when one is called for and the rig has an auditor; a run's ask_owner makes some wait (goal
 * 079). owner_approval makes every promotion wait.
 */
export function promotionPolicy(env: NodeJS.ProcessEnv): PromotionPolicy {
  const promotion = (env.THERMITE_PROMOTION ?? "auto") as PromotionPolicy;
  if (promotion !== "auto" && promotion !== "owner_approval") {
    throw new Error(`THERMITE_PROMOTION must be auto or owner_approval, not ${promotion}`);
  }
  return promotion;
}
