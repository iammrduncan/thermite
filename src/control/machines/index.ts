/**
 * Rigs control sets up on machines it reaches over SSH: the SSH client (ssh.ts), what control
 * reads from a machine (facts.ts), the only things it installs there (recipes.ts), and the rig as
 * files and Podman Quadlet units (deploy.ts).
 */

export {
  checkScript,
  deployScript,
  gpuSplit,
  MAX_RIG_GPUS,
  manageScript,
  type RigAction,
  type RigBus,
  type RigPlan,
  type RigSecrets,
  readCheck,
  SUPERVISOR_BUS_CA,
  updateScript,
} from "./deploy.ts";
export { CHECK_SCRIPT, factsLine, type MachineFacts, missing, parseFacts } from "./facts.ts";
export { RECIPES, type RecipeId, recipeScript, scriptSha } from "./recipes.ts";
export { ADDRESS, fingerprint, type MachineSsh, openSsh, tail, USER } from "./ssh.ts";
