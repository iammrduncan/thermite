import { existsSync } from "node:fs";

/** CUDA's tools (nvcc and the rest), where a CUDA development base image puts them. */
const CUDA_BIN = "/usr/local/cuda/bin";

/**
 * The PATH an agent's own shell gets under OpenCode, Claude Code and Codex: the system's places,
 * with CUDA's first when the image has it, as the CUDA base image's own PATH has it, so `nvcc` is
 * found by name on a CUDA rig. (Pi's commands get the image's PATH from the broker.) A fixed list,
 * not the harness's own PATH, so what an agent runs does not depend on how the harness started.
 */
export function agentPath(exists: (path: string) => boolean = existsSync): string {
  return `${exists(CUDA_BIN) ? `${CUDA_BIN}:` : ""}/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`;
}
