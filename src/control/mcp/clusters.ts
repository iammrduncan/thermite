import { z } from "zod";
import { RIG_ID_SENTENCE } from "../../core/ids.ts";
import { REACH_MAX_ENTRIES, REACH_MAX_PORTS } from "../../core/reach.ts";
import {
  addClusterRig,
  type ClusterResourcesBody,
  clusterResourcesFields,
  clusterResourcesRequest,
  clusterRigAction,
  HARNESS_LEAST,
  leastRigSize,
  SUPERVISOR_SHARE,
  setClusterRigResources,
  setClusterSlots,
  setReachableAddresses,
  updateRigImages,
} from "../clusters/index.ts";
import type { ToolContext } from "./context.ts";

/** Rigs on clusters, as Add a rig and Providers do them: the owner and operators. */
export function registerAddClusterRig(tools: ToolContext): void {
  const { server, opts, actor, canCommand, audited } = tools;

  if (canCommand) {
    server.registerTool(
      "add_cluster_rig",
      {
        title: "Add a rig on a cluster",
        description: `Adds a rig on a Kubernetes cluster in Providers, as Rigs › Add a rig does, with the same checks, and sets it up in the background (follow it with list_rigs and the rig's setup events). For a cluster of slots, name a free slot. CPUs and memory default to what the slot's quota allows; a new rig's agent programs run in their own terminals, so its supervisor takes half a CPU and ${SUPERVISOR_SHARE.terminal.memoryGi} GiB of them and the harness the rest, and a size below ${leastRigSize("terminal").cpus} CPUs and ${leastRigSize("terminal").memoryGi} GiB is refused. The rig's first key may wait for the owner's acceptance.`,
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
        description: `For a rig control set up on a cluster: changes how many GPUs its harness pod asks for, and its CPUs and memory, as Edit rig does, keeping its volume, tokens, runs and results. Give only what changes. Checked as Add a rig checks them: 1 to 16 GPUs through the rig's own way (NVIDIA's device plugin, against its nodes as control last read them, or its DRA device class); CPUs and memory both or neither (null for both: the namespace's defaults), with the supervisor's share for how the rig's agent programs run as its report says (half a CPU and ${SUPERVISOR_SHARE.terminal.memoryGi} GiB in their own terminals, ${SUPERVISOR_SHARE.headless.memoryGi} GiB headless) and at least ${HARNESS_LEAST.cpus} CPU and ${HARNESS_LEAST.memoryGi} GiB for the harness, so at least ${leastRigSize("terminal").cpus} CPUs and ${leastRigSize("terminal").memoryGi} GiB, or ${leastRigSize("headless").memoryGi} GiB headless, for the size it keeps too; and, in a slot, the slot's quota (CPUs, memory, requests.nvidia.com/gpu, or the device class's devices), which control reads again first. A rig on the CPU can't take GPUs, nor a GPU rig move to none: add a new rig for that. With a new number of GPUs, judge_gpus sets the judge's share (1 to min(8, gpus - 1), the agents at most 8); left out, the judge gets half, rounded up, as when a rig is added, and a share the rig kept from Edit rig follows. Its pods restart with the new size on the images it runs, as update_rig_images moves them: by default it drains first (rig_setup shows it draining, and the change it waits for in pending); wait false restarts them now, also during its drain (a call with no other field then makes the change the drain waits for). Follow it with rig_setup and list_rigs. Returns {rig, said}. Refused in words: no such rig, one still being set up, updating, starting or draining for an image update, a value out of range or above the slot's quota, and judge_gpus without a new number of GPUs.${owner ? "" : " judge_gpus is the owner's alone: a call with it is refused, and nothing changes."}`,
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
          "For a cluster of pre-made slots in Providers: the namespaces control may use, one rig each. Control reads the cluster again, with each slot's network rules and quota. A slot that holds a rig must stay in the list.",
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
        "The owner's list in Settings › Addresses cluster rigs may reach: each address (one IPv4 or IPv6 host in the private, shared or link-local ranges) with the TCP ports cluster rigs' harnesses reach it on beside DNS and the internet, its note, and who set it when.",
      inputSchema: {},
    },
    audited("reachable_addresses", () => ({ addresses: store.reachable.list() })),
  );
  if (role !== "owner") return;
  server.registerTool(
    "set_reachable_addresses",
    {
      title: "Set the addresses cluster rigs may reach",
      description: `Sets the whole list in Settings › Addresses cluster rigs may reach, in place of the one before (an empty list removes every address). Each entry: address, one IPv4 or IPv6 address in the private, shared or link-local ranges, never a range; ports, 1 to ${REACH_MAX_PORTS} TCP ports; note, what it is. At most ${REACH_MAX_ENTRIES} addresses, each once. Control writes the list at once into the network rules of each rig it set up in a namespace it created (a step "network" in each rig's history); a joined rig keeps the list its join command gave it; a slot's rules are its operators', and control's check of a slot accepts a rule that opens exactly a listed address on its listed ports. Returns {addresses, said}. The owner's token only.`,
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
