import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sweepTemp } from "../../common/fs.ts";
import { log } from "../../common/log.ts";
import { fingerprint, generateSigningKeys } from "../../core/commands.ts";
import { PROGRAM_MODE_DEFAULT } from "../../core/rig-settings.ts";
import type { PromotionPolicy } from "../judge/index.ts";
import { Ledger } from "../ledger/index.ts";
import { lanesFromEnv, RigSettingsStore, trialMinutesFromEnv } from "../rig-settings-store.ts";
import { NOT_BEFORE_FILE, wipeIfRequested } from "../service/index.ts";
import type { ControllerContext } from "./context.ts";

/**
 * The controller's private state: its folders and their modes, a full reset's wipe, the ledger,
 * the rig's report-signing key, and the rig's settings.
 */

/** Makes the private folders, wipes the state if a full reset asked for it, and opens the ledger. */
export function openState(ctx: ControllerContext): {
  ledger: Ledger;
  rigKeys: { privateKeyPem: string; publicKeyPem: string };
} {
  const { paths } = ctx;
  // Private state: only the controller's user may enter. Builds and models are reachable by
  // exact path only (0711), because the run user executes builds and loads models. The kits are
  // entered by the checkers' group too (0710), which the broker gives the folder: the kit's check
  // reads its kit.
  for (const [dir, mode] of [
    ["ledger", 0o700],
    ["git", 0o700],
    ["kits", 0o710],
    ["imports", 0o700],
    ["models", 0o711],
  ] as const) {
    mkdirSync(join(paths.stateDir, dir), { recursive: true });
    chmodSync(join(paths.stateDir, dir), mode);
  }
  // A full reset's wipe, requested by the last controller run: done before anything opens.
  if (wipeIfRequested(paths, ["rig-signing.key", "rig-signing.key.pub"])) {
    log("harness", "state wiped (full reset); starting with a fresh ledger");
    for (const [dir, mode] of [
      ["ledger", 0o700],
      ["git", 0o700],
      ["kits", 0o710],
      ["imports", 0o700],
      ["models", 0o711],
    ] as const) {
      mkdirSync(join(paths.stateDir, dir), { recursive: true });
      chmodSync(join(paths.stateDir, dir), mode);
    }
  }
  // An export a crash stopped half written, swept before the next is written.
  const left = sweepTemp(paths.outboxDir);
  if (left.length)
    log("harness", "removed the exports a crash left half written", { left: left.length });
  const ledger = Ledger.open(join(paths.stateDir, "ledger", "ledger.db"));
  // The guards of champions judged before verdicts carried them, sent once (goal 184).
  const guarded = ledger.verdicts.sendChampionGuards("judge");
  if (guarded) log("harness", "sent the guards of champions judged before", { champions: guarded });
  // After a wipe: commands issued before it belonged to the old ledger.
  const notBefore = join(paths.stateDir, "ledger", NOT_BEFORE_FILE);
  if (existsSync(notBefore)) {
    ledger.setNotBefore(readFileSync(notBefore, "utf8").trim());
    rmSync(notBefore, { force: true });
  }
  // The rig's report-signing key: created once, kept with the ledger (0700).
  const rigKeyPath = join(paths.stateDir, "ledger", "rig-signing.key");
  if (!existsSync(rigKeyPath)) {
    const k = generateSigningKeys();
    writeFileSync(rigKeyPath, k.privateKeyPem, { mode: 0o600 });
    writeFileSync(`${rigKeyPath}.pub`, k.publicKeyPem, { mode: 0o644 });
  }
  const rigKeys = {
    privateKeyPem: readFileSync(rigKeyPath, "utf8"),
    publicKeyPem: readFileSync(`${rigKeyPath}.pub`, "utf8"),
  };
  // At every start, so the owner can compare it with the fingerprint control shows for the rig.
  log("harness", "the rig's report key", {
    rig: ctx.rig,
    fingerprint: fingerprint(rigKeys.publicKeyPem),
  });
  return { ledger, rigKeys };
}

/** The rig's settings (Edit rig): the environment gives the defaults, owner commands change them. */
export function rigSettings(ctx: ControllerContext, promotion: PromotionPolicy): RigSettingsStore {
  const { env, numbers, paths } = ctx;
  return new RigSettingsStore(
    {
      judge: true,
      workers: true,
      lanes: lanesFromEnv(env.THERMITE_MAX_TRIALS),
      planner: true,
      auditor: true,
      teachers: true,
      review: true,
      exports: true,
      // No trial length unless one is set (goal 079).
      trial_minutes: trialMinutesFromEnv(env.THERMITE_TRIAL_MINUTES),
      max_turns: numbers.maxTurns,
      quiet_minutes: null,
      program_mode: PROGRAM_MODE_DEFAULT,
      promotion,
      judge_gpus: null,
    },
    join(paths.stateDir, "rig-settings.json"),
  );
}
