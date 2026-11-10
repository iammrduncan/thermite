import type { ControlParts } from "../parts.ts";
import { type CudaVersion, controlImages } from "../rigs/index.ts";
import type { MachineRig } from "../store/index.ts";
import type { ClusterFacts, GpuKind } from "./facts.ts";

/** GPUs that need the CUDA 13 harness by their name: Blackwell and newer, the DGX Spark's GB10. */
const CUDA13_PRODUCT =
  /\b(GB10|GB200|GB300|B100|B200|B300|RTX PRO 6000|RTX 50\d0|Blackwell|Thor)\b/i;

/**
 * The CUDA harness a GPU takes (goal 132), and why in words, from what control knows of it; none
 * when it knows too little. CUDA 13 for an arm64 node (the CUDA 12 harness is built for amd64 only)
 * and for compute capability 10 or more (CUDA 12.6 builds nothing past Hopper); CUDA 12 below.
 */
export function cudaFor(g: GpuKind): { cuda: CudaVersion; why: string } | undefined {
  const name = g.product ? g.product.replace(/-/g, " ") : "this GPU";
  const major = g.cc ? Number.parseInt(g.cc, 10) : Number.NaN;
  if (g.arch === "arm64" || g.arch === "aarch64")
    return { cuda: "13", why: `${name} is on an arm64 node: only the CUDA 13 harness runs there.` };
  if (major >= 10)
    return {
      cuda: "13",
      why: `${name} has compute capability ${g.cc}: CUDA 12.6 builds nothing past Hopper.`,
    };
  if (g.product && CUDA13_PRODUCT.test(g.product))
    return { cuda: "13", why: `${name} is a Blackwell GPU: CUDA 12.6 builds nothing past Hopper.` };
  if (major > 0)
    return { cuda: "12", why: `${name} has compute capability ${g.cc}: Pascal to Hopper.` };
  return undefined;
}

/**
 * The CUDA harness a new rig's GPUs take by default (goal 132), as Add a rig sets its field: the
 * chosen node's GPU, else the DRA class's, else the device plugin's nodes when they all agree;
 * none when control can't tell.
 */
export function cudaOfPlace(
  facts: ClusterFacts,
  o: { deviceClass?: string | undefined; node?: string | undefined },
): { cuda: CudaVersion; why: string } | undefined {
  const node = o.node ? facts.nodes.find((n) => n.name === o.node) : undefined;
  if (node?.gpus) return cudaFor({ product: node.gpu_product, arch: node.arch });
  if (o.deviceClass) {
    const g = facts.gpu_classes?.[o.deviceClass];
    return g ? cudaFor(g) : undefined;
  }
  const hints = facts.nodes
    .filter((n) => n.gpus > 0)
    .map((n) => cudaFor({ product: n.gpu_product, arch: n.arch }));
  return hints.length && hints.every((h) => h && h.cuda === hints[0]?.cuda) ? hints[0] : undefined;
}

type MachineFactsSeen =
  | { arch?: string; gpus?: { index: number; name: string }[] }
  | null
  | undefined;

/**
 * The CUDA harness a rig on a machine over SSH takes (goal 132), from what control read there
 * (machines/facts.ts) and the rig's GPUs: CUDA 13 for an arm64 machine or when any chosen GPU
 * needs it, else CUDA 12 when the facts name every chosen GPU, else `fallback` (a rig already set
 * up keeps the CUDA it runs when the facts are stale or missing). None for a rig without GPUs.
 */
function cudaOfMachine(
  facts: MachineFactsSeen,
  gpus: number[],
  fallback: CudaVersion = "12",
): CudaVersion | undefined {
  if (!gpus.length) return undefined;
  const arch = facts?.arch;
  if (arch === "arm64" || arch === "aarch64") return "13";
  const chosen = (facts?.gpus ?? []).filter((g) => gpus.includes(g.index));
  if (chosen.some((g) => cudaFor({ product: g.name, arch })?.cuda === "13")) return "13";
  return gpus.every((i) => chosen.some((g) => g.index === i)) ? "12" : fallback;
}

/**
 * The images control deploys for a rig on a machine over SSH, with the CUDA it runs, or why it has
 * none: for Add a rig, the rig page's update check and Update to control's version alike. `was`
 * is a rig already set up: its recorded CUDA when the facts no longer tell, or for a rig set up
 * before control recorded it, whether it runs control's CUDA 13 image. A CUDA 13 rig takes the
 * CUDA image while control has no CUDA 13 image (as before goal 132), and keeps CUDA 13 recorded,
 * so it moves there once control has one.
 */
export function machineRigImages(
  parts: ControlParts,
  facts: MachineFactsSeen,
  gpus: number[],
  was?: MachineRig["images"],
): MachineRig["images"] | string {
  const before = !was
    ? "12"
    : (was.cuda ?? (was.harness === parts.rigImages?.harnessCuda13 ? "13" : "12"));
  const cuda = cudaOfMachine(facts, gpus, before);
  const no13 = cuda === "13" && parts.rigImages && !parts.rigImages.harnessCuda13;
  const images = controlImages(parts, gpus.length, no13 ? "12" : cuda);
  if (typeof images === "string") return images;
  return cuda ? { ...images, cuda } : images;
}
