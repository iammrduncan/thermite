import { readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import type { PartUse } from "../core/hardware.ts";

/**
 * What a part uses now, its CPU and memory (goal 179), as Metrics shows it: control reads its own,
 * and each rig's harness and supervisor report theirs. Inside a container the control groups
 * (version 2) count the whole container, every process in it; elsewhere, as a part started from a
 * checkout, only its own process is counted, and the reading says so.
 */

/** Where a container's control groups are, as the container sees them. */
const CGROUP_ROOT = "/sys/fs/cgroup";

/**
 * The shortest time a CPU reading covers. A reading asked sooner gives the one before again, so
 * that a report's pages, made one after the other, say the same.
 */
export const USE_WINDOW_MS = 1000;

const text = (path: string): string | undefined => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    // No such file: not in a container with control groups of its own, or not this one.
    return undefined;
  }
};

const field = (body: string | undefined, name: string): number | undefined => {
  const m = new RegExp(`^${name} (\\d+)$`, "m").exec(body ?? "");
  return m ? Number(m[1]) : undefined;
};

const round2 = (n: number) => Math.round(n * 100) / 100;

/** The container's counts: CPU time in microseconds, memory in use, its limits. */
interface Group {
  usec: number;
  memory: number;
  limit: number | null;
  cpus: number | null;
}

/** Reads a part's CPU and memory; the CPU as the time it used since the reading before. */
export class ResourceUse {
  private base: { at: number; usec: number } | undefined;
  private cpu: number | null = null;

  private readonly o: { root?: string; now?: () => number };

  constructor(o: { root?: string; now?: () => number } = {}) {
    this.o = o;
  }

  /** The container's counts; undefined where the part has no control groups of its own. */
  private group(): Group | undefined {
    const root = this.o.root ?? CGROUP_ROOT;
    const usec = field(text(join(root, "cpu.stat")), "usage_usec");
    const current = Number(text(join(root, "memory.current")));
    // The host's own root group has cpu.stat but no memory.current: no container to count.
    if (usec === undefined || !Number.isFinite(current)) return undefined;
    // What the kernel may take back at once (the page cache of files no one read lately), left
    // out as `docker stats` leaves it out: a container that read a lot is not near its limit.
    const inactive = field(text(join(root, "memory.stat")), "inactive_file") ?? 0;
    const max = text(join(root, "memory.max"))?.trim();
    const [quota, period] = (text(join(root, "cpu.max")) ?? "").trim().split(/\s+/);
    return {
      usec,
      memory: Math.max(0, current - inactive),
      limit: max && max !== "max" && Number(max) > 0 ? Number(max) : null,
      cpus: quota && quota !== "max" && Number(period) > 0 ? Number(quota) / Number(period) : null,
    };
  }

  read(): PartUse {
    const now = (this.o.now ?? Date.now)();
    const group = this.group();
    const used = process.cpuUsage();
    const usec = group ? group.usec : used.user + used.system;
    if (!this.base || usec < this.base.usec) this.base = { at: now, usec };
    else if (now - this.base.at >= USE_WINDOW_MS) {
      this.cpu = round2((usec - this.base.usec) / 1000 / (now - this.base.at));
      this.base = { at: now, usec };
    }
    return {
      at: new Date(now).toISOString(),
      of: group ? "container" : "process",
      cpu: this.cpu,
      cpus: round2(group?.cpus ?? availableParallelism()),
      memory_bytes: group ? group.memory : process.memoryUsage.rss(),
      memory_limit_bytes: group?.limit ?? null,
    };
  }
}
