import { judgeShareOf } from "../clusters/index.ts";
import type { RigBus } from "../machines/index.ts";
import type { ControlParts } from "../parts.ts";
import type { ClusterRig } from "../store/index.ts";

/**
 * What setting a rig up takes, wherever control sets it up (on a machine, on a cluster, or where
 * the owner joins it): the images and the address it gets, a free name, the judge's share of its
 * GPUs, the wait for its first report, and each step of its history in words.
 */

/** The images a rig control sets up runs: the harness (CPU, and CUDA for GPU rigs), the supervisor. */
export interface RigImages {
  harness: string;
  harnessCuda?: string | undefined;
  supervisor: string;
}

/** The steps of an update, in words (the rig's page and its history), as update.ts records them. */
export const UPDATE_STEP_WORDS: Record<string, string> = {
  update_started: "Update to control's version asked",
  update_paused: "Its runs paused at a safe point",
  update_images: "Its containers moved onto control's images",
  update_reported: "A report reached control from control's version",
  update_isolation: "The isolation check after the update",
  update_resumed: "Its runs resumed",
  update_failed: "The update stopped",
};

/** Each step of a rig's history (set up, moved, stopped, failed) in words, as its page shows it. */
export const STEP_WORDS: Record<string, string> = {
  enrolled: "Enrolled with control: a token of its own",
  deployed: "Files and units written, images ready, services started",
  first_report: "First report reached control",
  deploy: "Setting it up",
  stop: "Stopped",
  start: "Started",
  restart: "Restarted",
  remove: "Removed from the machine",
  applied: "Its objects applied in the cluster: namespace, secret, volume, deployments",
  remove_cluster: "Removed from the cluster",
  join_made: "Join command made",
  join_revoked: "Join command revoked",
  join_used: "Join command used: the rig fetched its files from control",
  retired: "Retired: its token no longer works",
  drain: "Draining: it starts nothing new until its work ends",
  images: "Its deployments applied with new images",
  images_running: "Its pods run the new images",
  report_after_images: "A report reached control from the new images",
  pods_running: "Its pods run again",
  report_after_start: "A report reached control after the start",
  resources: "Its deployments applied with new GPUs, CPUs or memory",
  resources_running: "Its pods run with the new GPUs, CPUs or memory",
  report_after_resources: "A report reached control after the change",
  network: "Its network rules applied with the list of addresses rigs may reach",
  model_started: "Model download started",
  model_done: "Model downloaded, its SHA-256 checked",
  model_refused: "Model refused: its SHA-256 did not match, and the file was deleted",
  model_failed: "Model download stopped",
  check: "Control checked where it runs",
  bus_key: "Its key on the message bus registered",
  bus_key_changed: "Its key on the message bus changed",
  seal_key: "Its seal key for its config on the message bus registered",
  seal_key_changed: "Its seal key for its config on the message bus changed",
  bus_key_refused: "Its new key on the message bus refused: another rig or control holds it",
  seal_key_refused: "Its new seal key refused: another rig holds it",
  bus_keys_seen: "You saw the change of its keys on the message bus",
  bus_registered: "It registered its keys on the message bus with control",
  bus_off:
    "It calls control over HTTP with no keys on the message bus: it is broken until it is set up again",
  ...UPDATE_STEP_WORDS,
};

/**
 * Why control can't set a rig up without its message bus's address for rigs, in words: a rig
 * reaches control only on the bus.
 */
export const NO_RIG_BUS =
  "Control has no address for rigs on its message bus (THERMITE_NATS_PUBLIC_URL, or the host of THERMITE_CONTROL_PUBLIC_URL with port 4222), so a rig could not reach it: a rig works only on the bus.";

/** The bus as the rigs control sets up reach it; throws NO_RIG_BUS without one. */
export function rigBusOf(parts: Pick<ControlParts, "rigBus">): RigBus {
  if (!parts.rigBus) throw new Error(NO_RIG_BUS);
  return parts.rigBus;
}

/** Whether a new rig can't take this name: a rig has it already, or it is a page's ("add"). */
export const rigTaken = (parts: ControlParts, rig: string) =>
  rig === "add" ||
  parts.store.enrollments.knownRig(rig) ||
  Boolean(parts.store.machines.rig(rig)) ||
  Boolean(parts.store.clusters.rig(rig)) ||
  Boolean(parts.store.joinedRigs.get(rig)) ||
  parts.views().some((u) => u.id === rig);

// The judge's share as typed in a form, by the one rule of clusters/resources.ts.
export const judgeShare = (raw: string, n: number) =>
  judgeShareOf(raw ? Number(raw) : undefined, n);

/** The images control deploys for a rig with these GPUs, or why it has none. */
export const controlImages = (
  parts: ControlParts,
  gpus: number,
): ClusterRig["spec"]["images"] | string => {
  const images = parts.rigImages;
  if (!images) return "Control has no rig images configured.";
  if (gpus && !images.harnessCuda)
    return "Control has no CUDA harness image configured (THERMITE_RIG_HARNESS_CUDA_IMAGE).";
  return {
    harness: gpus ? (images.harnessCuda as string) : images.harness,
    supervisor: images.supervisor,
  };
};

/** Control's address for rigs, as a supervisor's CONTROL_URL has it. */
export const controlAddress = (parts: ControlParts) => parts.publicUrl?.replace(/\/$/, "");

// The wait for a new rig's first report never keeps control (or a test) from exiting.
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms).unref());

/**
 * Waits for a new rig's first report (or, with `after`, a report after that time), for at most
 * 10 minutes; a setup event either way.
 */
export async function awaitFirstReport(
  parts: ControlParts,
  rig: string,
  setStatus: (s: string) => void,
  minutes = 10,
  after?: number,
  o: { step?: string; still?: () => boolean } = {},
) {
  const { store } = parts;
  const step = o.step ?? (after === undefined ? "first_report" : "report_after_images");
  const deadline = Date.now() + minutes * 60_000;
  while (Date.now() < deadline) {
    // Stopped or removed meanwhile: the wait ends with nothing to say.
    if (o.still && !o.still()) return;
    if (
      parts
        .views()
        .some((u) => u.id === rig && (after === undefined || Date.parse(u.last_seen) > after))
    ) {
      store.rigHistory.add(rig, step, true);
      setStatus("running");
      return;
    }
    await sleep(5000);
  }
  if (o.still && !o.still()) return;
  store.rigHistory.add(
    rig,
    step,
    false,
    `no report after ${minutes} minutes: it may not have started`,
  );
  setStatus("failed");
}
