import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ResourceUse, USE_WINDOW_MS } from "../../src/common/usage.ts";

/**
 * What a part uses (goal 179): a container's CPU and memory as its control groups count them, the
 * page cache the kernel may take back left out, and its process's where it runs in none.
 */

/** A container's control groups, as the files the kernel gives it. */
function group(o: {
  usec: number;
  current: number;
  inactive?: number;
  max?: string;
  cpuMax?: string;
}) {
  const dir = mkdtempSync(join(tmpdir(), "thermite-cgroup-"));
  writeFileSync(join(dir, "cpu.stat"), `usage_usec ${o.usec}\nuser_usec 1\nsystem_usec 2\n`);
  writeFileSync(join(dir, "memory.current"), `${o.current}\n`);
  writeFileSync(join(dir, "memory.stat"), `anon 5\nfile 9\ninactive_file ${o.inactive ?? 0}\n`);
  writeFileSync(join(dir, "memory.max"), `${o.max ?? "max"}\n`);
  writeFileSync(join(dir, "cpu.max"), `${o.cpuMax ?? "max 100000"}\n`);
  return dir;
}

test("a container: its memory without the inactive page cache, its limits, its CPU over the window", () => {
  const root = group({
    usec: 10_000_000,
    current: 900,
    inactive: 200,
    max: "4096",
    cpuMax: "200000 100000",
  });
  let now = 1_000_000;
  const use = new ResourceUse({ root, now: () => now });
  const first = use.read();
  assert.equal(first.of, "container");
  assert.equal(first.cpu, null, "no CPU before a second reading");
  assert.equal(first.cpus, 2);
  assert.equal(first.memory_bytes, 700);
  assert.equal(first.memory_limit_bytes, 4096);
  // 1.5 CPU seconds over 2 seconds: 0.75 CPUs busy.
  writeFileSync(join(root, "cpu.stat"), "usage_usec 11500000\n");
  now += 2000;
  assert.equal(use.read().cpu, 0.75);
  // Asked again sooner than the window: the reading before, not a figure over a few milliseconds.
  writeFileSync(join(root, "cpu.stat"), "usage_usec 99999999\n");
  now += USE_WINDOW_MS - 1;
  assert.equal(use.read().cpu, 0.75);
});

test("a container with no limits: its CPUs are the machine's, its memory limit none", () => {
  const use = new ResourceUse({ root: group({ usec: 1, current: 50 }) });
  const r = use.read();
  assert.equal(r.memory_limit_bytes, null);
  assert.ok(r.cpus >= 1);
});

test("no control groups of its own: its process is counted, and the reading says so", () => {
  const use = new ResourceUse({ root: join(tmpdir(), "thermite-no-cgroup-here") });
  const r = use.read();
  assert.equal(r.of, "process");
  assert.ok(r.memory_bytes > 0);
  assert.equal(r.memory_limit_bytes, null);
});
