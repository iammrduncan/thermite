import { parseArgs } from "node:util";
import { errorText } from "../../common/errors.ts";
import {
  CLOUD_LAUNCH,
  CLOUD_RIGS,
  RESET,
  RESET_CANCEL,
  RESET_CONFIRM,
  RESETS,
  RESTART,
  RIGS,
  RUNPOD_LIMITS,
  RUNPOD_RIG,
  RUNPOD_START,
  RUNPOD_STOP,
  RUNPOD_TERMINATE,
} from "../../core/api/control/owner.ts";
import type { RunpodRigView } from "../../core/api/control/runpod.ts";
import { controlAt, orFail } from "../calls.ts";
import { fail } from "./shared.ts";
import { USAGE } from "./usage.ts";

/** thermite runpod: rigs launched on GPU clouds, and their pods. */
export async function thermiteRunpod(rest: string[]): Promise<void> {
  const [sub, ...args] = rest;
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      control: { type: "string" },
      "token-file": { type: "string" },
      json: { type: "boolean" },
      gpu: { type: "string" },
      gpus: { type: "string" },
      "cloud-type": { type: "string" },
      datacenter: { type: "string" },
      image: { type: "string" },
      disk: { type: "string" },
      volume: { type: "string" },
      rig: { type: "string" },
      "enroll-within": { type: "string" },
      setting: { type: "string", multiple: true },
      "spend-limit": { type: "string" },
      "idle-stop": { type: "string" },
    },
  });
  if (!values.control || !values["token-file"]) fail(USAGE);
  const control = controlAt(values.control, values["token-file"]);
  const { formatRunpodRigs, launchBody, lifecycleSaid, limitsBody, openResetOf } = await import(
    "../runpod.ts"
  );
  const named = positionals[0];
  try {
    if ((sub === "stop" || sub === "start" || sub === "restart" || sub === "terminate") && named) {
      const params = { rig: named };
      // Restart is the route every rig has; the others are RunPod's own.
      if (sub === "restart") await orFail(control.call(RESTART, { params, body: {} }));
      const rig = (await orFail(
        sub === "restart"
          ? control.call(RUNPOD_RIG, { params })
          : sub === "terminate"
            ? // Naming the rig in the command is the confirmation.
              control.call(RUNPOD_TERMINATE, {
                params,
                body: { confirm: `terminate ${named}` },
              })
            : control.call(sub === "stop" ? RUNPOD_STOP : RUNPOD_START, { params, body: {} }),
      )) as RunpodRigView;
      process.stdout.write(`${formatRunpodRigs([rig])}${lifecycleSaid(sub)}`);
      return;
    }
    // A rig on RunPod only: any other rig gets 404 here, and nothing starts.
    if (["reset", "confirm-wipe", "cancel-reset"].includes(sub ?? "") && named)
      await orFail(control.call(RUNPOD_RIG, { params: { rig: named } }));
    if (sub === "reset" && named) {
      const r = await orFail(
        control.call(RESET, { params: { rig: named }, body: { confirm: `reset ${named}` } }),
      );
      process.stdout.write(
        `Full reset ${r.reset} of ${named} started: its runs are paused, and every result leaves the pod. Check the export, then confirm the wipe with thermite runpod confirm-wipe ${named}.\n`,
      );
      return;
    }
    if ((sub === "confirm-wipe" || sub === "cancel-reset") && named) {
      const { resets } = await orFail(control.call(RESETS));
      const r = openResetOf(resets, named);
      const route = sub === "confirm-wipe" ? RESET_CONFIRM : RESET_CANCEL;
      await orFail(control.call(route, { params: { id: r.id }, body: {} }));
      process.stdout.write(
        sub === "confirm-wipe"
          ? `The wipe of reset ${r.id} is confirmed: ${named}'s state is wiped, and the pod and its GPU stay.\n`
          : `Reset ${r.id} is cancelled: nothing was wiped, and ${named}'s runs stay paused.\n`,
      );
      return;
    }
    if (sub === "launch" && named) {
      const rig = (await orFail(
        control.call(CLOUD_LAUNCH, { params: { name: named }, body: launchBody(values) }),
      )) as RunpodRigView;
      process.stdout.write(
        `${formatRunpodRigs([rig])}Launched: RunPod bills the pod from now. Control enrolls it once it runs; follow it with thermite runpod list.\n`,
      );
      return;
    }
    if (sub === "list") {
      const rigs = (
        named
          ? await orFail(control.call(CLOUD_RIGS, { params: { name: named } }))
          : ((await orFail(control.call(RIGS))).runpod ?? [])
      ) as RunpodRigView[];
      process.stdout.write(
        values.json ? `${JSON.stringify(rigs, null, 2)}\n` : formatRunpodRigs(rigs),
      );
      return;
    }
    if (sub === "limits" && named) {
      const rig = (await orFail(
        control.call(RUNPOD_LIMITS, { params: { rig: named }, body: limitsBody(values) }),
      )) as RunpodRigView;
      process.stdout.write(formatRunpodRigs([rig]));
      return;
    }
  } catch (err) {
    fail(errorText(err));
  }
  fail(USAGE);
}
