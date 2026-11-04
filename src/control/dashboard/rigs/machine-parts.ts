import type { FollowerPools, LeaderPool } from "../../../core/followers.ts";
import type { MachineFacts } from "../../machines/index.ts";
import type { SecretBox } from "../../secrets.ts";
import type { ControlStore, MachineRig } from "../../store/index.ts";

/**
 * Each machine of a rig control set up over SSH (goal 205): its leader, then each follower, with
 * how control reaches it, its GPUs and whether its units are a follower's. A rig of one machine
 * is its leader alone. A machine gone from Settings › Machines is named, so a step says so.
 */
export function machinesOfRig(
  store: ControlStore,
  secrets: SecretBox,
  r: MachineRig,
): {
  machine: string;
  gpus: number[];
  pools?: FollowerPools | undefined;
  root: boolean;
  follower?: string | undefined;
  target?:
    | { address: string; port: number; user: string; privateKey: string; hostKeys: string[] }
    | undefined;
}[] {
  const targetOf = (name: string) => {
    const m = store.machines.get(name);
    return m
      ? {
          address: m.address,
          port: m.port,
          user: m.user,
          privateKey: secrets.open(m.key_sealed),
          hostKeys: m.host_keys,
        }
      : undefined;
  };
  const rootOf = (name: string) =>
    (store.machines.get(name)?.facts as MachineFacts | null | undefined)?.root === true;
  return [
    { machine: r.machine, gpus: r.gpus, root: r.root, target: targetOf(r.machine) },
    ...(r.followers?.machines ?? []).map((f) => ({
      machine: f.machine,
      // The judge's first, then the workers': the container numbers them so.
      gpus: [...f.gpus, ...(f.workers ?? [])],
      pools: poolsOf(f),
      root: rootOf(f.machine),
      follower: f.machine,
      target: targetOf(f.machine),
    })),
  ];
}

/** A machine rig's follower's GPUs by pool (core/followers.ts). */
export const poolsOf = (f: NonNullable<MachineRig["followers"]>["machines"][number]) => ({
  judge: f.gpus.length,
  workers: f.workers?.length ?? 0,
  ...(f.cpu ? { cpu: f.cpu } : {}),
});

/** Whose a machine rig's leader's own GPUs are. */
export const leaderPoolOf = (r: MachineRig): LeaderPool =>
  r.followers?.judgeHere === false
    ? "workers"
    : r.followers?.lanesHere === false
      ? "judge"
      : "shared";
