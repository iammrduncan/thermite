import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { RunpodRefused } from "../../../../src/control/runpod/cloud.ts";
import { noFreeGpu } from "../../../../src/control/runpod/lifecycle.ts";

/**
 * RunPod's answers for a GPU it has none of (noFreeGpu): each wording is read as no GPU free, and
 * other refusals are not.
 */

describe("RunPod's no-stock answers", () => {
  test("each wording RunPod uses for a GPU it has none of is read as no GPU free; other refusals are not", () => {
    for (const words of [
      "RunPod answered 400 for POST /v2/pods (Bad Request: There are no longer any instances available with the requested specifications. Please refresh and try again.)",
      "RunPod answered 400 for POST /v2/pods (Bad Request: no capacity for that GPU)",
      "RunPod answered 400 for POST /v2/pods/p1/start (Bad Request: not enough free GPUs on the host machine)",
    ])
      assert.equal(noFreeGpu(new RunpodRefused(400, words)), words);
    assert.equal(
      noFreeGpu(
        new RunpodRefused(
          400,
          "RunPod answered 400 for POST /v2/pods (Bad Request: imageName is required)",
        ),
      ),
      undefined,
    );
    assert.equal(noFreeGpu(new Error("no capacity")), undefined, "only RunPod's own refusals");
  });
});
