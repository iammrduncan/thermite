import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseContract } from "../../../src/core/contract.ts";
import { Registry } from "../../../src/harness/agents/registry.ts";
import { researchFixture } from "../../helpers/fixtures.ts";
import { makeHarnessEnv } from "../../helpers/harness-env.ts";
import { controlQueue, RUN, setup } from "./setup.ts";

/**
 * A run's directions: a research run's are its task kinds, and a run's come from its experiments,
 * its registry and its attempts, the same in control's view.
 */

describe("the owner's queue commands", () => {
  test("a research run's directions are its task kinds: its planner designs no new one", async () => {
    const env = makeHarnessEnv("rig-r");
    const parsed = parseContract(researchFixture);
    if (!parsed.ok) throw new Error(parsed.errors.join("; "));
    const out = await env.service.applyCommand(
      env.sign("assign_campaign", {
        run: "r-1",
        contract: parsed.contract,
        contract_sha: parsed.sha,
        imports: [],
      }),
    );
    assert.equal(out.status, "applied", JSON.stringify(out));
    assert.deepEqual(env.service.queue.directions("r-1"), [
      "consolidate",
      "contradict",
      "explore",
      "primary",
    ]);
    const rule = (family: string) =>
      env.service.applyCommand(
        env.sign("redirect", {
          run: "r-1",
          directives: [{ kind: "avoid", family, rationale: "r", citations: [] }],
          replace: false,
        }),
      );
    const bad = await rule("shared memory");
    assert.match(
      JSON.stringify(bad),
      /A research run's directions are its task kinds: :explore:, :primary:, :contradict:, :consolidate:\. Its planner designs no new direction/,
    );
    const kind = await rule(":contradict:");
    assert.ok(kind.status === "applied" && kind.accepted, JSON.stringify(kind));
    // An advisor's rule for another direction is left out, with why; the rest of its set stands.
    const r = env.service.setAdvisorRules(
      "r-1",
      [
        { kind: "try", family: "primary", rationale: "r", citations: ["a"] },
        { kind: "avoid", family: "blogs", rationale: "r", citations: ["a"] },
      ],
      "supervisor",
    );
    assert.equal(r.ids.length, 1);
    assert.deepEqual(
      r.left_out.map((x) => x.rule),
      ["avoid blogs"],
    );
  });

  test("the run's directions: its experiments', its registry's and its attempts', the same in control's view", async () => {
    const s = await setup();
    s.q.add(RUN, { title: "a", family: "Shared memory tiling", by: "owner" }, "x");
    s.q.add(RUN, { title: "b", family: ":split k:", by: "owner" }, "x");
    s.q.add(RUN, { title: "c", by: "owner" }, "x");
    new Registry(s.env.service.ledger).addFamily(
      RUN,
      "dequant-fusion",
      "fuse it",
      "planner:planner",
    );
    assert.deepEqual(s.q.directions(RUN), ["dequant-fusion", "shared-memory-tiling", "split-k"]);
    // A :name: in an experiment's direction is kept without its colons.
    assert.equal(s.q.queued(RUN)[1]?.family, "split k");
    await s.command("redirect", {
      run: RUN,
      directives: [
        { kind: "mandate", family: "split-k", rationale: "x", citations: [] },
        { kind: "avoid", family: "brand new", rationale: "y", citations: [] },
      ],
    });
    const r = await controlQueue(s.events());
    assert.deepEqual(
      r.directions.map((d) => [d.name, d.queued, d.to_design, d.rules.map((x) => x.kind)]),
      [
        ["brand-new", 0, true, ["avoid"]],
        ["dequant-fusion", 0, false, []],
        ["shared-memory-tiling", 1, false, []],
        ["split-k", 1, false, ["mandate"]],
      ],
    );
    assert.equal(r.directions.find((d) => d.name === "dequant-fusion")?.description, "fuse it");
  });
});
