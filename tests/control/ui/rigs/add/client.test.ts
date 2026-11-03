import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { judgeShareOf } from "../../../../../src/control/clusters/resources.ts";
import { ADD_RIG_JS, JUDGE_SHARE_JS } from "../../../../../src/control/ui/rigs/add/client.ts";

describe("Add a rig's preview of the GPU split (goal 161)", () => {
  const share = new Function(`return ${JUDGE_SHARE_JS}`)() as (
    n: number,
    typed: string,
  ) => number | string | undefined;

  test("refuses what control refuses: the judge takes at most 8, and so do the agents", () => {
    for (let n = 0; n <= 17; n++)
      for (const typed of ["", "0", "1", "2", "7", "8", "9", "12", "16", "3.5", "x"]) {
        const control = judgeShareOf(typed ? Number(typed) : undefined, n);
        assert.deepEqual(share(n, typed), control, `${n} GPUs, "${typed}" typed`);
      }
    assert.equal(
      share(12, "10"),
      "With 12 GPUs the judge takes 1 to 8 of them, and the agents at most 8.",
    );
  });

  test("the page's script parses", () => {
    assert.doesNotThrow(() => new Function(ADD_RIG_JS));
  });
});
