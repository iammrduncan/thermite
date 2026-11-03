import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ADMIN, controlOnly } from "../../helpers/control-stack.ts";
import { ingestReport } from "../../helpers/control-store.ts";

/**
 * Goal 117: control signs a hypothesis_status only for a research run. A run its rig reports as
 * a hill climb or a goal campaign has no hypotheses: control refuses before it signs anything,
 * in the words the harness would use. A run the rig has not reported yet is the rig's to check.
 */

describe("hypothesis_status at control (goal 117)", () => {
  test("refused for a run the rig reports as no research run; signed for a research run", async () => {
    const { store, control } = controlOnly({ tokens: { rigs: {} } });
    const created = (id: number, run: string, mode: string) => ({
      id,
      at: new Date().toISOString(),
      actor: "harness",
      kind: "run_created",
      subject: run,
      body: { campaign: `c-${mode}`, mode, version: 1, agents: true },
    });
    await ingestReport(store, {
      rig: "rig-r",
      ledger_id: "ledger-r",
      cursor: 0,
      next: 3,
      generated_at: new Date().toISOString(),
      events: [created(1, "r-1", "research"), created(2, "h-1", "hill_climb")],
      summary: {},
    });
    const post = (run: string) =>
      control.request("/v1/commands", {
        method: "POST",
        headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
        body: JSON.stringify({
          rig: "rig-r",
          kind: "hypothesis_status",
          payload: { run, id: "h-3f2a9c41d0b7", status: "promoted", reason: "central to Q2" },
        }),
      });
    const bad = await post("h-1");
    assert.equal(bad.status, 400);
    assert.equal(
      ((await bad.json()) as { error: string }).error,
      "Run h-1 is not a research run: only a research run has hypotheses to promote or retire.",
    );
    assert.equal(store.commands.list(10).length, 0, "nothing was signed");
    assert.equal((await post("r-1")).status, 201);
    assert.equal((await post("r-2")).status, 201, "a run not reported yet: the rig checks it");
    assert.deepEqual(
      store.commands.list(10).map((c) => c.kind),
      ["hypothesis_status", "hypothesis_status"],
    );
  });
});
