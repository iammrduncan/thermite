import { log } from "../../common/env.ts";
import type { ControlStore } from "../store/index.ts";

/**
 * Whether a rig reaches control's message bus (goal 168, step 5c): the one way a rig and control
 * talk, but for the registration of its keys and its large files. A rig that can't reach it
 * doesn't work, and its page, the rigs list and Needs you show it broken, in words, with what to
 * do. Control knows a rig is off the bus three ways:
 * - it calls control over HTTPS with no keys on the bus: a rig of v0.1.0, or one set up without
 *   the bus, which reports over HTTP and must be set up again;
 * - it registered its keys over HTTPS, and nothing came from it on the bus since: it can't reach
 *   the bus's address, or the bus refuses it;
 * - it is a pod on RunPod that control's bus can't dial: launched before its leaf node, or one
 *   RunPod gives no public address for the leaf node's port.
 */

/** The step in a rig's history each registration of its keys over HTTPS adds. */
export const BUS_REGISTERED_STEP = "bus_registered";
/** The step a rig's call over HTTPS with no keys on the bus adds, once a day at most. */
export const BUS_OFF_STEP = "bus_off";

/**
 * How long after its registration a rig has to report on the bus, or after RunPod took its pod's
 * address away, before it shows broken: a supervisor reports every minute by default.
 */
export const BUS_REACH_GRACE_MS = 5 * 60_000;
/** How long a call over HTTPS with no keys keeps a rig shown broken: it calls every round. */
const OFF_CALL_KEPT_MS = 15 * 60_000;
/** How often a rig's calls with no keys add a step to its history, at most. */
const OFF_STEP_EVERY_MS = 24 * 3_600_000;

/** Why a rig is off the bus, in words, and since when. */
export interface OffBus {
  /** "http": it calls with no keys; "silent": registered, nothing on the bus since; "leaf": RunPod. */
  why: "http" | "silent" | "leaf";
  /** What control knows, in words: one sentence, or two. */
  words: string;
  since: string;
}

/** The rigs that called control over HTTPS with no keys on the bus, by rig: first and last call. */
const offCalls = new WeakMap<ControlStore, Map<string, { first: string; last: string }>>();

/**
 * Notes a rig's call over HTTPS with no keys on the bus: it shows broken while it calls, and its
 * history says so once a day.
 */
export function noteOffBusCall(store: ControlStore, rig: string, now = new Date()): void {
  const at = now.toISOString();
  const calls = offCalls.get(store) ?? new Map<string, { first: string; last: string }>();
  offCalls.set(store, calls);
  const was = calls.get(rig);
  calls.set(rig, { first: was?.first ?? at, last: at });
  const last = store.rigHistory.latest(rig, [BUS_OFF_STEP], 1)[0];
  if (last && now.getTime() - Date.parse(last.at) < OFF_STEP_EVERY_MS) return;
  store.rigHistory.add(
    rig,
    BUS_OFF_STEP,
    false,
    "it reports over HTTP, which control no longer takes",
  );
  log("control", "a rig calls over HTTP with no keys on the message bus", { rig }, "warn");
}

/** A registration of a rig's keys over HTTPS: a step in its history, and its calls with no keys forgotten. */
export function noteRegistered(store: ControlStore, rig: string): void {
  offCalls.get(store)?.delete(rig);
  store.rigHistory.add(rig, BUS_REGISTERED_STEP, true, "over HTTPS, at the supervisor's start");
}

/**
 * Whether a rig is off the bus, and why; undefined while nothing says so. `lastSeen` is when
 * control last took a report of it (ISO; empty or 0: never); `podStopped`: a RunPod rig whose pod
 * is stopped, which reaches nothing and is not broken.
 */
export function offBus(
  store: ControlStore,
  rig: string,
  o: { lastSeen: string; now: number; podStopped?: boolean | undefined },
): OffBus | undefined {
  const call = offCalls.get(store)?.get(rig);
  if (call && o.now - Date.parse(call.last) < OFF_CALL_KEPT_MS)
    return {
      why: "http",
      since: call.first,
      words:
        "It calls control over HTTP, with no keys on the message bus: it runs a version from before the bus was the only way (such as v0.1.0), or it was set up without the bus. Control takes a rig's reports, commands and config only on the bus.",
    };
  if (o.podStopped) return undefined;
  const seen = Date.parse(o.lastSeen) || 0;
  const pod = store.tunnels.get(rig);
  if (pod?.enrolled_at && !pod.leaf_ca)
    return {
      why: "leaf",
      since: pod.enrolled_at,
      words:
        "Its pod was launched before RunPod's rigs joined the message bus through a leaf node in the pod, so control's bus can't reach it.",
    };
  const noAddressSince = pod?.leaf_address_at ?? pod?.enrolled_at;
  if (
    pod?.enrolled_at &&
    !pod.leaf_address &&
    noAddressSince &&
    o.now - Date.parse(noAddressSince) > BUS_REACH_GRACE_MS &&
    seen < Date.parse(noAddressSince)
  )
    return {
      why: "leaf",
      since: noAddressSince,
      words:
        "RunPod gives its pod no public address for the leaf node's port (7422), so control's bus can't dial it, and nothing comes from it.",
    };
  const registered = store.rigHistory.latest(rig, [BUS_REGISTERED_STEP], 1)[0];
  if (
    registered &&
    seen < Date.parse(registered.at) &&
    o.now - Date.parse(registered.at) > BUS_REACH_GRACE_MS
  )
    return {
      why: "silent",
      since: registered.at,
      words:
        "It registered its keys with control over HTTPS, but nothing came from it on the message bus since: it can't reach the bus's address, or the bus refuses it.",
    };
  return undefined;
}

/**
 * What the owner does about a rig off the bus, in words, by where it runs: a rig of an older
 * version, or one set up without the bus, is set up again; one that can't reach the bus needs its
 * way there; a pod RunPod gives no address is launched again.
 */
export function offBusFix(store: ControlStore, rig: string, off: OffBus): string {
  if (off.why === "silent")
    return "Check that the rig reaches the bus's address and port (4222 unless control says otherwise on Add a rig), through every firewall and network rule between them, and read the supervisor's log, which says why it could not sign in.";
  if (store.tunnels.get(rig))
    return off.why === "leaf" && store.tunnels.get(rig)?.leaf_ca
      ? "Terminate the rig, and launch a new one: RunPod may give the new pod a public address. A pod with no public address can't join the bus in this version."
      : "Terminate the rig, and launch a new one on control's image: a pod's settings can't change.";
  if (store.machines.rig(rig))
    return "Update it from its page: control writes its files again with the bus's address and control's authority. The machine must reach the bus's port.";
  if (store.clusters.rig(rig))
    return "Update its images from its page: its deployments get the bus's address and control's authority. The cluster's network rules must let it reach the bus's port.";
  if (store.joinedRigs.get(rig))
    return "Remove it where it runs, with the command on its page, then make a new join command there and run it where the rig is.";
  return "Set it up again with this version: the compose stack's new images and compose file; for a rig set up by hand, this version's images, with THERMITE_NATS_URL and THERMITE_NATS_CA_FILE for its supervisor as `thermite rig add` writes them.";
}
