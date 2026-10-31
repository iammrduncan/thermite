import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, test } from "node:test";
import { readHardware } from "../../src/core/hardware.ts";
import { collectHardware, parseCudaVersion, parseDevice } from "../../src/harness/hardware.ts";
import { CpuDriver } from "../../src/harness/targets/cpu.ts";

// Shaped like nvidia-smi's output for a 16 GB Pascal card (no real host data).
const ROW =
  "GPU-00000000-1111-2222-3333-444444444444, Tesla P100-PCIE-16GB, 00000000:01:00.0, 550.00.00, 16384, 250.00, 1328, 715, 3, 16, 86.00.00.00.01";

describe("rig hardware", () => {
  test("parses a card's row and the CUDA version", () => {
    const d = parseDevice(ROW, "judge", "12.4");
    assert.equal(d.name, "Tesla P100-PCIE-16GB");
    assert.equal(d.memory_mib, 16384);
    assert.equal(d.pcie, "gen3 x16");
    assert.equal(d.power_limit_w, 250);
    assert.equal(
      parseCudaVersion("| NVIDIA-SMI 550.00 Driver Version: 550.00 CUDA Version: 12.4 |"),
      "12.4",
    );
    assert.equal(parseCudaVersion("no header"), null);
    const unknown = parseDevice(ROW.replace("250.00", "[N/A]"), "dev", null);
    assert.equal(unknown.power_limit_w, null);
    assert.throws(() => parseDevice("a, b", "judge", null), /unexpected/);
  });

  test("collects each card as the user that may open it, and the container's own view", async () => {
    const asked: string[][] = [];
    const smi = (uuid: string) => async (args: string[]) => {
      asked.push(args);
      return args.length
        ? `${ROW.replace("GPU-00000000-1111-2222-3333-444444444444", uuid)}\n`
        : "CUDA Version: 12.4";
    };
    const dir = mkdtempSync(`${tmpdir()}/thermite-hw-`);
    const h = await collectHardware({
      driver: new CpuDriver("generic-cpu"),
      cards: [
        { role: "judge", select: "GPU-a", smi: smi("GPU-a") },
        { role: "dev", select: "GPU-b", smi: async () => Promise.reject(new Error("refused")) },
      ],
      deviceMode: "dedicated",
      stateDir: dir,
      scratchDir: dir,
    });
    assert.deepEqual(
      h.devices.map((d) => [d.role, d.uuid, d.cuda]),
      [["judge", "GPU-a", "12.4"]],
    );
    assert.ok(asked.some((a) => a.join(" ").endsWith("-i GPU-a")));
    assert.match(h.errors.join(" "), /dev card: Error: refused/);
    assert.ok(h.cpu.host >= 1 && h.cpu.usable >= 1);
    assert.ok(h.memory.host_mib > 0);
    assert.equal(h.disks.length, 2);
    assert.equal(h.target.type, "cpu");
    assert.deepEqual(readHardware(JSON.parse(JSON.stringify(h))), JSON.parse(JSON.stringify(h)));
    assert.equal(readHardware({ devices: "x" }), null);
  });

  test("reports the image a release built, and none for an empty id", async () => {
    const dir = mkdtempSync(`${tmpdir()}/thermite-hw-`);
    const image = async () =>
      (
        await collectHardware({
          driver: new CpuDriver("generic-cpu"),
          deviceMode: "shared",
          stateDir: dir,
          scratchDir: dir,
        })
      ).os.image;
    const before = process.env.THERMITE_IMAGE_ID;
    try {
      process.env.THERMITE_IMAGE_ID = "0.1.0-cuda+1a2b3c4d5e6f";
      assert.equal(await image(), "0.1.0-cuda+1a2b3c4d5e6f");
      // An image built from a checkout has the variable, empty.
      process.env.THERMITE_IMAGE_ID = "";
      assert.equal(await image(), null);
      delete process.env.THERMITE_IMAGE_ID;
      assert.equal(await image(), null);
    } finally {
      if (before === undefined) delete process.env.THERMITE_IMAGE_ID;
      else process.env.THERMITE_IMAGE_ID = before;
    }
  });
});
