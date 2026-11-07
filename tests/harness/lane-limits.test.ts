import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { sentence } from "../../src/control/ui/words/index.ts";
import type { RigView, StoredEvent } from "../../src/control/views/index.ts";
import { limitsInForce } from "../../src/harness/agents/coordinator.ts";
import { RUN, setup } from "./queue/setup.ts";

/**
 * A running run's lane limits changed in place by the owner (goal 221): over the contract's from
 * the next lane command and development run, each within the contract's bounds, null back to the
 * contract's, the owner's alone, and History says each change.
 */

describe("a running run's lane limits", () => {
  test("the owner changes them in place; null goes back to the contract's", async () => {
    const s = await setup();
    const contract = s.env.service.contractFor(RUN);
    const ledger = s.env.service.ledger;
    const before = limitsInForce(ledger, RUN, contract);
    assert.equal(before.devRunRssMib, 4096, "the default, which the contract does not set");
    const why = "every lane's engine build was killed at 4 GiB";
    const set = await s.command("lane_limits", {
      run: RUN,
      limits: { dev_run_rss_mib: 16_384, workspace_mib: 8192 },
      reason: why,
    });
    assert.ok(set.accepted, JSON.stringify(set));
    assert.deepEqual(set.result.limits, { dev_run_rss_mib: 16_384, workspace_mib: 8192 });
    const now = limitsInForce(ledger, RUN, contract);
    assert.equal(now.devRunRssMib, 16_384);
    assert.equal(now.workspaceMib, 8192);
    assert.equal(now.runRssMib, before.runRssMib, "a limit left out stays as it was");
    // One back to the contract's, the other kept.
    await s.command("lane_limits", { run: RUN, limits: { workspace_mib: null }, reason: "kept" });
    const after = limitsInForce(ledger, RUN, contract);
    assert.equal(after.devRunRssMib, 16_384);
    assert.equal(after.workspaceMib, before.workspaceMib);
    // History says what changed and why.
    const e = s.events("lane_limits_set")[0];
    assert.ok(e);
    const words = sentence({} as RigView, { ...e, seq: 1 } as never as StoredEvent)?.text ?? "";
    assert.match(words, /dev_run_rss_mib 16384, workspace_mib 8192/);
    assert.match(words, /every lane's engine build was killed at 4 GiB/);
  });

  test("refused in words: past the contract's bounds, nothing to change, an agent's token", async () => {
    const s = await setup();
    await assert.rejects(
      () =>
        s.command("lane_limits", { run: RUN, limits: { dev_run_rss_mib: 999_999 }, reason: "x" }),
      /262144|too_big|less than or equal/i,
    );
    await assert.rejects(
      () => s.command("lane_limits", { run: RUN, limits: {}, reason: "x" }),
      /give at least one of/,
    );
    const agent = await s.command(
      "lane_limits",
      { run: RUN, limits: { dev_run_rss_mib: 8192 }, reason: "x" },
      "agent",
    );
    assert.match(String(agent.result.error), /lane_limits is the owner's to issue/);
  });
});
