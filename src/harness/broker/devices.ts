import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { readNumber } from "../../common/settings.ts";
import { judgeGpusByDefault } from "../../core/hardware.ts";
import { HARNESS_NUMBERS } from "../settings.ts";
import { IDS, type Role, roleIds } from "./runner.ts";

/**
 * GPU device nodes and who may open them. On a rig with one card (shared mode) every
 * /dev/nvidia* node belongs to the `gpu` group, which the run user and agents' development runs
 * have. On a rig with dedicated cards, every card gets a group of its own, and the nodes every
 * CUDA process needs (nvidiactl, nvidia-uvm, ...) one more, `gpuctl`. Judge cards and
 * development cards are pools: judge card i is timed by its own user (run, run-1, ...) with that
 * card's group, and a development run gets the group of the development card it was given. No
 * process can open a card its groups don't name, whatever its environment says. The first card
 * of each kind keeps the groups a two-card rig always had (`gpu` and `gpudev`).
 */

export interface GpuCard {
  /** nvidia-smi's index. */
  index: number;
  uuid: string;
  /** PCI bus id as nvidia-smi prints it. */
  bus: string;
  /** The card's device node, /dev/nvidia<minor>. */
  node: string;
}

export interface GpuLayout {
  mode: "dedicated";
  /** The first judge card and the first development card (judges[0] and devs[0]). */
  judge: GpuCard;
  dev: GpuCard;
  /** Every judge card, then every development card, in the order configured. */
  judges: GpuCard[];
  devs: GpuCard[];
  /** Every other /dev/nvidia* node: control, UVM, modeset. */
  control: string[];
}

/** The group of judge card i. */
export const judgeGroup = (i: number) => (i === 0 ? IDS.gpuGroup : IDS.gpuJudgeBase + i);
/** The group of development card k. */
export const devGroup = (k: number) => (k === 0 ? IDS.gpuDevGroup : IDS.gpuDevBase + k);
/** The user who times runs on judge card i. */
export const runRole = (i: number): Role => (i === 0 ? "run" : (`run-${i}` as Role));
/** The user judge card i builds as: each card's builds run apart, at the same time (goal 135). */
export const builderRole = (i: number): Role => (i === 0 ? "builder" : (`builder-${i}` as Role));
/** The user judge card i runs the kit's check as. */
export const checkerRole = (i: number): Role => (i === 0 ? "checker" : (`checker-${i}` as Role));
/** The user judge card i runs a kit's driver as, apart from the candidate's (runRole). */
export const driverRole = (i: number): Role => (i === 0 ? "driver" : (`driver-${i}` as Role));
/** Which judge card a timing role uses, or undefined for any other role. */
export const judgeCardOf = (role: Role): number | undefined =>
  role === "run" ? 0 : /^run-([1-7])$/.test(role) ? Number(role.slice(4)) : undefined;

/**
 * The judge's and the agents' cards, as THERMITE_GPU_INDEX and THERMITE_DEV_GPU_INDEX take them.
 * Explicit lists win. Otherwise a rig configured with its GPU set (THERMITE_GPUS) splits it: the
 * first `judge` cards for the judge, the rest for the agents, where `judge` is the rig's setting
 * (Edit rig, or the campaign deployed on it), else THERMITE_JUDGE_GPUS, else half rounded up. A
 * split that does not fit the set falls back to the default. One card is shared.
 */
export function effectiveGpuLists(
  env: Record<string, string | undefined>,
  savedJudge?: number | null | undefined,
): { judge: string; dev?: string | undefined; set: number } {
  if (env.THERMITE_DEV_GPU_INDEX !== undefined)
    return {
      judge: env.THERMITE_GPU_INDEX ?? "0",
      dev: env.THERMITE_DEV_GPU_INDEX,
      set: 0,
    };
  if (env.THERMITE_GPUS === undefined) return { judge: env.THERMITE_GPU_INDEX ?? "0", set: 0 };
  const cards = parseIndexList(env.THERMITE_GPUS, "THERMITE_GPUS", MAX_GPU_SET);
  if (cards.length === 1) return { judge: String(cards[0]), set: 1 };
  const fits = (j: number | null | undefined) =>
    typeof j === "number" &&
    Number.isInteger(j) &&
    j >= 1 &&
    j <= cards.length - 1 &&
    j <= IDS.maxCards &&
    cards.length - j <= IDS.maxCards;
  const fromEnv = readNumber(env, HARNESS_NUMBERS.judgeGpus);
  const j = fits(savedJudge)
    ? (savedJudge as number)
    : fits(fromEnv)
      ? (fromEnv as number)
      : judgeGpusByDefault(cards.length);
  return {
    judge: cards.slice(0, j).join(","),
    dev: cards.slice(j).join(","),
    set: cards.length,
  };
}

/** The judge's share the rig's settings keep (rig-settings.json in its state), if any. */
export function savedJudgeGpus(stateDir: string): number | null {
  try {
    const v = (
      JSON.parse(readFileSync(join(stateDir, "rig-settings.json"), "utf8")) as {
        judge_gpus?: unknown;
      }
    ).judge_gpus;
    return typeof v === "number" ? v : null;
  } catch {
    return null;
  }
}

/** A rig's whole GPU set (THERMITE_GPUS): the judge's cards and the agents' together. */
export const MAX_GPU_SET = 2 * IDS.maxCards;

/**
 * "0", "0,1" or "2, 3" (THERMITE_GPU_INDEX and THERMITE_DEV_GPU_INDEX) as card indices: at most
 * `max`, the cards of one kind unless the list is the whole set.
 */
export function parseIndexList(text: string, what: string, max: number = IDS.maxCards): number[] {
  const list = text
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  if (!list.length || list.some((x) => !/^\d+$/.test(x)))
    throw new Error(`${what} is a GPU index or a list of them, such as 0 or 0,1: not "${text}"`);
  const n = list.map(Number);
  if (new Set(n).size !== n.length) throw new Error(`${what} names a GPU twice: "${text}"`);
  if (n.length > max)
    throw new Error(
      `${what} names ${n.length} GPUs; a rig takes at most ${max === IDS.maxCards ? `${max} of each kind` : max}`,
    );
  return n;
}

/** Where the broker records the layout, for the controller and the isolation selftest. */
export const LAYOUT_FILE = "gpu-layout.json";

/**
 * The device setup as the broker writes it: a dedicated layout, the shared one (every node in
 * the `gpu` group), or why it could not be established.
 */
export type LayoutRecord =
  | ({ ok: true; fence?: Fence } & GpuLayout)
  | { ok: true; mode: "shared"; nodes: string[]; fence?: Fence }
  | { ok: false; mode: "dedicated" | "shared"; error: string };

/**
 * How roles are kept off the GPU's device nodes: by the nodes' groups, by the Landlock fence
 * (thermite-devfence) as well, or by the fence alone where the nodes keep the owner and mode
 * they came with (a container in a user namespace, as on some GPU clouds).
 */
export type Fence = "groups" | "groups+landlock" | "landlock";

/** `00000000:3B:00.0` (nvidia-smi) to `0000:3b:00.0` (/proc/driver/nvidia/gpus). */
export function procBusDir(bus: string): string {
  const m = /^([0-9a-fA-F]+):([0-9a-fA-F]{2}):([0-9a-fA-F]{2})\.([0-7])$/.exec(bus.trim());
  if (!m) throw new Error(`unexpected PCI bus id ${bus}`);
  const domain = (m[1] as string).slice(-4).padStart(4, "0");
  return `${domain}:${m[2]}:${m[3]}.${m[4]}`.toLowerCase();
}

/**
 * A card's minor number: "Device Minor" in /proc/driver/nvidia/gpus/<bus>/information, or
 * "Minor Number" in `nvidia-smi -q -i <index>`.
 */
export function parseMinor(information: string): number {
  const m = /^\s*(?:Device Minor|Minor Number)\s*:\s*(\d+)\s*$/m.exec(information);
  if (!m) throw new Error("no Device Minor in the driver's information");
  return Number(m[1]);
}

/**
 * Plans a dedicated layout from `nvidia-smi --query-gpu=index,uuid,pci.bus_id
 * --format=csv,noheader`, the driver's information per bus, and the /dev/nvidia* nodes present.
 */
export function planDedicated(opts: {
  smiCsv: string;
  /** The driver's information for a card, by /proc bus directory or nvidia-smi index. */
  information: (procBus: string, index: number) => string;
  nodes: string[];
  judgeIndices: number[];
  devIndices: number[];
}): GpuLayout {
  if (!opts.judgeIndices.length || !opts.devIndices.length)
    throw new Error(
      "a rig with dedicated cards needs at least one judge card and one development card",
    );
  const both = opts.judgeIndices.find((i) => opts.devIndices.includes(i));
  if (both !== undefined) {
    throw new Error(`a judge card and a development card are both index ${both}`);
  }
  if (opts.judgeIndices.length > IDS.maxCards || opts.devIndices.length > IDS.maxCards)
    throw new Error(
      `a rig takes at most ${IDS.maxCards} judge cards and ${IDS.maxCards} development cards`,
    );
  const rows = opts.smiCsv
    .split("\n")
    .map((l) => l.split(",").map((f) => f.trim()))
    .filter((f) => f.length === 3 && /^\d+$/.test(f[0] as string));
  const card = (index: number, what: string): GpuCard => {
    const row = rows.find((f) => Number(f[0]) === index);
    if (!row) throw new Error(`no GPU with index ${index} for the ${what}`);
    const [, uuid, bus] = row as [string, string, string];
    const node = `/dev/nvidia${parseMinor(opts.information(procBusDir(bus), index))}`;
    if (!opts.nodes.includes(node)) throw new Error(`the ${what}'s node ${node} is missing`);
    return { index, uuid, bus, node };
  };
  const judges = opts.judgeIndices.map((i, n) => card(i, `judge card ${n + 1}`));
  const devs = opts.devIndices.map((i, n) => card(i, `development card ${n + 1}`));
  const planned = new Set([...judges, ...devs].map((c) => c.node));
  const cardNode = /^\/dev\/nvidia\d+$/;
  const strays = opts.nodes.filter((n) => cardNode.test(n) && !planned.has(n));
  // A card left out would be reachable through no group, but nothing should be left unplanned.
  if (strays.length) throw new Error(`more cards than the layout covers: ${strays.join(", ")}`);
  return {
    mode: "dedicated",
    judge: judges[0] as GpuCard,
    dev: devs[0] as GpuCard,
    judges,
    devs,
    control: opts.nodes.filter((n) => !cardNode.test(n)),
  };
}

/**
 * The group every /dev/nvidia* node present should have: `gpu` for all of them in shared mode;
 * with a dedicated layout, its plan, the shared group for any other non-card node, and root's
 * group (no role) for a card the layout does not know.
 */
export function expectedNodeGroups(
  nodes: string[],
  layout?: GpuLayout | undefined,
): { node: string; gid: number }[] {
  if (!layout) return nodes.map((node) => ({ node, gid: IDS.gpuGroup }));
  const planned = new Map(nodeGroups(layout).map((x) => [x.node, x.gid]));
  return nodes.map((node) => ({
    node,
    gid: planned.get(node) ?? (/^\/dev\/nvidia\d+$/.test(node) ? 0 : IDS.gpuCtlGroup),
  }));
}

/** Owner group and mode for each node of a layout. */
export function nodeGroups(layout: GpuLayout): { node: string; gid: number }[] {
  return [
    ...cardsOf(layout).judges.map((c, i) => ({ node: c.node, gid: judgeGroup(i) })),
    ...cardsOf(layout).devs.map((c, k) => ({ node: c.node, gid: devGroup(k) })),
    ...layout.control.map((node) => ({ node, gid: IDS.gpuCtlGroup })),
  ];
}

/** A layout's cards; a record written before rigs had several of each has judge and dev only. */
export function cardsOf(layout: GpuLayout): { judges: GpuCard[]; devs: GpuCard[] } {
  return { judges: layout.judges ?? [layout.judge], devs: layout.devs ?? [layout.dev] };
}

export interface Identity {
  uid: number;
  gid: number;
  /** Supplementary groups (only on a dedicated layout). */
  groups?: number[] | undefined;
  /** CUDA_VISIBLE_DEVICES for the process (only on a dedicated layout). */
  cuda?: string | undefined;
  /** The role's own card's device node (only on a dedicated layout), for the GPU fence. */
  card?: string | undefined;
}

/**
 * The GPU fence's arguments for a role (thermite-devfence, before "--"). A role with a card of
 * its own opens that card and the control nodes; a role in the gpu group (one shared card)
 * opens every node, so it needs no fence; every other role opens no GPU node at all.
 */
export function fenceArgs(id: Identity): string[] | undefined {
  if (id.card) return ["--card", basename(id.card), "--control"];
  if (id.gid === IDS.gpuGroup) return undefined;
  return [];
}

/**
 * The user, groups and visible card a role runs with. `gpu` is a lane's development run on the
 * device. Without a dedicated layout this is the shared mode: such runs get the `gpu` group.
 */
export function identityFor(
  role: Role,
  gpu: boolean,
  layout?: GpuLayout | undefined,
  devCard = 0,
): Identity {
  const ids = roleIds(role);
  // A kit's check reads the kits and the baselines through the checkers' group; it has no card.
  if (/^checker(-[1-7])?$/.test(role)) return { ...ids, groups: [IDS.checkersGroup] };
  const devUser = gpu || /^lane-\d+-dev$/.test(role);
  const judgeCard = judgeCardOf(role);
  if (!layout) {
    if (judgeCard !== undefined && judgeCard > 0)
      throw new Error(`${role} times on a judge card of its own: this rig shares one card`);
    return { uid: ids.uid, gid: gpu ? IDS.gpuGroup : ids.gid };
  }
  const { judges, devs } = cardsOf(layout);
  if (judgeCard !== undefined) {
    const c = judges[judgeCard];
    if (!c) throw new Error(`this rig has no judge card ${judgeCard + 1} for ${role}`);
    return {
      uid: ids.uid,
      gid: judgeGroup(judgeCard),
      groups: [IDS.gpuCtlGroup],
      cuda: c.uuid,
      card: c.node,
    };
  }
  if (devUser) {
    const c = devs[devCard];
    if (!c) throw new Error(`this rig has no development card ${devCard + 1}`);
    return {
      uid: ids.uid,
      gid: devGroup(devCard),
      groups: [IDS.gpuCtlGroup],
      cuda: c.uuid,
      card: c.node,
    };
  }
  return { uid: ids.uid, gid: ids.gid };
}

/**
 * The controller's view: the device setup the broker established next to its socket, or why
 * there is none. Without one, a GPU rig neither times nor runs development runs: its device
 * nodes might be open to every role.
 */
export function readLayout(socketPath: string | undefined): {
  layout?: GpuLayout;
  error?: string;
} {
  if (!socketPath) {
    return { error: "a dedicated development card needs the broker (the harness image, as root)" };
  }
  try {
    const r = JSON.parse(
      readFileSync(join(dirname(socketPath), LAYOUT_FILE), "utf8"),
    ) as LayoutRecord;
    if (!r.ok) {
      return {
        error:
          r.mode === "shared"
            ? `the GPU's device nodes could not be restricted to the gpu group: ${r.error}`
            : `the dedicated development card is not set up: ${r.error}`,
      };
    }
    if ("mode" in r && r.mode === "shared") return {};
    const { ok: _, ...layout } = r as { ok: true } & GpuLayout;
    return { layout };
  } catch (err) {
    return { error: `no device layout from the broker (${String(err)})` };
  }
}

/** Parses a kernel CPU list ("10-19,30-39") into CPU numbers. */
export function parseCpuList(list: string): number[] {
  const out: number[] = [];
  for (const part of list.trim().split(",").filter(Boolean)) {
    const [a, b] = part.split("-").map((x) => Number(x));
    if (!Number.isInteger(a) || (b !== undefined && !Number.isInteger(b))) {
      throw new Error(`not a CPU list: ${list}`);
    }
    for (let c = a as number; c <= (b ?? (a as number)); c++) out.push(c);
  }
  return out;
}

/** Formats CPU numbers as a kernel CPU list. */
export function formatCpuList(cpus: number[]): string {
  const sorted = [...new Set(cpus)].sort((x, y) => x - y);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const start = sorted[i] as number;
    let end = start;
    while (sorted[i + 1] === end + 1) end = sorted[++i] as number;
    parts.push(start === end ? String(start) : `${start}-${end}`);
  }
  return parts.join(",");
}

/**
 * The CPUs judge runs are pinned to: the ones local to the judge's card (its PCI device's
 * local_cpulist) that this container may use. Kernel launches from a far socket, or moved
 * between sockets, add noise to timings. Empty when they do not overlap.
 */
export function runCpus(localList: string, allowedList: string): string {
  const allowed = new Set(parseCpuList(allowedList));
  return formatCpuList(parseCpuList(localList).filter((c) => allowed.has(c)));
}

/**
 * Disjoint CPU sets for several judge cards, from each card's usable CPUs (in card order): cards
 * with the same CPUs (one socket) split them into equal runs; a card whose CPUs overlap an earlier
 * card's keeps only the ones not taken. Two timed runs then never share a core.
 */
export function shareCpus(lists: number[][]): number[][] {
  const key = (l: number[]) => [...l].sort((a, b) => a - b).join(",");
  const groups = new Map<string, number[]>();
  for (const [i, l] of lists.entries()) groups.set(key(l), [...(groups.get(key(l)) ?? []), i]);
  const out: number[][] = lists.map(() => []);
  const taken = new Set<number>();
  for (const [k, members] of groups) {
    const cpus = (k ? k.split(",").map(Number) : []).filter((c) => !taken.has(c));
    const size = Math.floor(cpus.length / members.length);
    members.forEach((m, j) => {
      out[m] = cpus.slice(j * size, (j + 1) * size);
      for (const c of out[m] as number[]) taken.add(c);
    });
  }
  return out;
}
