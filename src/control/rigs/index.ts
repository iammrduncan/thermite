/**
 * One rig, wherever it runs: its setup and the steps of its history (setup.ts, setup-view.ts),
 * where it runs and control's look there (place.ts, watch.ts), its move onto control's images
 * (update.ts), its settings (settings.ts), its agents' models (agent-models.ts, model.ts), the
 * model routes they get with their keys (model-routes.ts), its GPU split (gpu-split.ts), its
 * supervisor's figures (figures.ts), and its return from retirement (retire.ts).
 */

export {
  type AgentModelPlan,
  agentsModelMissing,
  applyAgentModel,
  checkAgentModel,
  clearRigModel,
  giveRigModel,
  harnessKept,
  opencodeOnlyModel,
  researchNeedsOpencode,
  rigModels,
  setRigModel,
} from "./agent-models.ts";
export { takeFigures } from "./figures.ts";
export { sendSplit, splitFor } from "./gpu-split.ts";
export {
  type AdvisorSetupView,
  type AdvisorsFileView,
  advisorsFileOf,
  HARNESS_NAMES,
  neededHarness,
  opencodeOnly,
  RigModelBody,
  rigModelAnswer,
  rigModelFields,
  rigModelRequest,
  rigModelsAnswer,
} from "./model.ts";
export {
  advisorRoutesOf,
  type ModelRoutes,
  modelRoutesOf,
  type RouteParts,
} from "./model-routes.ts";
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
  rigTaken,
  STEP_WORDS,
  sleep,
  UPDATE_STEP_WORDS,
} from "./setup.ts";
export { rigSetupView, SETUP_STEPS } from "./setup-view.ts";
export { RigUpdates, rigVersionWords } from "./update.ts";
export { checkQuietRigs } from "./watch.ts";
