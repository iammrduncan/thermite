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
      gpus: f.gpus,
      root: rootOf(f.machine),
      follower: f.machine,
      target: targetOf(f.machine),
    })),
  ];
}
