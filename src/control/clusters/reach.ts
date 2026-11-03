import { type ReachEntry, ReachList } from "../../core/reach.ts";
import { inBackground } from "../background.ts";
import type { ControlParts } from "../parts.ts";
import type { ClusterRig } from "../store/index.ts";
import { kubeError } from "./kubectl.ts";
import { asList, clusterRigNetwork } from "./manifests.ts";
import { reachedAnyway } from "./netcheck.ts";
import { clusterPlan, clusterTarget } from "./rigs.ts";

/**
 * The owner's list of addresses cluster rigs' harnesses may reach beside the internet
 * (core/reach.ts), as Settings, REST and MCP set it: checked, kept, and written at once into the
 * network rules of each rig control set up in a namespace it created. A joined rig took the list
 * its manifest held when its join command ran; a slot's rules are its operators', which control's
 * check of the slot reads against the list.
 */

/** A path in the list, in words: "addresses[1].ports[0]: ". */
const pathWords = (path: PropertyKey[]) =>
  path.length
    ? `${path.map((k, i) => (typeof k === "number" ? `[${k}]` : `${i ? "." : ""}${String(k)}`)).join("")}: `
    : "";

/** The list as given, checked; why not, in words. */
export function reachListOf(raw: unknown): { list: ReachEntry[] } | { error: string } {
  const r = ReachList.safeParse(raw);
  if (!r.success)
    return {
      error: r.error.issues
        .map((i) => `${pathWords(["addresses", ...i.path])}${i.message}`)
        .join("; "),
    };
  const anyway = r.data.find((e) => reachedAnyway(e.address));
  if (anyway)
    return {
      error: `${anyway.address} is outside the private, shared and link-local ranges: rigs' harnesses reach it already, on every port`,
    };
  return { list: r.data };
}

/** The rigs whose network rules control writes and changes: those in namespaces it created. */
const rigsToChange = (parts: ControlParts): ClusterRig[] =>
  parts.store.clusters
    .rigs()
    .filter((r) => r.placement === "created" && !["removed", "deploying"].includes(r.status));

/**
 * Keeps the list, in place of the one before, and applies the network rules of each rig in a
 * namespace control created, in the background: each apply is a step in the rig's history.
 * Says what it did, or why not, in words.
 */
export function setReachableAddresses(
  parts: ControlParts,
  raw: unknown,
  by: string,
): { ok: string; list: ReachEntry[] } | { error: string } {
  const checked = reachListOf(raw);
  if ("error" in checked) return checked;
  const { list } = checked;
  parts.store.reachable.set(list, by);
  const rigs = rigsToChange(parts);
  for (const r of rigs)
    void inBackground(parts.store, "cluster", r.rig, "network", applyNetwork(parts, r, list));
  const n = list.length;
  const kept = n ? `${n} address${n === 1 ? "" : "es"}` : "no address";
  const applied = rigs.length
    ? ` Control applies it to the network rules of ${rigs.map((r) => r.rig).join(", ")} now.`
    : "";
  return { ok: `The list holds ${kept}.${applied}`, list };
}

/** Applies a rig's two network rules again, with the list as it is now. */
async function applyNetwork(parts: ControlParts, r: ClusterRig, list: ReachEntry[]): Promise<void> {
  const k = parts.store.clusters.get(r.cluster);
  if (!k) throw new Error(`the cluster ${r.cluster} is no longer in Providers`);
  const objects = clusterRigNetwork({ ...clusterPlan(parts, r), reach: list });
  const out = await parts.kube.kubectl(
    clusterTarget(parts, k),
    ["apply", "-f", "-"],
    asList(objects),
    60_000,
  );
  if (out.code !== 0) throw new Error(kubeError(out));
  const n = list.length;
  parts.store.rigHistory.add(
    r.rig,
    "network",
    true,
    n ? `${n} address${n === 1 ? "" : "es"} of the list` : "no address of the list",
  );
}
