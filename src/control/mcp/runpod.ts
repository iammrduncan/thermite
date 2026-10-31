import { z } from "zod";
import { RIG_ID_SENTENCE } from "../../core/ids.ts";
import { POD_CONFIG_ENV } from "../../core/tunnel.ts";
import { advanceResets, cancelReset, confirmReset } from "../lifecycle.ts";
import {
  DEFAULT_IDLE_STOP_MINUTES,
  type LaunchRequest,
  type LimitsChange,
  MIN_IDLE_STOP_MINUTES,
  POD_LOG_MAX_TAIL,
  POD_LOG_TAIL,
  runpodResetRefusal,
} from "../runpod/index.ts";
import type { ToolContext } from "./context.ts";

/**
 * RunPod: test pods (every token but the agent's lists them; the owner and operators start and
 * end them), and rigs launched on it, with their pod logs, limits and lifecycle (the owner's).
 */
export function registerRunpod(tools: ToolContext): void {
  const { server, store, opts, actor, role, canCommand, audited } = tools;

  const tests = opts.runpodTests;
  if (tests) {
    server.registerTool(
      "runpod_tests",
      {
        title: "RunPod test pods",
        description:
          "Test pods on a GPU cloud, newest first: where each is (phase), its GPU and price, its cost so far, and what it found in words (findings), with the probe's whole report. A test that is not active has had its pod removed.",
        inputSchema: {
          cloud: z.string().min(1).optional().describe("The GPU cloud's name in Providers"),
          limit: z.number().int().min(1).max(50).default(5),
        },
      },
      audited("runpod_tests", (a: { cloud?: string; limit: number }) =>
        tests.list(a.cloud, a.limit),
      ),
    );
    if (canCommand) {
      server.registerTool(
        "runpod_test_start",
        {
          title: "Start a RunPod test pod",
          description:
            "Spends money. Starts one pod of Thermite's CUDA harness image, or of the one-container rig image that a rig on RunPod starts from (its isolation self-test then also checks the supervisor's places), on a GPU cloud from Providers, to check that a rig can run there: root, capabilities, GPU device nodes, RunPod's variables, outbound HTTPS and Thermite's isolation self-test, then (by default) a stop and a start to see it gets its GPU back. Control removes the pod when the test ends; follow it with runpod_tests. One test per cloud at a time. Defaults: the cheapest GPU in stock on Secure cloud, control's test image, a 40 GB disk, no time limit.",
          inputSchema: {
            cloud: z.string().min(1).describe("The GPU cloud's name in Providers"),
            gpu: z.string().min(1).optional().describe("A GPU type's id or name"),
            cloud_type: z.enum(["SECURE", "COMMUNITY"]).optional(),
            image: z.string().min(1).optional(),
            disk_gb: z.number().int().min(10).max(2000).optional(),
            restart: z.boolean().optional(),
            stop_after_minutes: z
              .number()
              .min(5)
              .optional()
              .describe("Remove the pod after this many minutes whatever it is doing"),
          },
        },
        audited(
          "runpod_test_start",
          (a: {
            cloud: string;
            gpu?: string;
            cloud_type?: "SECURE" | "COMMUNITY";
            image?: string;
            disk_gb?: number;
            restart?: boolean;
            stop_after_minutes?: number;
          }) => {
            const { cloud, ...req } = a;
            return tests.start(cloud, req, actor);
          },
        ),
      );
      server.registerTool(
        "runpod_test_end",
        {
          title: "End a RunPod test pod",
          description: "Ends a test now: control removes its pod. Returns the test as it ends.",
          inputSchema: { id: z.string().min(1) },
        },
        audited("runpod_test_end", (a: { id: string }) => tests.end(a.id, actor)),
      );
    }
  }

  const launched = opts.runpodRigs;
  if (launched) {
    server.registerTool(
      "runpod_rigs",
      {
        title: "Rigs on RunPod",
        description:
          "Rigs the owner launched on a GPU cloud, newest first: each one's pod and its status at RunPod, what it was launched with, its price per hour, what it has cost so far (spend_usd), its enrollment, and the owner's spend limit and idle stop, if set.",
        inputSchema: {
          cloud: z.string().min(1).optional().describe("The GPU cloud's name in Providers"),
        },
      },
      audited("runpod_rigs", (a: { cloud?: string }) => launched.list(a.cloud)),
    );
    // The pod's log is the pod's own output, like a setup step's detail: the owner's and the
    // operator's, not a reader's (rig_setup gives readers no detail either).
    if (role === "owner" || role === "operator")
      server.registerTool(
        "runpod_rig_logs",
        {
          title: "A RunPod rig's pod log",
          description:
            "The newest lines of a RunPod rig's pod log, read now from RunPod's API with the GPU cloud's key: what the rig image printed (source container) and RunPod's own steps, such as the image pull (source system), oldest first. It shows why a pod runs but never enrolls, before control can see anything of the rig. Control stops reading once tail lines came, no line came for 2 seconds, or after 10 seconds. Spends nothing. Lines are redacted: what looks like a key or token is taken out.",
          inputSchema: {
            rig: z.string().min(1),
            tail: z
              .number()
              .int()
              .min(1)
              .optional()
              .describe(
                `Lines to read: ${POD_LOG_TAIL} when left out, ${POD_LOG_MAX_TAIL} at most`,
              ),
            source: z
              .enum(["container", "system"])
              .optional()
              .describe("One source only; left out: both"),
          },
        },
        audited(
          "runpod_rig_logs",
          (a: { rig: string; tail?: number; source?: "container" | "system" }) => {
            if (!launched.view(a.rig)) throw new Error(`no rig ${a.rig} on a GPU cloud`);
            return launched.logs(a.rig, {
              tail: a.tail === undefined ? undefined : Math.min(POD_LOG_MAX_TAIL, a.tail),
              source: a.source,
            });
          },
        ),
      );
    // Launching spends money: the owner's alone (owner, 2026-10-20). An operator may not.
    if (role === "owner") {
      server.registerTool(
        "runpod_launch",
        {
          title: "Launch a rig on RunPod",
          description: `Spends money. Launches a rig on a GPU cloud from Providers: one pod of Thermite's one-container rig image, in pull mode, billed by the hour until it is stopped or removed. Control enrolls it and follows its price and spend (runpod_rigs). Defaults: 1 GPU, Secure cloud on demand, any data center, control's rig image, a 40 GB container disk, a 100 GB volume, no spend limit, ${DEFAULT_IDLE_STOP_MINUTES === null ? "no idle stop" : `an idle stop of ${DEFAULT_IDLE_STOP_MINUTES} minutes`}. The owner's token only.`,
          inputSchema: {
            cloud: z.string().min(1).describe("The GPU cloud's name in Providers"),
            gpu: z.string().min(1).describe("A GPU type's id or name, from providers"),
            gpu_count: z.number().int().min(1).max(8).optional(),
            cloud_type: z.enum(["SECURE", "COMMUNITY"]).optional(),
            datacenter: z.string().min(1).optional().describe("A data center's id"),
            image: z.string().min(1).optional(),
            container_disk_gb: z.number().int().min(10).max(2000).optional(),
            volume_gb: z.number().int().min(10).max(10_000).optional(),
            rig: z.string().min(1).optional().describe(RIG_ID_SENTENCE),
            enroll_within_minutes: z
              .number()
              .positive()
              .optional()
              .describe("The enrollment code expires this long after the launch"),
            settings: z
              .partialRecord(z.enum(POD_CONFIG_ENV), z.string())
              .optional()
              .describe("The rig's settings at enrollment"),
            spend_limit_usd: z
              .number()
              .positive()
              .optional()
              .describe("Stop the pod once it has cost this much"),
            idle_stop_minutes: z
              .number()
              .min(MIN_IDLE_STOP_MINUTES)
              .nullable()
              .optional()
              .describe(
                "Stop the pod after this many minutes with no run at work: no run running, or every run paused, blocked or finished. null: no idle stop; left out: the default",
              ),
          },
        },
        audited("runpod_launch", (a: LaunchRequest & { cloud: string }) => {
          const { cloud, ...req } = a;
          return launched.launch(cloud, req, actor);
        }),
      );
      server.registerTool(
        "runpod_rig_limits",
        {
          title: "Set a RunPod rig's limits",
          description:
            "Sets or clears a RunPod rig's spend limit and idle stop. A number sets one, null clears it, and one left out stays. Control stops the pod when it reaches a limit that is set; its volume stays. The idle stop counts the minutes no run is at work: no run running, or every run paused, blocked or finished. The owner's token only.",
          inputSchema: {
            rig: z.string().min(1),
            spend_limit_usd: z.number().positive().nullable().optional(),
            idle_stop_minutes: z.number().min(MIN_IDLE_STOP_MINUTES).nullable().optional(),
          },
        },
        audited("runpod_rig_limits", (a: LimitsChange & { rig: string }) => {
          const { rig, ...change } = a;
          return launched.limits(rig, change, actor);
        }),
      );
      const pods = opts.runpodDriver;
      if (pods)
        server.registerTool(
          "runpod_rig",
          {
            title: "Stop, start, restart, terminate or reset a RunPod rig",
            description:
              'For a rig launched on RunPod; the owner\'s token only. stop: pauses its running runs, sends its results out of the pod (an export), then stops the pod; its GPU is no longer billed and its volume stays. start: starts a stopped pod and resumes the runs the stop paused; it says so when RunPod has no GPU free. restart: stops the pod and starts it again, with no export (its volume stays). terminate (confirm "terminate <rig>"): pauses its runs, sends every result out, and removes the pod only when all have left it; else it refuses, and the pod keeps running with its runs paused. reset (confirm "reset <rig>"): a full reset; every result leaves the pod, then the rig\'s state is wiped once you confirm with confirm_wipe; the pod and its GPU stay. cancel_reset cancels a reset before its wipe. A stop or a terminate takes minutes: follow it with runpod_rigs and rig_setup.',
            inputSchema: {
              rig: z.string().min(1),
              action: z.enum([
                "stop",
                "start",
                "restart",
                "terminate",
                "reset",
                "confirm_wipe",
                "cancel_reset",
              ]),
              confirm: z
                .string()
                .optional()
                .describe('For terminate: "terminate <rig>"; for reset: "reset <rig>"'),
            },
          },
          audited(
            "runpod_rig",
            async (a: {
              rig: string;
              action:
                | "stop"
                | "start"
                | "restart"
                | "terminate"
                | "reset"
                | "confirm_wipe"
                | "cancel_reset";
              confirm?: string;
            }) => {
              if (!launched.view(a.rig)) throw new Error(`no rig ${a.rig} on a GPU cloud`);
              const step = () =>
                advanceResets({
                  store,
                  privateKeyPem: opts.privateKeyPem,
                  driver: opts.driver,
                  staleAfterMs: opts.staleAfterMs,
                });
              const open = () => {
                const r = store.fullResets.open(a.rig);
                if (!r) throw new Error(`no full reset of ${a.rig} is under way`);
                return Number(r.id);
              };
              switch (a.action) {
                case "stop":
                  return pods.stop(a.rig, actor);
                case "start":
                  return pods.start(a.rig, actor);
                case "restart":
                  await pods.restart(a.rig, ["harness", "supervisor"], actor);
                  return launched.view(a.rig);
                case "terminate":
                  return pods.terminate(a.rig, actor, a.confirm ?? "");
                case "reset": {
                  if (a.confirm !== `reset ${a.rig}`)
                    throw new Error(`confirm with "reset ${a.rig}"`);
                  const refused = runpodResetRefusal(store, a.rig);
                  if (refused) throw new Error(refused);
                  const id = store.fullResets.create(a.rig, actor);
                  await step();
                  return {
                    rig: a.rig,
                    reset: store.fullResets.list(50).find((r) => Number(r.id) === id),
                  };
                }
                case "confirm_wipe": {
                  const id = open();
                  confirmReset(store, id, actor);
                  await step();
                  return {
                    rig: a.rig,
                    reset: store.fullResets.list(50).find((r) => Number(r.id) === id),
                  };
                }
                case "cancel_reset": {
                  const id = open();
                  cancelReset(store, id, actor);
                  return {
                    rig: a.rig,
                    reset: store.fullResets.list(50).find((r) => Number(r.id) === id),
                  };
                }
              }
            },
          ),
        );
    }
  }
}
