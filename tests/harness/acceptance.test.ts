import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { sentence } from "../../src/control/ui/words/index.ts";
import type { RigView, StoredEvent } from "../../src/control/views/index.ts";
import type { HillClimbContract } from "../../src/core/contract.ts";
import { ownersAcceptance, withOwnersAcceptance } from "../../src/harness/acceptance.ts";
import { objectiveOf } from "../../src/harness/agents/scheduler/context.ts";
import { RUN, setup } from "./queue/setup.ts";

/**
 * A running run's acceptance changed in place by the owner (goal 233): each metric's minimum
 * effect, a confirmation's blocks and the early stop, over the contract's, which the judge's next
 * job and the agents' next briefs take; null back to the contract's; the owner's alone; History
 * says each change.
 */

describe("a running run's acceptance", () => {
  test("the owner changes it in place; the judge's contract and the agents' objective take it", async () => {
    const s = await setup();
    const ledger = s.env.service.ledger;
    const contract = s.env.service.contractFor(RUN) as HillClimbContract;
    const primary = contract.objective.primary.metric;
    const why = "gains of 0.9% were missed, and a neutral change ran 6 blocks";
    const preview = await s.command("acceptance", {
      run: RUN,
      acceptance: { min_effects: { [primary]: 0.007 }, futility: 0.8 },
      reason: why,
      preview: true,
    });
    assert.match(
      String(preview.result.words),
      new RegExp(
        `would be ${primary}'s minimum effect 0\\.7%, the early stop at a confidence of 0\\.8, from the judge's next screen`,
      ),
    );
    assert.deepEqual(ownersAcceptance(ledger, RUN), {}, "nothing changed");

    const set = await s.command("acceptance", {
      run: RUN,
      acceptance: { min_effects: { [primary]: 0.007 }, confirm_blocks: 3, futility: 0.8 },
      reason: why,
    });
    assert.ok(set.accepted, JSON.stringify(set));
    const judged = withOwnersAcceptance(contract, ownersAcceptance(ledger, RUN));
    assert.equal(judged.acceptance.confirm_blocks, 3);
    assert.equal(judged.acceptance.futility, 0.8);
    assert.deepEqual(judged.acceptance.min_effects, { [primary]: 0.007 });
    assert.equal(judged.acceptance.alpha_screen, contract.acceptance.alpha_screen, "the rest kept");
    assert.equal(contract.acceptance.futility, undefined, "the contract itself is unchanged");
    const own = ownersAcceptance(ledger, RUN).min_effects;
    assert.match(objectiveOf(contract, undefined, own), /at least 0\.7% to count/);

    // One back to the contract's, the others kept.
    await s.command("acceptance", {
      run: RUN,
      acceptance: { confirm_blocks: null },
      reason: "kept",
    });
    assert.deepEqual(ownersAcceptance(ledger, RUN), {
      min_effects: { [primary]: 0.007 },
      futility: 0.8,
    });
    // History says what changed and why.
    const e = s.events("acceptance_set")[0];
    assert.ok(e);
    const words = sentence({} as RigView, { ...e, seq: 1 } as never as StoredEvent)?.text ?? "";
    assert.match(
      words,
      new RegExp(`${primary}'s minimum effect 0\\.7%, a confirmation's blocks 3`),
    );
    assert.match(words, /the early stop at a confidence of 0\.8, from the judge's next screen/);
    assert.match(words, /gains of 0\.9% were missed/);
  });

  test("refused in words: nothing to change, out of bounds, an agent's token", async () => {
    const s = await setup();
    await assert.rejects(
      () => s.command("acceptance", { run: RUN, acceptance: {}, reason: "x" }),
      /give at least one of min_effects, confirm_blocks and futility/,
    );
    await assert.rejects(
      () => s.command("acceptance", { run: RUN, acceptance: { futility: 0.3 }, reason: "x" }),
      /greater than or equal|too_small/i,
    );
    const agent = await s.command(
      "acceptance",
      { run: RUN, acceptance: { confirm_blocks: 3 }, reason: "x" },
      "agent",
    );
    assert.match(String(agent.result.error), /acceptance is the owner's to issue/);
  });
});
