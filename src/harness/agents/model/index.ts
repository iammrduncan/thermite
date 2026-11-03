/**
 * The rig's model route as the harness holds it: where the route the agents use comes from,
 * control or the environment (source.ts), and the model check that a rig check and an owner's
 * change of route run (check.ts). The model client itself is the agents' (src/agents/model/).
 */

export { checkModel, type RigCheckReport } from "./check.ts";
export {
  type ControlRoute,
  type ModelInfo,
  ModelSource,
  plannerRouteFile,
  ROUTE_FILE,
} from "./source.ts";
