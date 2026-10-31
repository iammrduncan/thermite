import assert from "node:assert/strict";
import { cpus } from "node:os";
import { describe, test } from "node:test";
import { CpuDriver } from "../../../src/harness/targets/cpu.ts";

describe("cpu driver", () => {
  test("refuses to time on a loaded machine and accepts an idle one", async () => {
    const cores = cpus().length;
    const busy = new CpuDriver("t", { load: () => cores });
    const idle = new CpuDriver("t", { load: () => 0.1 });
    assert.equal((await busy.readyForTiming()).ready, false);
    assert.equal((await idle.readyForTiming()).ready, true);
  });

  test("non-finite metrics are implausible", () => {
    assert.deepEqual(new CpuDriver().plausibility({ a: 1, b: Number.NaN }), ["b is not finite"]);
  });
});
