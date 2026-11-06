import type { CudaVersion } from "../rigs/index.ts";
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
