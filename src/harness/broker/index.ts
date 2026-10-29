/**
 * The harness broker, as the rest of the harness uses it: the roles and the runner that runs work
 * as their users (runner.ts, client.ts), the GPU's device nodes (devices.ts), supervised processes
 * (process.ts) and a kit's driver run beside the candidate (pair.ts), the one-container rig (one-container.ts), and the state snapshot (seal.ts,
 * snapshot/). The broker's entry is main.ts; this file is only the folder's interface.
 */

export { BrokerClient } from "./client.ts";
export {
  builderRole,
  cardsOf,
  checkerRole,
  driverRole,
  effectiveGpuLists,
  type GpuCard,
  type GpuLayout,
  judgeCardOf,
  LAYOUT_FILE,
  type LayoutRecord,
  MAX_GPU_SET,
  parseIndexList,
  readLayout,
  runRole,
} from "./devices.ts";
export {
  oneContainer,
  SUPERVISOR_RECORD,
  type SupervisorRecord,
  supervisorPaths,
} from "./one-container.ts";
export type { PairOutcome } from "./pair.ts";
export { listProcesses, type Proc, runSupervised } from "./process.ts";
export {
  IDS,
  LocalRunner,
  type Role,
  RoleSchema,
  type Runner,
  type RunOutcome,
  RunRequest,
  roleIds,
  walk,
} from "./runner.ts";
export { SNAPSHOT_KEY_VAR } from "./seal.ts";
export {
  inspectSnapshotFolder,
  lookWords,
  SNAPSHOT_RECORD,
  type SnapshotRecord,
  UNSEALED_DIRS,
} from "./snapshot/index.ts";
