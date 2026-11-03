import assert from "node:assert/strict";
import { test } from "node:test";
import { attemptState, verdictText } from "../../../../src/control/ui/words/verdicts.ts";

test("a verdict or a state named like an object's own property is shown as its own words", () => {
  assert.equal(verdictText("win_confirmed", 0.142), "confirmed faster on fresh runs (+14.2%)");
  for (const name of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
    assert.equal(verdictText(name), name.replace(/_/g, " "));
    assert.equal(
      attemptState({ verdict: null, lifecycle: name, delta: null }),
      name.replace(/_/g, " "),
    );
    assert.equal(
      attemptState({ verdict: name, lifecycle: "judged", delta: null }),
      name.replace(/_/g, " "),
    );
  }
  assert.equal(
    attemptState({ verdict: null, lifecycle: "awaiting_audit", delta: null }),
    "held for an audit",
  );
});
