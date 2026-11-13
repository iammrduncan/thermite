import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseVulkanSummary, realGpu, VulkanDriver } from "../../../src/harness/targets/vulkan.ts";

/**
 * `vulkaninfo --summary` as a container on a Podman machine made with libkrun gives it, on a Mac
 * with an M4 Pro: the Mac's GPU through Mesa's Venus driver, then Mesa's software device. The
 * UUIDs are made up, and the conformance version, which the driver does not read, is left out.
 */
const VENUS = `GPU0:
	apiVersion         = 1.3.0
	driverVersion      = 26.2.4
	vendorID           = 0x106b
	deviceID           = 0x1a050209
	deviceType         = PHYSICAL_DEVICE_TYPE_INTEGRATED_GPU
	deviceName         = Virtio-GPU Venus (Apple M4 Pro)
	driverID           = DRIVER_ID_MESA_VENUS
	driverName         = venus
	driverInfo         = Mesa 26.2.4-1ubuntu1
	deviceUUID         = 0f1e2d3c-4b5a-5678-8a9b-c0d1e2f3a4b5
	driverUUID         = a1b2c3d4-e5f6-0718-0293-a4b5c6d7e8f9
`;
const SOFTWARE = `GPU0:
	apiVersion         = 1.4.354
	driverVersion      = 26.2.4
	vendorID           = 0x10005
	deviceID           = 0x0000
	deviceType         = PHYSICAL_DEVICE_TYPE_CPU
	deviceName         = llvmpipe (LLVM 22.1.8, 128 bits)
	driverID           = DRIVER_ID_MESA_LLVMPIPE
	driverName         = llvmpipe
	driverInfo         = Mesa 26.2.4-1ubuntu1 (LLVM 22.1.8)
	deviceUUID         = 6d657361-3236-2e32-2e34-2d3175627500
`;
const HEAD = `==========
VULKANINFO
==========

Vulkan Instance Version: 1.4.341

Instance Extensions: count = 2
-------------------------------
VK_EXT_debug_utils                     : extension revision 2
VK_KHR_surface                         : extension revision 25

Devices:
========
`;
const both = `${HEAD}${VENUS}${SOFTWARE.replace("GPU0:", "GPU1:")}`;

describe("a GPU reached through Vulkan", () => {
  test("the devices vulkaninfo lists are read, in its order", () => {
    const devices = parseVulkanSummary(both);
    assert.deepEqual(
      devices.map((d) => [d.name, d.kind, d.driver]),
      [
        ["Virtio-GPU Venus (Apple M4 Pro)", "INTEGRATED_GPU", "venus"],
        ["llvmpipe (LLVM 22.1.8, 128 bits)", "CPU", "llvmpipe"],
      ],
    );
    assert.deepEqual(devices[0], {
      name: "Virtio-GPU Venus (Apple M4 Pro)",
      kind: "INTEGRATED_GPU",
      vendor: "0x106b",
      device: "0x1a050209",
      driver: "venus",
      driverInfo: "Mesa 26.2.4-1ubuntu1",
      api: "1.3.0",
      uuid: "0f1e2d3c-4b5a-5678-8a9b-c0d1e2f3a4b5",
    });
    assert.deepEqual(parseVulkanSummary(HEAD), [], "no device listed");
    assert.deepEqual(parseVulkanSummary(""), []);
  });

  test("the rig's device is the first real GPU, never the software one", () => {
    assert.equal(realGpu(parseVulkanSummary(both))?.driver, "venus");
    // The software device first, as some loaders order them: the GPU is still the one taken.
    const swapped = `${HEAD}${SOFTWARE}${VENUS.replace("GPU0:", "GPU1:")}`;
    assert.equal(realGpu(parseVulkanSummary(swapped))?.driver, "venus");
    assert.equal(realGpu(parseVulkanSummary(`${HEAD}${SOFTWARE}`)), undefined);
  });

  test("it says which device it is, the same each time, and that it is ready", async () => {
    const driver = new VulkanDriver({ targetClass: "apple-m4-pro", info: async () => both });
    assert.equal(driver.type, "vulkan-gpu");
    const id = await driver.identify();
    assert.equal(id.type, "vulkan-gpu");
    assert.equal(id.class, "apple-m4-pro");
    assert.match(id.id, /^vulkan-[0-9a-f]{16}$/);
    assert.equal((await driver.identify()).id, id.id);
    assert.equal(id.details.name, "Virtio-GPU Venus (Apple M4 Pro)");
    assert.equal(id.details.driver_info, "Mesa 26.2.4-1ubuntu1");
    const ready = await driver.readyForTiming();
    assert.deepEqual([ready.ready, ready.reasons], [true, []]);
    assert.deepEqual(await driver.afterBlock(), [], "the device reports nothing after a block");
    assert.deepEqual(driver.plausibility({ a: 1, b: Number.NaN }), ["b is not finite"]);
  });

  test("with only the software device, or none, it is not ready, in words", async () => {
    const software = new VulkanDriver({
      targetClass: "vulkan-gpu",
      info: async () => `${HEAD}${SOFTWARE}`,
    });
    const r = await software.readyForTiming();
    assert.equal(r.ready, false);
    assert.match(r.reasons[0] ?? "", /no GPU, only llvmpipe .*computes on the CPU.*\/dev\/dri/);
    await assert.rejects(software.identify(), /Vulkan lists no GPU/);
    const none = new VulkanDriver({ targetClass: "vulkan-gpu", info: async () => HEAD });
    assert.match((await none.readyForTiming()).reasons[0] ?? "", /Vulkan lists no device/);
    // vulkaninfo itself failing (not in the image, or it can't start) is a reason too.
    const broken = new VulkanDriver({
      targetClass: "vulkan-gpu",
      info: async () => {
        throw new Error("vulkaninfo exited 1");
      },
    });
    assert.deepEqual((await broken.readyForTiming()).reasons, ["vulkaninfo exited 1"]);
  });

  test("a device setup that failed keeps it from timing, whatever Vulkan lists", async () => {
    const driver = new VulkanDriver({
      targetClass: "vulkan-gpu",
      info: async () => both,
      unusable: "the GPU's device nodes could not be restricted",
    });
    assert.deepEqual(await driver.readyForTiming(), {
      ready: false,
      reasons: ["the GPU's device nodes could not be restricted"],
      details: {},
    });
  });
});
