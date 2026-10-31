import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { checkRow } from "../../src/control/command-progress.ts";
import type { CommandRow } from "../../src/control/store/index.ts";
import type { RigCheckView } from "../../src/control/views/index.ts";

const cmd = (id: string, at: string): CommandRow => ({
  id: "c-1",
  rig: "rig-1",
  kind: "rig_check",
  issued_by: "owner",
  issued_at: at,
  expires_at: "2026-10-21T08:39:00.000Z",
  status: "delivered",
  acked_at: at,
  outcome: { accepted: true, result: { check: "model", id, started: true } },
  payload: { check: "model" },
});
const run = (id: string, started: string, finished: string | null): RigCheckView => ({
  check: "model",
  started_at: started,
  finished_at: finished,
  ok: finished ? true : null,
  summary: finished ? "answered with a correct tool call" : null,
  note: null,
  id,
});
const now = Date.parse("2026-10-24T04:55:00.000Z");

describe("a rig check's row", () => {
  test("a run newer than the last command shows, though its id is not the command's", () => {
    // The owner's check ran on 10-21; the rig checked again by itself on 10-22, with a new id.
    const row = checkRow(
      "model",
      run("chk-0cc55dccd4c1", "2026-10-22T03:29:23.614Z", "2026-10-22T03:29:25.365Z"),
      cmd("chk-8147bb669863", "2026-10-21T07:39:48.000Z"),
      now,
    );
    assert.equal(row.state, "passed");
  });

  test("the command's own run shows by its id; until it reaches control the row is running", () => {
    const at = "2026-10-24T04:50:00.000Z";
    const mine = checkRow(
      "model",
      run("chk-a", "2026-10-24T04:50:01.000Z", "2026-10-24T04:50:05.000Z"),
      cmd("chk-a", at),
      now,
    );
    assert.equal(mine.state, "passed");
    const waiting = checkRow(
      "model",
      run("chk-old", "2026-10-24T03:00:00.000Z", "2026-10-24T03:00:05.000Z"),
      cmd("chk-a", at),
      now,
    );
    assert.deepEqual([waiting.state, waiting.since], ["running", at]);
  });
});
