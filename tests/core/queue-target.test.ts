import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { contractSha, parseContract } from "../../src/core/contract.ts";
import {
  ideaWords,
  queueTarget,
  queueTargetWords,
  ruleRefusal,
} from "../../src/core/queue-target.ts";
import { hillClimbFixture } from "../helpers/fixtures.ts";

describe("a run's target queue depth (goal 081)", () => {
  test("two for each lane by default; the contract's own number when it sets one", () => {
    assert.equal(queueTarget({ lanes: { count: 3 } }), 6);
    assert.equal(queueTarget({ lanes: { count: 3 } }, 2), 4, "the lanes now count");
    assert.equal(queueTarget({ lanes: { count: 3, queue_target: 9 } }, 2), 9);
    assert.equal(queueTarget({ lanes: { count: 3, queue_target: 0 } }), 0);
    assert.equal(queueTargetWords({ lanes: { count: 2 } }), "4 (2 for each of 2 lanes)");
    assert.equal(queueTargetWords({ lanes: { count: 1 } }), "2 (2 for each of 1 lane)");
    assert.equal(
      queueTargetWords({ lanes: { count: 2, queue_target: 7 } }),
      "7 (the campaign's own number)",
    );
    assert.equal(
      queueTargetWords({ lanes: { count: 2, queue_target: 0 } }),
      "0 (no ideas are asked for)",
    );
  });

  test("the contract takes it in lanes, and a contract without it keeps its hash", () => {
    const base = hillClimbFixture;
    const before = parseContract(base);
    assert.ok(before.ok);
    const lanes = { count: 2, trials_per_epoch: 3 };
    const set = parseContract({ ...base, lanes: { ...lanes, queue_target: 8 } });
    assert.ok(set.ok);
    assert.equal(set.contract.lanes.queue_target, 8);
    assert.equal(before.contract.lanes.queue_target, undefined);
    assert.equal(contractSha(before.contract), before.sha);
    const bad = parseContract({ ...base, lanes: { ...lanes, queue_target: -1 } });
    assert.ok(!bad.ok);
    assert.match(bad.errors.join(";"), /lanes\.queue_target/);
  });

  test("two ideas with the same words are one", () => {
    assert.equal(ideaWords("  Wider loads (float4)! "), "wider loads float4");
    assert.equal(ideaWords("wider-loads float4"), ideaWords("Wider loads: float4"));
    assert.notEqual(ideaWords("wider loads"), ideaWords("narrow loads"));
  });
});

describe("rules code refuses (goal 081)", () => {
  type Rule = Parameters<typeof ruleRefusal>[0];
  const note = (rationale: string): Rule => ({ kind: "note", rationale });
  const ID = "x-0123456789ab";

  // Each a rule that must stand: a direction or a kind of idea, a project's own queues, an
  // experiment cited as evidence or asked for once. The review of goal 081 found most refused.
  const allowed: [string, Rule][] = [
    [
      "an avoid rule about a kind of idea",
      {
        kind: "avoid",
        family: "loop unrolling",
        rationale: "Do not add more unrolling experiments: null in a-1, a-2 and a-3",
      },
    ],
    ["a note against a kind of idea", note("Stop proposing tiling ideas")],
    [
      "more of one kind, with what narrows it after",
      note("Do not add more experiments on tiling until a-4 is measured again"),
    ],
    ["no new ideas of one kind", note("No new experiments on tiling; they measured null")],
    [
      "a project's queue that is full",
      { kind: "try", family: "backoff", rationale: "back off when the submission queue is full" },
    ],
    ["a project's queue depth", note("Limit the queue depth of io_uring")],
    ["a project's queue depth, with a number", note("Limit the queue to 64 entries")],
    ["a project's buffers", note("Do not create a new buffer per item")],
    ["a project's allocations", note("allocate no new items in the hot loop")],
    ["items a project queues", note("Do not add items to the queue from the IRQ handler")],
    [
      "a direction's name",
      { kind: "try", family: "queue full backoff", rationale: "spinning wastes the core" },
    ],
    [
      "an avoid rule's direction about queues",
      { kind: "avoid", family: "queue", rationale: "null in a-5" },
    ],
    [
      "a mandate that cites an experiment",
      { kind: "mandate", family: "vectorize", rationale: `${ID} gave 4% (a-7)` },
    ],
    [
      "a priority that cites an experiment",
      { kind: "priority", family: "memory", value: 1, rationale: `${ID} showed reads dominate` },
    ],
    [
      "a mandate whose reason says the experiment must run",
      { kind: "mandate", family: "tiling", rationale: `${ID} must run` },
    ],
    ["an experiment and until", note(`${ID} regressed until the warm-up fix landed`)],
    ["an experiment and retry", note(`retry the tiling direction with a warm-up: ${ID} had none`)],
    // Asked for once, not kept first or run again: its place is the queue's, and moves change it.
    ["an experiment asked for next", note(`Run ${ID} next`)],
    ["a full queue of one kind", note("keep the experiment queue full of memory ideas")],
    [
      "evidence about the queue",
      note("the queue holds two tiling experiments; prefer the memory ones"),
    ],
    ["an experiment as evidence", note(`${ID} showed reads dominate: look at the loads`)],
    ["asking for more", note("add experiments on vector loads")],
    ["measured null", note("tiling measured null three times (a-1, a-2, a-3)")],
  ];

  // Each a rule that clearly freezes the run's queue as a whole.
  const freezes: [string, Rule][] = [
    ["queue entries", note("Do not add queue entries until the sweep finishes")],
    ["unchanged", note("keep the queue unchanged")],
    ["as it is", note("Keep the queue as it is for now")],
    ["freeze", note("freeze the queue")],
    ["no new experiments", note("No new experiments: the lanes have enough")],
    ["no more for the queue", note("don't propose more experiments for the queue")],
    ["frozen", note("the queue is frozen")],
    ["at most a number", note("at most 2 experiments in the queue")],
    ["hold off", note("Hold off on new experiments")],
    ["the backlog", note("Leave the backlog unchanged")],
    ["only the queued ones", note("Only work on the queued experiments, nothing new")],
    ["stop adding to it", note("Stop adding to the queue")],
    ["nothing to it", note("Do not add anything to the queue.")],
    ["a cap by its name", note("cap the experiment queue at 5")],
    ["a cap with experiments", note("Cap the queue at 4 experiments")],
    ["small, by its name", note("Keep the experiment queue small")],
    ["in the value", { kind: "note", value: "Do not add queue entries", rationale: "steady" }],
    ["in the value, kept", { kind: "note", value: "keep the queue unchanged", rationale: "r" }],
  ];
  // Each a rule that pins a named experiment: kept first, retried, run again; or its subject.
  const pins: [string, Rule][] = [
    ["kept at the top", note(`keep ${ID} at the top until it is measured`)],
    ["retried", note(`retry ${ID} first`)],
    ["pinned", note(`pin ${ID}`)],
    ["run again", note(`run ${ID} again`)],
    ["run until", note(`try ${ID} until it passes`)],
    ["must be retried", note(`${ID} must be retried`)],
    ["stays first", note(`${ID} stays at the top`)],
    [
      "a priority of an experiment",
      { kind: "priority", value: ID, rationale: "it was tried again" },
    ],
    [
      "a mandate of an experiment",
      { kind: "mandate", family: `:${ID}:`, rationale: "it must run" },
    ],
  ];

  test("rules about directions, kinds of idea and a project's own queues stand", () => {
    for (const [what, r] of allowed) assert.equal(ruleRefusal(r), undefined, what);
  });

  test("a rule that freezes the run's queue as a whole is refused, with why", () => {
    for (const [what, r] of freezes) {
      const out = ruleRefusal(r);
      assert.equal(out?.reason, "freezes_queue", what);
      assert.match(out?.why ?? "", /may not freeze the queue's size \("/, what);
    }
  });

  test("a rule that pins a named experiment is refused, with why", () => {
    for (const [what, r] of pins) {
      const out = ruleRefusal(r);
      assert.equal(out?.reason, "pins_experiment", what);
      assert.match(out?.why ?? "", /may not pin an experiment \(x-0123456789ab\)/, what);
    }
  });
});
