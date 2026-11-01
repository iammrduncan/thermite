/**
 * One rig, wherever it runs: its setup and the steps of its history (setup.ts, setup-view.ts),
 * where it runs and control's look there (place.ts, watch.ts), its move onto control's images
 * (update.ts), its settings (settings.ts), its agents' models (agent-models.ts, model.ts), the
 * model routes they get with their keys (model-routes.ts), its GPU split (gpu-split.ts), its
 * supervisor's figures (figures.ts), its return from retirement (retire.ts), and its
 * subscription's weekly limit (weekly.ts).
 */

export { takeFigures } from "./figures.ts";
export { sendSplit, splitFor } from "./gpu-split.ts";
export {
  type AdvisorSetupView,
  type AdvisorsFileView,
  type AgentModelPlan,
  advisorRoutesOf,
  advisorsFileOf,
  agentsModelMissing,
  applyAgentModel,
  checkAgentModel,
  clearRigModel,
  giveRigModel,
  HARNESS_NAMES,
  harnessKept,
  type ModelRoutes,
  modelRoutesOf,
  neededHarness,
  opencodeOnly,
  opencodeOnlyModel,
  RigModelBody,
  type RouteParts,
  researchNeedsOpencode,
  rigModelAnswer,
  rigModelFields,
  rigModelRequest,
  rigModels,
  rigModelsAnswer,
  setRigModel,
} from "./model/index.ts";
export { checkRigPlace } from "./place.ts";
export { bringBackRig } from "./retire.ts";
export {
  PROGRAM_MODE_TIP,
  programModeField,
  QUIET_TIP,
  quietField,
  type RigPart,
  RigSettingsBody,
  rigSettingsAnswer,
  rigSettingsChange,
  rigSettingsFields,
  rigSettingsRead,
  SPLIT_RESTARTS,
  setRigSettings,
  settingsCount,
} from "./settings.ts";
export {
  awaitFirstReport,
  controlAddress,
  controlImages,
  judgeShare,
  NO_RIG_BUS,
  type RigImages,
  rigBusOf,
  rigSetupView,
  rigTaken,
  SETUP_STEPS,
  STEP_WORDS,
  sleep,
  UPDATE_STEP_WORDS,
} from "./setup/index.ts";
export { RigUpdates, rigVersionWords } from "./update.ts";
export { checkQuietRigs } from "./watch.ts";
export { WEEKLY_MODEL_STEP, WEEKLY_WAIT_STEP, weeklyLimit } from "./weekly.ts";
