import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { Registry } from "../../../src/harness/agents/registry.ts";
import { type FamilyStatus, Ledger } from "../../../src/harness/ledger/index.ts";

/**
 * A family's status in the direction registry (goal 174): `live` or `exhausted`, each set only
 * from the other. `blocked`, which the family table's old check still names, is set by nothing.
 */
describe("a family's status", () => {
  test("is live when added, exhausted only from live, and live again only from exhausted", () => {
    const ledger = Ledger.open(join(mkdtempSync(join(tmpdir(), "thermite-trials-")), "ledger.db"));
    const registry = new Registry(ledger);
    registry.addFamily("run-1", "tiling", "tile the loops", "planner");
    const status = () => registry.families("run-1").find((f) => f.id === "tiling")?.status;
    const set = (to: FamilyStatus, from: FamilyStatus, id = "tiling") =>
      ledger.trials.setFamilyStatus("run-1", id, to, from);
    assert.equal(status(), "live");
    assert.equal(set("live", "exhausted"), false, "it is not exhausted");
    assert.equal(set("exhausted", "live"), true);
    assert.equal(set("exhausted", "live"), false, "it is exhausted already");
    assert.equal(status(), "exhausted");
    assert.equal(set("live", "exhausted"), true);
    assert.equal(status(), "live");
    assert.equal(set("exhausted", "live", "no-such-family"), false);
    // The type check fails here if `blocked` becomes a family's status again.
    // @ts-expect-error: nothing sets a family `blocked`, so it is no FamilyStatus
    const blocked: FamilyStatus = "blocked";
    assert.equal(typeof blocked, "string");
  });
});
