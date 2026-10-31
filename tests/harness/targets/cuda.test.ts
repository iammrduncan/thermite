import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { LocalRunner, type RunRequest } from "../../../src/harness/broker/runner.ts";
import {
  CudaDriver,
  decodeReasons,
  parseGpuRows,
  smiAsRun,
} from "../../../src/harness/targets/cuda.ts";

// nvidia-smi --format=csv,noheader,nounits output shaped like a 16 GB Pascal card (no real host data).
const IDLE =
  "0, GPU-00000000-1111-2222-3333-444444444444, Tesla P100-PCIE-16GB, 00000000:00:00.0, 550.00.00, 16384, 0, 16280, 0, 36, 31.20, 250.00, 405, 715, 1328, 715, P0";
const BUSY =
  "0, GPU-00000000-1111-2222-3333-444444444444, Tesla P100-PCIE-16GB, 00000000:00:00.0, 550.00.00, 16384, 9000, 7280, 97, 79, 210.00, 250.00, 1328, 715, 1328, 715, P0";

function fake(row: string, reasons: string, apps = "") {
  return async (args: string[]) => {
    const q = args[0] ?? "";
    if (q.startsWith("--query-compute-apps")) return apps;
    if (q.includes("clocks_event_reasons")) return `0, ${reasons}\n`;
    return `${row}\n`;
  };
}

describe("cuda-gpu driver", () => {
  test("nvidia-smi runs as the run user, in its own directory, and a failing query is retried", async () => {
    const root = mkdtempSync(join(tmpdir(), "thermite-smi-"));
    const bin = join(root, "bin");
    mkdirSync(bin);
    // A stand-in nvidia-smi: fails once, then answers with its arguments.
    writeFileSync(
      join(bin, "nvidia-smi"),
      `#!/bin/sh\nif [ ! -f "${root}/failed" ]; then touch "${root}/failed"; exit 9; fi\necho "$@"\n`,
    );
    chmodSync(join(bin, "nvidia-smi"), 0o755);
    const scratch = join(root, "scratch");
    mkdirSync(scratch);
    const local = new LocalRunner(scratch);
    const seen: { role: string; cwd: string }[] = [];
    const handed: string[] = [];
    const runner = {
      ...local,
      run: (r: RunRequest) => {
        seen.push({ role: r.role, cwd: r.cwd });
        return local.run({ ...r, env: { ...r.env, PATH: `${bin}:/usr/bin:/bin` } });
      },
      handOver: async (path: string, role: string) => {
        handed.push(`${role}:${path}`);
        await local.handOver(path);
      },
    } as unknown as LocalRunner;
    const dir = join(scratch, "thermite", "gpu-query");
    const smi = smiAsRun(runner, dir);
    assert.equal((await smi(["-L"])).trim(), "-L");
    assert.equal((await smi(["-q"])).trim(), "-q");
    assert.deepEqual(handed, [`run:${dir}`], "handed over once");
    assert.ok(seen.every((s) => s.role === "run" && s.cwd === dir));
    assert.equal(seen.length, 3, "the failed query was retried");
  });

  test("parses nvidia-smi rows and clock event reasons", () => {
    const [r] = parseGpuRows(`${IDLE}\n`);
    assert.equal(r?.name, "Tesla P100-PCIE-16GB");
    assert.equal(r?.["memory.total"], "16384");
    assert.deepEqual(decodeReasons("0x0000000000000001"), ["gpu_idle"]);
    assert.deepEqual(decodeReasons("0x0000000000000048"), ["hw_slowdown", "hw_thermal_slowdown"]);
  });

  test("an idle, cool, unthrottled GPU is ready; its identity is the UUID", async () => {
    const d = new CudaDriver({
      targetClass: "p100-pcie-16g",
      smi: fake(IDLE, "0x0000000000000001"),
    });
    assert.deepEqual((await d.readyForTiming()).reasons, []);
    const id = await d.identify();
    assert.equal(id.id, "GPU-00000000-1111-2222-3333-444444444444");
    assert.equal(id.class, "p100-pcie-16g");
  });

  test("a GPU whose compute processes can't be read is not ready, never taken for an idle one (goal 163)", async () => {
    const idle = fake(IDLE, "0x0000000000000001");
    const d = new CudaDriver({
      targetClass: "p100-pcie-16g",
      smi: async (args) => {
        if ((args[0] ?? "").startsWith("--query-compute-apps"))
          throw new Error("nvidia-smi failed");
        return idle(args);
      },
    });
    const r = await d.readyForTiming();
    assert.equal(r.ready, false);
    assert.deepEqual(r.reasons, ["the GPU's compute processes could not be read"]);
  });

  test("a busy, throttled GPU or one with compute processes is not ready", async () => {
    const d = new CudaDriver({
      targetClass: "p100-pcie-16g",
      smi: fake(BUSY, "0x0000000000000008", "4242, 8000\n"),
    });
    const r = await d.readyForTiming();
    assert.equal(r.ready, false);
    assert.equal(r.reasons.length, 4, r.reasons.join("; "));
  });

  test("every query names one card; by UUID on a rig with a development card", async () => {
    const seen: string[][] = [];
    const smi = (inner: (a: string[]) => Promise<string>) => async (args: string[]) => {
      seen.push(args);
      return inner(args);
    };
    await new CudaDriver({
      targetClass: "x",
      index: 1,
      smi: smi(fake(IDLE, "0x1")),
    }).readyForTiming();
    assert.ok(
      seen.length >= 3 && seen.every((a) => a.join(" ").endsWith("-i 1")),
      JSON.stringify(seen),
    );
    seen.length = 0;
    const uuid = "GPU-00000000-1111-2222-3333-444444444444";
    const d = new CudaDriver({ targetClass: "x", index: 1, uuid, smi: smi(fake(IDLE, "0x1")) });
    assert.deepEqual((await d.readyForTiming()).reasons, []);
    assert.ok(
      seen.every((a) => a.join(" ").endsWith(`-i ${uuid}`)),
      JSON.stringify(seen),
    );
    const other = new CudaDriver({ targetClass: "x", uuid: "GPU-ffff", smi: fake(IDLE, "0x1") });
    await assert.rejects(other.identify(), /not GPU-ffff/);
    const off = new CudaDriver({
      targetClass: "x",
      smi: fake(IDLE, "0x1"),
      unusable: "not set up",
    });
    assert.deepEqual((await off.readyForTiming()).reasons, ["not set up"]);
  });

  test("never a score: zero, negative and non-finite metrics are implausible", () => {
    const d = new CudaDriver({ targetClass: "x", smi: fake(IDLE, "0x1") });
    assert.equal(d.plausibility({ a: 1, b: 0, c: Number.NaN }).length, 2);
  });
});
