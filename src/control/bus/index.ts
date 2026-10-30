/**
 * The message bus as control keeps it: who may use it, each rig's key and control's own two, and
 * the users file control writes for the bus's server (users.ts); each rig's consumers, which
 * control makes (consumers.ts); its TLS, with control's own certificate authority and the
 * server's certificate (tls.ts, cert.ts); each rig's config in the config bucket, sealed to the
 * rig's seal key (config.ts); each rig on RunPod, whose pod's server control's server dials as a
 * leaf node, with the keys a launch gives the pod (leaf.ts); what control's system user asks the
 * server: a reload, and its store's use (system.ts); what a rig asks of control on it (asks.ts);
 * whether a rig reaches it (reach.ts); and its state, for whoever runs control (state.ts).
 */

export { answerRigAsk, type RigAsksDeps, serveRigAsks } from "./asks.ts";
export {
  CONFIG_WRITE_MS,
  type ConfigBus,
  type ConfigParts,
  ConfigWriter,
  ConfigWritten,
  configState,
  configValueOf,
  type RigConfig,
  takeRigSealKey,
} from "./config.ts";
export { RIG_CONSUMERS_LOOK_AGAIN_MS, RigConsumers } from "./consumers.ts";
export { BUS_SERVER_DIR, leafCaFile, type MintedLeaf, mintLeaf } from "./leaf.ts";
export {
  BUS_OFF_STEP,
  BUS_REACH_GRACE_MS,
  BUS_REGISTERED_STEP,
  noteOffBusCall,
  noteRegistered,
  type OffBus,
  offBus,
  offBusFix,
} from "./reach.ts";
export {
  BUS_STATE_TIMEOUT_MS,
  BUS_STREAMS,
  type BusView,
  busHealth,
  busState,
  liveState,
  type RigLive,
} from "./state.ts";
export {
  type BusStoreUse,
  busStoreUse,
  reloadBus,
} from "./system.ts";
export {
  BUS_CA_EXPORT_SETTING,
  BUS_CA_FILES,
  BUS_PORT,
  BUS_PUBLIC_URL_SETTING,
  BUS_TLS_FILES,
  BusTls,
  busPublicUrl,
  controlBusUrl,
} from "./tls.ts";
export {
  BUS_CONFIG_DIR_SETTING,
  BUS_KEY_CHANGE_STEPS,
  BUS_KEYS_SEEN_STEP,
  BUS_USERS_FILE,
  BUS_USERS_SYNC_MS,
  BUS_USERS_TROUBLE_MS,
  BusUsers,
  busConfigDir,
  busKeyHolder,
  busRigs,
  busUsersOf,
  keyHeldWords,
  noteKeyRefused,
  takeRigBusKey,
} from "./users.ts";
