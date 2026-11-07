import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * A lane's workspace counted while its command runs (goal 219), a step at a time: each sample
 * reads at most COUNT_STEP entries more of the count under way, so a tree of many files never
 * stalls the broker, and no number of files ends a trial. The bytes counted so far are a floor of
 * the tree's, so a breach of the disk limit shows before a count is done. A tree deeper than
 * MAX_DEPTH, or one whose count has not ended in COUNT_GUARD_MS, can't be held to the limit and
 * is a breach: a hostile tree of millions of empty files can't hide bytes behind its count.
 */

/** Entries one step of a count reads at most. */
export const COUNT_STEP = 20_000;
/** How long one whole count may take before the tree is too large to hold to its limit. */
const COUNT_GUARD_MS = 5 * 60_000;
/** Directories deeper than this are not walked: the tree is a breach. */
const MAX_DEPTH = 128;

interface CountReading {
  /** The bytes counted so far: the whole tree's when the count is complete, a floor otherwise. */
  bytes: number;
  /** Files, directories and links counted so far. */
  entries: number;
  complete: boolean;
  /** The tree can't be held to its limit: too deep, or too large to count in the guard's time. */
  breach?: "deep" | "slow" | undefined;
}

export class DiskCount {
  private readonly path: string;
  private readonly guardMs: number;
  private readonly now: () => number;
  private stack: [string, number][] = [];
  private bytes = 0;
  private entries = 0;
  private started = 0;
  private deep = false;

  constructor(path: string, guardMs = COUNT_GUARD_MS, now: () => number = Date.now) {
    this.path = path;
    this.guardMs = guardMs;
    this.now = now;
  }

  /** One step of the count: up to `entries` more of the one under way, or the start of a new one. */
  step(entries = COUNT_STEP): CountReading {
    if (!this.stack.length) {
      this.stack = [[this.path, 0]];
      this.bytes = 0;
      this.entries = 0;
      this.deep = false;
      this.started = this.now();
    }
    let read = 0;
    while (this.stack.length && read < entries) {
      const [p, depth] = this.stack.pop() as [string, number];
      let st: ReturnType<typeof lstatSync>;
      try {
        st = lstatSync(p);
      } catch {
        continue;
      }
      read++;
      this.entries++;
      this.bytes += Number(st.blocks ?? 0) * 512 || Number(st.size);
      if (!st.isDirectory()) continue;
      if (depth >= MAX_DEPTH) {
        this.deep = true;
        continue;
      }
      try {
        for (const e of readdirSync(p)) this.stack.push([join(p, e), depth + 1]);
      } catch {
        // unreadable or vanished directory: counted as its own size only
      }
    }
    const complete = this.stack.length === 0;
    const breach = this.deep
      ? "deep"
      : !complete && this.now() - this.started > this.guardMs
        ? "slow"
        : undefined;
    return { bytes: this.bytes, entries: this.entries, complete, ...(breach ? { breach } : {}) };
  }
}
