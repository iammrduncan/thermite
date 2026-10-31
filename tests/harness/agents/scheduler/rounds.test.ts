import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { type LaneInRound, roundOver } from "../../../../src/harness/agents/scheduler/rounds.ts";

const lane = (started: number, busy = false, waitsForJudge = false): LaneInRound => ({
  started,
  busy,
  waitsForJudge,
});

describe("when a round ends (goal 136)", () => {
  test("once every free lane has started its trials, whatever the busy lanes do", () => {
    assert.equal(roundOver([lane(3), lane(3)], 3), true);
    assert.equal(roundOver([lane(3), lane(1, true)], 3), true, "a busy lane doesn't hold it");
    assert.equal(roundOver([lane(3), lane(0, true)], 3), true, "nor one on an older round's trial");
    assert.equal(roundOver([lane(3), lane(2)], 3), false, "a free lane has a trial to run");
  });

  test("not while no lane is free: nobody waits, and the next plan sees more", () => {
    assert.equal(roundOver([lane(3, true), lane(3, true)], 3), false);
    assert.equal(roundOver([], 3), false);
  });

  test("not while a change waits for the judge, when the run waits for verdicts", () => {
    assert.equal(roundOver([lane(3), lane(3, false, true)], 3), false);
    assert.equal(roundOver([lane(3, false, true), lane(1, true)], 3), false);
  });
});
