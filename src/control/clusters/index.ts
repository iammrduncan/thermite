/**
 * Rigs control sets up on Kubernetes clusters: kubectl (kubectl.ts), what control reads from a
 * cluster (facts.ts), the objects it applies (manifests.ts), a rig's setup and the cluster's slots
 * (rigs.ts), its images (images.ts), its size (resources.ts, resize.ts), its stop, start and
 * removal (actions.ts), the watch of its drain (drain.ts), which also notes any rig's drain past
 * its deadline and makes the owner's choice then, and the owner's list of addresses rigs may
 * reach (reach.ts), which its network rules open.
 */

export { actOnClusterRig, type ClusterRigAction, clusterRigAction } from "./actions.ts";
export {
  cancelDrain,
  chooseAtDeadline,
  DEADLINE_STEP,
  drainChoices,
  watchDrains,
} from "./drain.ts";
export { type ClusterFacts, clusterLine } from "./facts.ts";
export { updateRigImages } from "./images.ts";
export { type ClusterKubectl, inspectKubeconfig, KUBE_NAME, realKubectl } from "./kubectl.ts";
export { asList, type ClusterRigPlan, clusterRigObjects } from "./manifests.ts";
export { reachListOf, setReachableAddresses } from "./reach.ts";
export { prepareResize, setClusterRigResources } from "./resize.ts";
export {
  asksNothing,
  ClusterResourcesBody,
  type ClusterResourcesRequest,
  clusterResourcesFields,
  clusterResourcesRequest,
  judgeShareOf,
  resourcesWords,
  sizeWords,
} from "./resources.ts";
export {
  addClusterRig,
  checkClusterNow,
  checkClusterRig,
  NS,
  rigWork,
  setClusterSlots,
  workWords,
} from "./rigs.ts";
