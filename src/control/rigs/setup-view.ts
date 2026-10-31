import type { RunpodRigs } from "../runpod/index.ts";
import type { ControlStore } from "../store/index.ts";

/** Steps of a rig's setup and management given by default (goal 138): the newest. */
export const SETUP_STEPS = 20;

/**
 * MCP's rig_setup: where a rig control set up or manages is, its status there, and its newest
 * `steps` steps, oldest first, with how many there are. `details`: a failed step's detail can
 * name the cluster's API server or a host, so only the owner and the operator read it.
 */
export function rigSetupView(
  store: ControlStore,
  runpodRigs: RunpodRigs | undefined,
  rig: string,
  steps: number,
  details: boolean,
) {
  const cluster = store.clusters.rig(rig);
  const machine = store.machines.rig(rig);
  const runpod = runpodRigs?.view(rig);
  if (!cluster && !machine && !runpod) throw new Error(`control did not set ${rig} up`);
  const all = store.rigHistory.list(rig);
  return {
    rig,
    ...(runpod
      ? {
          on: "runpod",
          cloud: runpod.cloud,
          pod: runpod.pod,
          status: runpod.active ? runpod.status : "TERMINATED",
          op: runpod.op,
        }
      : {}),
    ...(cluster
      ? {
          on: "cluster",
          cluster: cluster.cluster,
          namespace: cluster.namespace,
          placement: cluster.placement,
          status: cluster.status,
          images: cluster.spec.images,
          gpus: cluster.spec.gpus,
          judge_gpus: cluster.spec.judgeGpus ?? null,
          cpus: cluster.spec.resources?.cpus ?? null,
          memory_gib: cluster.spec.resources?.memoryGi ?? null,
          // A change to its GPUs, CPUs or memory that waits for its drain.
          pending: cluster.pending
            ? {
                gpus: cluster.pending.gpus,
                judge_gpus: cluster.pending.judgeGpus ?? null,
                cpus: cluster.pending.resources?.cpus ?? null,
                memory_gib: cluster.pending.resources?.memoryGi ?? null,
              }
            : null,
        }
      : {}),
    ...(machine ? { on: "machine", machine: machine.machine, status: machine.status } : {}),
    steps_total: all.length,
    steps: all.slice(-steps).map((x) => (details ? x : { ...x, detail: null })),
  };
}
