import { execFileSync } from "node:child_process";
import {
  chmodSync,
  chownSync,
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { errorText } from "../../common/errors.ts";
import { log, logWarn } from "../../common/log.ts";
import { type Broker, tryDo } from "./context.ts";
import {
  effectiveGpuLists,
  expectedNodeGroups,
  formatCpuList,
  type GpuLayout,
  LAYOUT_FILE,
  type LayoutRecord,
  nodeGroups,
  parseCpuList,
  parseIndexList,
  planDedicated,
  procBusDir,
  runCpus,
  runRole,
  savedJudgeGpus,
  shareCpus,
} from "./devices.ts";
import { IDS } from "./runner.ts";

/**
 * The GPU, as root, as devices.ts plans it: the device nodes' owner, group and mode (set at start
 * and kept so), the layout record the controller and the isolation selftest read, and the CPUs
 * timed runs are pinned to.
 */

export function deviceNodes(): string[] {
  if (!existsSync("/dev")) return [];
  return readdirSync("/dev")
    .filter((name) => name.startsWith("nvidia"))
    .map((name) => join("/dev", name))
    .filter((p) => !lstatSync(p).isDirectory());
}

/**
 * Puts every device node back to root, its expected group and 0660 if anything changed it. The
 * NVIDIA driver resets a node it opens for root (nvidia-uvm to 0666, for example), so any CUDA
 * process run as root in this container would otherwise open it to every role.
 */
export function assertDevices(broker: Broker, layout: GpuLayout | undefined): void {
  // Nodes this container can't regroup stay as they are; the fence keeps roles off them.
  if (!broker.groupsHold) return;
  for (const { node, gid } of expectedNodeGroups(deviceNodes(), layout)) {
    tryDo(`keep the group of ${node}`, () => {
      const st = statSync(node);
      if (st.uid === 0 && st.gid === gid && (st.mode & 0o777) === 0o660) return;
      chownSync(node, 0, gid);
      chmodSync(node, 0o660);
      log("broker", "a device node had changed; restored it", {
        node,
        was: `${st.uid}:${st.gid} ${(st.mode & 0o777).toString(8)}`,
        now: `0:${gid} 660`,
      });
    });
  }
}

/**
 * The CPUs timed runs are pinned to, by timing user (run, run-1, ...). THERMITE_RUN_CPUS is
 * "auto" (the default on a GPU rig: each judge card's local CPUs this container may use), "off",
 * or an explicit CPU list. With several judge cards the sets are made disjoint (shareCpus).
 */
export function chooseRunCpus(
  broker: Broker,
  layout: GpuLayout | undefined,
  lists: GpuLists,
): Record<string, string> | undefined {
  const want =
    broker.env.THERMITE_RUN_CPUS ?? (broker.env.THERMITE_TARGET === "cuda-gpu" ? "auto" : "off");
  if (want === "off") return undefined;
  const judges = layout?.judges ?? [];
  const count = Math.max(1, judges.length);
  const byRole = (lists: number[][]) =>
    Object.fromEntries(
      shareCpus(lists)
        .map((cpus, i) => [runRole(i), formatCpuList(cpus)] as const)
        .filter(([, cpus]) => cpus),
    );
  if (want !== "auto") return byRole(Array.from({ length: count }, () => parseCpuList(want)));
  try {
    const buses = judges.length
      ? judges.map((c) => c.bus)
      : [
          execFileSync(
            "nvidia-smi",
            [
              "--query-gpu=pci.bus_id",
              "--format=csv,noheader",
              "-i",
              String(parseIndexList(lists.judge, "THERMITE_GPU_INDEX")[0]),
            ],
            { encoding: "utf8" },
          ).trim(),
        ];
    const allowed = /^Cpus_allowed_list:\s*(\S+)$/m.exec(
      readFileSync("/proc/self/status", "utf8"),
    )?.[1];
    const perCard = buses.map((bus) => {
      const local = readFileSync(`/sys/bus/pci/devices/${procBusDir(bus)}/local_cpulist`, "utf8");
      return allowed ? parseCpuList(runCpus(local, allowed)) : [];
    });
    const pinned = byRole(perCard);
    if (!Object.keys(pinned).length) {
      log("broker", "timed runs are not pinned: the cards' local CPUs are not in this container", {
        allowed,
      });
      return undefined;
    }
    log("broker", "timed runs pinned to their judge card's local CPUs", { buses, pinned });
    return pinned;
  } catch (err) {
    log("broker", "timed runs are not pinned", { error: errorText(err) });
    return undefined;
  }
}

/** The judge's and the agents' cards this start uses (explicit lists, or the rig's GPU set split). */
export type GpuLists = ReturnType<typeof effectiveGpuLists>;
export const currentLists = (broker: Broker): GpuLists =>
  effectiveGpuLists(broker.env, savedJudgeGpus(broker.stateDir));

export function prepareDevices(broker: Broker, lists: GpuLists): GpuLayout | undefined {
  const nodes = deviceNodes();
  for (const p of nodes) {
    tryDo(`set the gpu group on ${p}`, () => {
      chownSync(p, 0, IDS.gpuGroup);
      chmodSync(p, 0o660);
    });
  }
  const layoutPath = join(broker.socketDir, LAYOUT_FILE);
  rmSync(layoutPath, { force: true });
  if (lists.dev === undefined) {
    // Shared mode: every node must now belong to root and the gpu group with mode 0660. If one
    // does not, the record says so and the controller neither times nor runs dev runs, rather
    // than leave the device open to roles that must not reach it.
    const wrong = nodes.filter((p) => {
      try {
        const st = statSync(p);
        return st.uid !== 0 || st.gid !== IDS.gpuGroup || (st.mode & 0o777) !== 0o660;
      } catch {
        return true;
      }
    });
    broker.groupsHold = wrong.length === 0;
    const shared: LayoutRecord = !wrong.length
      ? { ok: true, mode: "shared", nodes, fence: broker.fenceAbi ? "groups+landlock" : "groups" }
      : broker.fenceAbi
        ? { ok: true, mode: "shared", nodes, fence: "landlock" }
        : { ok: false, mode: "shared", error: `${wrong.join(", ")} kept another owner or mode` };
    if (wrong.length)
      log(
        "broker",
        broker.fenceAbi
          ? "the GPU's device nodes kept their owner and mode: only the Landlock fence keeps roles off them"
          : "could not restrict the GPU's device nodes",
        { nodes: wrong, landlock_abi: broker.fenceAbi },
      );
    writeFileSync(layoutPath, `${JSON.stringify(shared)}\n`, { mode: 0o644 });
    chmodSync(layoutPath, 0o644);
    return undefined;
  }
  // A dedicated development card. Anything that fails leaves the record saying why, and the
  // controller then neither times nor allows development runs (it does not fall back to
  // sharing, since both cards are visible).
  let record: LayoutRecord;
  let layout: GpuLayout | undefined;
  try {
    layout = planDedicated({
      smiCsv: execFileSync(
        "nvidia-smi",
        ["--query-gpu=index,uuid,pci.bus_id", "--format=csv,noheader"],
        { encoding: "utf8" },
      ),
      information: (bus, index) => {
        try {
          return readFileSync(`/proc/driver/nvidia/gpus/${bus}/information`, "utf8");
        } catch {
          return execFileSync("nvidia-smi", ["-q", "-i", String(index)], { encoding: "utf8" });
        }
      },
      nodes,
      judgeIndices: parseIndexList(lists.judge, "THERMITE_GPU_INDEX"),
      devIndices: parseIndexList(lists.dev, "THERMITE_DEV_GPU_INDEX"),
    });
    const kept: string[] = [];
    for (const { node, gid } of nodeGroups(layout)) {
      try {
        chownSync(node, 0, gid);
        chmodSync(node, 0o660);
      } catch {}
      const st = statSync(node);
      if (st.gid !== gid || (st.mode & 0o777) !== 0o660) {
        const why = `${node} kept group ${st.gid}, mode ${(st.mode & 0o777).toString(8)}`;
        if (!broker.fenceAbi) throw new Error(why);
        kept.push(why);
      }
    }
    broker.groupsHold = kept.length === 0;
    if (kept.length)
      log(
        "broker",
        "device nodes kept their owner and mode: only the Landlock fence keeps roles off them",
        { nodes: kept },
      );
    record = {
      ok: true,
      ...layout,
      fence: kept.length ? "landlock" : broker.fenceAbi ? "groups+landlock" : "groups",
    };
    log("broker", "dedicated cards", {
      judges: layout.judges.map((c) => c.node),
      devs: layout.devs.map((c) => c.node),
      control: layout.control,
    });
  } catch (err) {
    layout = undefined;
    const error = errorText(err);
    record = { ok: false, mode: "dedicated", error };
    logWarn("broker", "could not set up the dedicated development card", { error });
  }
  writeFileSync(layoutPath, `${JSON.stringify(record)}\n`, { mode: 0o644 });
  chmodSync(layoutPath, 0o644);
  return layout;
}
