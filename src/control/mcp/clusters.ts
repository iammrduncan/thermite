import { z } from "zod";
import { RIG_ID_SENTENCE } from "../../core/ids.ts";
import { REACH_MAX_ENTRIES, REACH_MAX_PORTS } from "../../core/reach.ts";
import {
  addClusterRig,
  addClusterRunner,
  type ClusterResourcesBody,
  ClusterRunnerBody,
  clusterResourcesFields,
  clusterResourcesRequest,
  clusterRigAction,
  clusterRunnerRequest,
  HARNESS_LEAST,
  leastRigSize,
  removeRunner,
  SUPERVISOR_SHARE,
  setClusterRigResources,
  setClusterSlots,
  setReachableAddresses,
  updateRigImages,
} from "../clusters/index.ts";
import { CUDA_VERSIONS, type CudaVersion } from "../rigs/index.ts";
import type { ToolContext } from "./context.ts";

/** Rigs on clusters, as Add a rig and Providers do them: the owner and operators. */
export function registerAddClusterRig(tools: ToolContext): void {
  const { server, opts, actor, canCommand, audited } = tools;

  if (canCommand) {
    server.registerTool(
      "add_cluster_rig",
      {
        title: "Add a rig on a cluster",
        description: `Adds a rig on a Kubernetes cluster in Settings › Machines, as Rigs › Add a rig does, with the same checks, and sets it up in the background (follow it with list_rigs and the rig's setup events). For a cluster of slots, name a free slot. CPUs and memory default to what the slot's quota allows; a new rig's agent programs run in their own terminals, so its supervisor takes a quarter of the CPUs (at least half a CPU, at most 2) and ${SUPERVISOR_SHARE.terminal.memoryGi} GiB of them and the harness the rest, and a size below ${leastRigSize("terminal").cpus} CPUs and ${leastRigSize("terminal").memoryGi} GiB is refused. The rig's first key may wait for the owner's acceptance.`,
        inputSchema: {
          rig: z.string().min(1).describe(RIG_ID_SENTENCE),
          cluster: z.string().min(1),
          slot: z.string().min(1).optional(),
          gpus: z.number().int().min(0).default(0),
          judge_gpus: z.number().int().min(0).optional(),
          gpu_mode: z.string().optional().describe('"device-plugin", or "dra:<device class>"'),
          node: z.string().min(1).optional(),
          storage_class: z.string().min(1).optional(),
          storage_gb: z.number().int().min(1).optional(),
          cpus: z.number().positive().optional(),
          memory_gib: z.number().positive().optional(),
          cuda: z
            .enum(CUDA_VERSIONS)
            .optional()
            .describe(
              'For a rig with GPUs, the CUDA harness it runs: "12" (the default: Pascal to Hopper, amd64) or "13" (Turing to Blackwell, and the DGX Spark on arm64). Updates keep it',
            ),
          judge_on_runners: z
            .boolean()
            .optional()
            .describe(
              "True: the rig's judge measures on its runners of other machines alone, never on its own machine: a core with no GPU, whose runners add_cluster_runner adds. Its judge's jobs wait until one of the judge's or the shared pool answers",
            ),
        },
      },
      audited(
        "add_cluster_rig",
        async (a: {
          rig: string;
          cluster: string;
          slot?: string;
          gpus: number;
          judge_gpus?: number;
          gpu_mode?: string;
          node?: string;
          storage_class?: string;
          storage_gb?: number;
          cpus?: number;
          memory_gib?: number;
          cuda?: CudaVersion;
          judge_on_runners?: boolean;
        }) => {
          const r = await addClusterRig(
            opts.parts,
            {
              rig: a.rig,
              cluster: a.cluster,
              slot: a.slot,
              gpus: a.gpus,
              judgeGpus: a.judge_gpus,
              mode: a.gpu_mode,
              node: a.node,
              storageClass: a.storage_class,
              storageGi: a.storage_gb,
              cpus: a.cpus,
              memoryGi: a.memory_gib,
              cuda: a.cuda,
              judgeOnRunners: a.judge_on_runners,
            },
            actor,
          );
          if ("error" in r) throw new Error(r.error);
          return { rig: r.rig, status: "deploying" };
        },
      ),
    );
  }
}

/**
 * A rig's runner processes on clusters (goal 206), as Edit rig's Runners does them: the owner's
 * alone, as the rig's runners setting is, since they decide where its judge measures.
 */
export function registerRunners(tools: ToolContext): void {
  const { server, opts, actor, role, audited } = tools;
  if (role !== "owner") return;
  server.registerTool(
    "add_cluster_runner",
    {
      title: "Add a runner on a cluster",
      description:
        "Sets up a runner process for a rig on a Kubernetes cluster in Settings › Machines, as Edit rig's Runners does: a harness and a supervisor started as a runner, on one node, with one GPU or none, a volume and a token of their own. Then control gives it to the rig, whose core takes it while its run goes on: it takes runs of its pool once it answers. A slot may hold the rig's core and its runners, never another rig's. Returns {rig, runner, said}; follow it on the rig's page or with rig_settings.",
      inputSchema: { rig: z.string().min(1), ...ClusterRunnerBody.shape },
    },
    audited("add_cluster_runner", async (a: ClusterRunnerBody & { rig: string }) => {
      const { rig, ...body } = a;
      const r = await addClusterRunner(opts.parts, clusterRunnerRequest(rig, body), actor);
      if ("error" in r) throw new Error(r.error);
      return r;
    }),
  );
  server.registerTool(
    "remove_runner",
    {
      title: "Take a runner away from a rig",
      description:
        "Takes a runner process away from a rig, as Edit rig's Remove does: the rig hears first, so its core stops the runner's run under way, which the judge queues again or its lane is told of; then control removes what it set up on the cluster, and the runner's token stops working. A runner process someone started by hand only leaves the rig. Returns {rig, runner, said}.",
      inputSchema: { rig: z.string().min(1), runner: z.string().min(1) },
    },
    audited("remove_runner", async (a: { rig: string; runner: string }) => {
      const r = await removeRunner(opts.parts, a.rig, a.runner, actor);
      if ("error" in r) throw new Error(r.error);
      return { rig: a.rig, runner: a.runner, said: r.ok };
    }),
  );
}

/**
 * A cluster rig stopped, started or restarted, moved onto new images or a new size, and a
 * cluster's slots, as a rig's page, Edit rig and Providers do them: the owner and operators.
 */
export function registerClusterRigs(tools: ToolContext): void {
  const { server, opts, actor, role, canCommand, audited } = tools;

  if (canCommand) {
    server.registerTool(
      "cluster_rig",
      {
        title: "Stop, start or restart a cluster rig",
        description:
          "For a rig control set up on a cluster, as on its page: stop scales its pods to zero (its volume, tokens, runs and results stay); start brings them back on the images control recorded for it (so a stopped rig updated with update_rig_images starts on its new images); restart restarts its pods. After start or restart, rig_setup shows it starting, then running once its pods run and it reports, or failed.",
        inputSchema: { rig: z.string().min(1), action: z.enum(["stop", "start", "restart"]) },
      },
      audited("cluster_rig", async (a: { rig: string; action: "stop" | "start" | "restart" }) => {
        const r = await clusterRigAction(opts.parts, a.rig, a.action, actor);
        if ("error" in r) throw new Error(r.error);
        return { rig: a.rig, said: r.ok };
      }),
    );
  }
  if (canCommand) {
    server.registerTool(
      "update_rig_images",
      {
        title: "Update a rig's images",
        description:
          "For a rig control set up on a cluster: its pods restart on the images control now deploys, as the rig's page does. Its volume, tokens, runs and results stay. By default it drains first: while trials run or the judge has a job under way, the rig starts nothing new and its pods restart once those end (rig_setup shows it draining). wait false restarts them now, also during a drain: a trial in progress then stops, and its experiment goes back to the queue. Follow it with rig_setup and list_rigs. A failed update can be tried again; one already under way is refused.",
        inputSchema: {
          rig: z.string().min(1),
          wait: z
            .boolean()
            .optional()
            .describe(
              "Wait for the running trials and the judge's job to finish before the restart (default true); false: restart now",
            ),
          drain_minutes: clusterResourcesFields.drain_minutes,
        },
      },
      audited(
        "update_rig_images",
        async (a: { rig: string; wait?: boolean; drain_minutes?: number }) => {
          const r = await updateRigImages(opts.parts, a.rig, actor, {
            wait: a.wait,
            drainMinutes: a.drain_minutes,
          });
          if ("error" in r) throw new Error(r.error);
          return { rig: a.rig, said: r.ok };
        },
      ),
    );
  }
  // A cluster rig's GPUs, CPUs and memory (goal 118): the owner's and an operator's, within what
  // the slot and the cluster allow; the judge's share stays the owner's, as on Edit rig.
  if (canCommand) {
    const owner = role === "owner";
    server.registerTool(
      "set_cluster_rig_resources",
      {
        title: "Change a cluster rig's GPUs, CPUs and memory",
        description: `For a rig control set up on a cluster: changes how many GPUs its harness pod asks for, and its CPUs and memory, as Edit rig does, keeping its volume, tokens, runs and results. Give only what changes. Checked as Add a rig checks them: 1 to 16 GPUs through the rig's own way (NVIDIA's device plugin, against its nodes as control last read them, or its DRA device class); CPUs and memory both or neither (null for both: the namespace's defaults), with the supervisor's share for how the rig's agent programs run as its report says (a quarter of the CPUs, at least half a CPU and at most 2, and ${SUPERVISOR_SHARE.terminal.memoryGi} GiB in their own terminals; half a CPU and ${SUPERVISOR_SHARE.headless.memoryGi} GiB headless) and at least ${HARNESS_LEAST.cpus} CPU and ${HARNESS_LEAST.memoryGi} GiB for the harness, so at least ${leastRigSize("terminal").cpus} CPUs and ${leastRigSize("terminal").memoryGi} GiB, or ${leastRigSize("headless").memoryGi} GiB headless, for the size it keeps too; and, in a slot, the slot's quota (CPUs, memory, requests.nvidia.com/gpu, or the device class's devices), which control reads again first. A rig on the CPU can't take GPUs, nor a GPU rig move to none: add a new rig for that. With a new number of GPUs, judge_gpus sets the judge's share (1 to min(8, gpus - 1), the agents at most 8); left out, the judge gets half, rounded up, as when a rig is added, and a share the rig kept from Edit rig follows. Its pods restart with the new size on the images it runs, as update_rig_images moves them: by default it drains first (rig_setup shows it draining, and the change it waits for in pending); wait false restarts them now, also during its drain (a call with no other field then makes the change the drain waits for). Follow it with rig_setup and list_rigs. Returns {rig, said}. Refused in words: no such rig, one still being set up, updating, starting or draining for an image update, a value out of range or above the slot's quota, and judge_gpus without a new number of GPUs.${owner ? "" : " judge_gpus is the owner's alone: a call with it is refused, and nothing changes."}`,
        inputSchema: { rig: z.string().min(1), ...clusterResourcesFields },
      },
      audited("set_cluster_rig_resources", async (a: ClusterResourcesBody & { rig: string }) => {
        const { rig, ...body } = a;
        const r = await setClusterRigResources(
          opts.parts,
          rig,
          clusterResourcesRequest(body),
          actor,
          { wait: body.wait, owner, drainMinutes: body.drain_minutes },
        );
        if ("error" in r) throw new Error(r.error);
        return { rig, said: r.ok };
      }),
    );
  }
  if (canCommand) {
    server.registerTool(
      "set_cluster_slots",
      {
        title: "Set a cluster's slots",
        description:
          "For a cluster of pre-made slots in Settings › Machines: the namespaces control may use, one rig each. Control reads the cluster again, with each slot's network rules and quota. A slot that holds a rig must stay in the list.",
        inputSchema: { cluster: z.string().min(1), slots: z.array(z.string().min(1)).min(1) },
      },
      audited("set_cluster_slots", async (a: { cluster: string; slots: string[] }) => {
        const why = await setClusterSlots(opts.parts, a.cluster, a.slots, actor);
        if (why) throw new Error(why);
        return { cluster: a.cluster, slots: a.slots };
      }),
    );
  }
}

/**
 * The addresses cluster rigs' harnesses may reach beside the internet, as Settings keeps them: read
 * by the owner and the operator, set by the owner alone.
 */
export function registerReachableAddresses(tools: ToolContext): void {
  const { server, store, opts, actor, role, audited } = tools;
  if (role !== "owner" && role !== "operator") return;
  server.registerTool(
    "reachable_addresses",
    {
      title: "Addresses cluster rigs may reach",
      description:
        "The owner's list in Settings › Addresses rigs may reach: each address (one IPv4 or IPv6 host in the private, shared or link-local ranges) with the TCP ports cluster rigs' harnesses reach it on beside DNS and the internet, its note, and who set it when.",
      inputSchema: {},
    },
    audited("reachable_addresses", () => ({ addresses: store.reachable.list() })),
  );
  if (role !== "owner") return;
  server.registerTool(
    "set_reachable_addresses",
    {
      title: "Set the addresses cluster rigs may reach",
      description: `Sets the whole list in Settings › Addresses rigs may reach, in place of the one before (an empty list removes every address). Each entry: address, one IPv4 or IPv6 address in the private, shared or link-local ranges, never a range; ports, 1 to ${REACH_MAX_PORTS} TCP ports; note, what it is. At most ${REACH_MAX_ENTRIES} addresses, each once. Control writes the list at once into the network rules of each rig it set up in a namespace it created (a step "network" in each rig's history); a joined rig keeps the list its join command gave it; a slot's rules are its operators', and control's check of a slot accepts a rule that opens exactly a listed address on its listed ports. Returns {addresses, said}. The owner's token only.`,
      inputSchema: {
        addresses: z
          .array(
            z.object({
              address: z.string(),
              ports: z.array(z.number().int()),
              note: z.string().optional(),
            }),
          )
          .max(REACH_MAX_ENTRIES),
      },
    },
    audited("set_reachable_addresses", (a: { addresses: unknown[] }) => {
      const r = setReachableAddresses(opts.parts, a.addresses, actor);
      if ("error" in r) throw new Error(r.error);
      return { addresses: store.reachable.list(), said: r.ok };
    }),
  );
}
