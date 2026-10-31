import type { ControlStore } from "../../../src/control/store/index.ts";
import { ingestReport } from "../../../tests/helpers/control-store.ts";
import { iso, Rig } from "./shared.ts";

// Synthetic hardware, shaped like what a harness reports (no real host data).
const card = (role: "judge" | "dev" | "shared", n: number) => ({
  role,
  name: "NVIDIA L4",
  uuid: `GPU-${String(n).repeat(8)}-0000-0000-0000-000000000000`,
  bus: `00000000:0${n}:00.0`,
  memory_mib: 23034,
  driver: "550.00.00",
  cuda: "12.4",
  power_limit_w: 72,
  max_sm_mhz: 2040,
  max_mem_mhz: 6251,
  pcie: "gen4 x16",
  vbios: "95.04.00.00.01",
});
const hardware = (devices: ReturnType<typeof card>[], cpus: number, mib: number) => ({
  collected_at: iso(6),
  target: devices.length
    ? { type: "cuda-gpu", class: "l4-24g", id: devices[0]?.uuid ?? "" }
    : { type: "cpu", class: "generic-cpu", id: "cpu" },
  device_mode: devices.length > 1 ? "dedicated" : devices.length ? "shared" : "none",
  devices,
  cpu: { model: "Example EPYC CPU @ 2.45GHz", host: 64, usable: 64, quota: cpus },
  memory: { host_mib: 515_000, limit_mib: mib },
  disks: [
    { name: "state", total_gib: 200, free_gib: 143.5 },
    { name: "scratch", total_gib: 100, free_gib: 81.2 },
  ],
  os: { kernel: "6.8.0-generic", arch: "x64", node: "v22.15.0", image: "sha256:0123456789abcdef" },
  toolchain: {
    cc: "cc (Debian 12.2.0) 12.2.0",
    nvcc: devices.length ? "Build cuda_12.4.r12.4" : null,
  },
  errors: [],
});

/** Each rig's report to control (its events, jobs and hardware), and its supervisor's state. */
export async function reportRigs(
  store: ControlStore,
  { g1, g2, g3, c1, g4 }: { g1: Rig; g2: Rig; g3: Rig; c1: Rig; g4: Rig },
): Promise<void> {
  const report = async (
    u: Rig,
    jobs: Record<string, number>,
    hw: unknown,
    lastSeenHoursAgo = 0,
  ) => {
    await ingestReport(store, {
      rig: u.id,
      ledger_id: `ledger-${u.id}`,
      cursor: 0,
      next: u.events.length,
      events: u.events,
      summary: { jobs, hardware: hw },
      generated_at: iso(lastSeenHoursAgo),
    });
  };
  await report(g1, { queued: 1, leased: 1, done: 214 }, hardware([card("shared", 1)], 6, 16_384));
  // gpu-2's ledger from before its full reset (goal 170): its run is under decode-speed's
  // Earlier runs, and opens like any run.
  const before = earlierRun();
  await ingestReport(store, {
    rig: "gpu-2",
    ledger_id: "ledger-gpu-2-before-reset",
    cursor: 0,
    next: before.events.length,
    events: before.events,
    summary: {},
    generated_at: iso(40),
  });
  await report(g2, { queued: 0, leased: 1, done: 162 }, hardware([card("shared", 2)], 8, 24_576));
  await report(
    g3,
    { queued: 2, leased: 1, done: 88 },
    hardware([card("judge", 3), card("dev", 4)], 12, 32_768),
  );
  await report(c1, { done: 0 }, hardware([], 8, 16_384));
  await report(g4, {}, hardware([card("judge", 5), card("dev", 6)], 16, 65_536));
  store.db.prepare("update rig set last_seen = ? where id = ?").run(iso(2.3), "gpu-4");
  for (const [u, usd] of [
    ["gpu-1", 4.2],
    ["gpu-2", 3.1],
    ["gpu-3", 6.8],
  ] as const) {
    store.reportedRigs.setSupervisor(u, {
      export: { exports: 31, remote: true, last_push_at: iso(0.4) },
      advisors: {
        teacher_runs: 28,
        directive_sets: 9,
        audits: 2,
        reviews: 0,
        errors: 0,
        usd,
        // What the rig's advisors file sets up: Edit rig's empty Model choices name it.
        file: {
          teachers: [
            {
              harness: "pi",
              model: "glm-5.1",
              provider: null,
              api: "openai",
              context_window: 204_800,
              compact_at: null,
            },
          ],
          merged_by: null,
          auditor: {
            harness: "pi",
            model: "glm-5.1",
            provider: null,
            api: "openai",
            context_window: 204_800,
            compact_at: null,
          },
          review_panel: [],
        },
      },
    });
  }
  store.reportedRigs.setSupervisor("cpu-1", { export: { exports: 10, remote: false } });
}

/** A run of decode-speed on gpu-2 before the rig's full reset: two attempts, one a champion. */
function earlierRun(): Rig {
  const u = new Rig("gpu-2");
  const run = "decode-0";
  u.ev(52, "run_created", run, {
    campaign: "decode-speed",
    version: 1,
    mode: "hill_climb",
    seed: { repo: "inference-engine", commit: "a1b2c3d4e5f6" },
  });
  u.ev(51, "run_status", run, { status: "running", reason: null });
  const attempts = [
    ["a-0e0e0001", "Batch the token decode loop by four", "win_confirmed", 0.06],
    ["a-0e0e0002", "Cache the rope tables per layer", "regress", -0.02],
  ] as const;
  attempts.forEach(([id, hypothesis, verdict, delta], i) => {
    const at = 50 - i * 2;
    u.ev(at, "attempt_recorded", id, {
      run,
      lane: `lane-${i + 1}`,
      lifecycle: "queued",
      hypothesis,
    });
    u.ev(at - 0.5, "verdict", id, { verdict, delta });
  });
  u.ev(49, "champion_promoted", run, { seq: 2, attempt: "a-0e0e0001", commit: "0e0e0e0e0e0e" });
  u.ev(42, "run_status", run, { status: "paused", reason: "the owner's full reset of gpu-2" });
  return u;
}
