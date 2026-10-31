import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { rigSetupView, SETUP_STEPS } from "../rigs/index.ts";
import type { RunpodRigs } from "../runpod/index.ts";
import type { ControlStore } from "../store/index.ts";
import {
  TRIAL_SESSION_INPUT,
  TRIAL_SESSION_WORDS,
  type TrialSessionArgs,
  trialSession,
} from "../trial-session.ts";

/** A tool's handler whose calls are in control's audit log (mcp/context.ts's `audited`). */
export type Audited = <A>(
  tool: string,
  fn: (args: A) => unknown,
) => (args: A) => Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }>;

/**
 * MCP's reads of a rig for whoever runs control, never a campaign's agents: how control set it up
 * (rig_setup) and its trials' sessions (trial_session, goal 139). `details`: a failed setup step's
 * detail can name a cluster's API server or a host, so only the owner and an operator read it.
 */
export function registerRigReads(
  server: McpServer,
  audited: Audited,
  store: ControlStore,
  runpodRigs: RunpodRigs | undefined,
  details: boolean,
): void {
  server.registerTool(
    "rig_setup",
    {
      title: "How a rig was set up",
      description:
        "For a rig control set up or manages on a machine, a cluster or RunPod: where it is, its status there (for example deploying, running, updating, stopped; on RunPod, the pod's status and the change under way) and the newest steps of its setup and management (steps, 20 by default, up to 500; steps_total counts them all), oldest first (applied, pods running, first report, images updated, new GPUs, CPUs or memory, a RunPod pod launched, stopped, started or terminated, a full reset, failures with why). On a cluster, also its GPUs, the judge's share, its CPUs and memory, and the change of size it drains for. Use it after add_cluster_rig, update_rig_images, set_cluster_rig_resources or runpod_rig. Holds no keys or tokens.",
      inputSchema: {
        rig: z.string().min(1),
        steps: z.number().int().min(1).max(500).default(SETUP_STEPS),
      },
    },
    audited("rig_setup", (a: { rig: string; steps: number }) =>
      rigSetupView(store, runpodRigs, a.rig, a.steps, details),
    ),
  );
  server.registerTool(
    "trial_session",
    {
      title: "A trial's session",
      description: TRIAL_SESSION_WORDS,
      inputSchema: TRIAL_SESSION_INPUT,
    },
    audited("trial_session", (a: TrialSessionArgs) => trialSession(store, a)),
  );
}
