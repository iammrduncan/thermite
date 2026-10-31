import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { controlQueue, RUN, setup } from "./setup.ts";

/**
 * The run's rules in the owner's queue commands: drop_directive, a rule names a direction, an old
 * rule in words stays in force as legacy, and its conversion to a rule on a direction.
 */

describe("the owner's queue commands", () => {
  test("drop_directive removes a rule in force, whoever set it; a rule names a direction", async () => {
    const s = await setup();
    s.q.add(RUN, { title: "tile it", family: "Tiling", by: "owner" }, "control:owner:ui");
    const set = await s.command("redirect", {
      run: RUN,
      directives: [
        // Plain words with spaces, or :name:, name a direction; one the run doesn't have yet
        // is new, and the planner designs it.
        { kind: "avoid", family: "Timer code", rationale: "it is the judge's", citations: [] },
        { kind: "try", family: ":tiling:", rationale: "won elsewhere", citations: [] },
      ],
    });
    assert.ok(set.accepted, JSON.stringify(set));
    assert.deepEqual(set.result.new_directions, ["timer-code"]);
    assert.deepEqual(
      s.env.service.ledger.directives.active(RUN).map((d) => (d.body as { family: string }).family),
      ["timer-code", "tiling"],
    );
    const supervisorIds = s.env.service.addDirectives(
      RUN,
      [{ kind: "try", family: "unroll", rationale: "r", citations: ["a-1"] }],
      "supervisor",
    );
    const active = () => s.env.service.ledger.directives.active(RUN).map((d) => d.id);
    assert.equal(active().length, 3);
    const dropped = await s.command("drop_directive", { run: RUN, id: supervisorIds[0] });
    assert.ok(dropped.accepted, JSON.stringify(dropped));
    assert.equal(active().length, 2);
    const e = s.events("directive_dropped").at(-1);
    assert.deepEqual(e?.body, { id: supervisorIds[0] });
    assert.equal(e?.actor, "control:owner:ui");
    const gone = await s.command("drop_directive", { run: RUN, id: supervisorIds[0] });
    assert.match(String(gone.result.error), /no rule \d+ in force in run smoke-1/);
    // The advisors' next set cannot bring back a rule the owner removed; the owner can.
    const again = s.env.service.addDirectives(
      RUN,
      [
        { kind: "try", family: "unroll", rationale: "r", citations: ["a-2"] },
        { kind: "avoid", family: "gather", rationale: "r", citations: ["a-2"] },
      ],
      "supervisor",
    );
    assert.equal(again.length, 1, "only the new rule");
    assert.deepEqual(s.events("directives_left_out").at(-1)?.body, {
      rules: [{ kind: "try", family: "unroll", rationale: "r", citations: ["a-2"] }],
      why: "the owner removed these rules",
    });
    const owner = await s.command("redirect", {
      run: RUN,
      directives: [{ kind: "try", family: "unroll", rationale: "back", citations: [] }],
      replace: false,
    });
    assert.ok(owner.accepted, JSON.stringify(owner));
    // A rule names a direction: words (match) are no longer a rule, nor is text that can't be a
    // direction's name. The harness refuses them, in plain words, as control does before signing.
    for (const [bad, why] of [
      [
        { kind: "avoid", family: "tiling", match: "tiles", rationale: "x" },
        /no longer takes match/,
      ],
      [{ kind: "priority", match: "tiles", rationale: "x" }, /no longer takes match/],
      [{ kind: "avoid", rationale: "names nothing" }, /names a direction \(family\)/],
      [
        { kind: "avoid", family: "anything with $hared memory!", rationale: "x" },
        /is not a direction's name: write it in letters, digits, spaces and dashes/,
      ],
      [
        {
          kind: "avoid",
          family: "a direction whose name is far too long to be one",
          rationale: "x",
        },
        /too long for a direction's name/,
      ],
    ] as const) {
      const r = await s.env.service.applyCommand(
        s.env.sign("redirect", { run: RUN, directives: [bad] }),
      );
      assert.equal(r.status, "rejected", JSON.stringify(bad));
      assert.match(JSON.stringify(r), why);
    }
    // The owner's set both avoiding and asking for the same direction is refused, however written.
    const both = await s.command("redirect", {
      run: RUN,
      directives: [
        { kind: "avoid", family: "Vector loads", rationale: "x", citations: [] },
        { kind: "try", family: ":vector-loads:", rationale: "y", citations: [] },
      ],
    });
    assert.match(String(both.result.error), /both avoids and asks for vector-loads/);
  });

  test("an old rule in words stays in force, marked legacy, until it is converted or the owner removes it", async () => {
    const s = await setup();
    // As an older harness wrote it: a new one can't be made.
    const [old] = s.env.service.ledger.directives.addSet(
      RUN,
      "control:owner:ui",
      [{ kind: "avoid", match: "anything with shared memory", rationale: "slow", citations: [] }],
      false,
    );
    const brief = s.env.service.brief(RUN) as { directives: Record<string, unknown>[] };
    assert.deepEqual(brief.directives[0], {
      id: old,
      author: "control:owner:ui",
      body: {
        kind: "avoid",
        match: "anything with shared memory",
        rationale: "slow",
        citations: [],
      },
      legacy: true,
    });
    // Control marks it too, from the rig's events; it names no direction.
    const r = await controlQueue(s.events());
    assert.deepEqual(
      r.rules.map((x) => [x.id, x.legacy]),
      [[old, true]],
    );
    assert.deepEqual(r.directions, []);
    // The advisors' next set doesn't drop it: only the owner removes it.
    s.env.service.addDirectives(
      RUN,
      [{ kind: "note", value: "a note", rationale: "r", citations: ["a-1"] }],
      "supervisor",
    );
    assert.ok(s.env.service.ledger.directives.active(RUN).some((d) => d.id === old));
    const gone = await s.command("drop_directive", { run: RUN, id: old });
    assert.ok(gone.accepted, JSON.stringify(gone));
    assert.ok(!s.env.service.ledger.directives.active(RUN).some((d) => d.id === old));
  });

  test("converting an old rule in words: a new rule with its author, kind, why and source; the old one ends as converted", async () => {
    const s = await setup();
    const ledger = s.env.service.ledger;
    const [named, old] = ledger.directives.addSet(
      RUN,
      "control:owner:ui",
      [
        { kind: "try", family: "tiling", rationale: "won", citations: [] },
        {
          kind: "mandate",
          match: "anything with vector loads",
          rationale: "the guide says so",
          citations: ["guide p. 4"],
          from_message: 3,
        },
      ],
      false,
    ) as [number, number];
    const to = ledger.directives.convertRule(RUN, old, "vector-loads", "planner");
    // The new rule: the old one's author, kind, why, citations and source, on a direction, with
    // the words it was converted from. Code keeps it: it is no longer legacy.
    const active = ledger.directives.active(RUN);
    assert.deepEqual(
      active.map((d) => d.id),
      [named, to],
    );
    assert.deepEqual(active[1], {
      id: to,
      author: "control:owner:ui",
      body: {
        kind: "mandate",
        family: "vector-loads",
        rationale: "the guide says so",
        citations: ["guide p. 4"],
        from_message: 3,
        converted_from: { rule: old, words: "anything with vector loads" },
      },
    });
    // The old rule stays in the record, as converted, never dropped.
    const row = ledger.db
      .prepare("select status, superseded_at from directive where id = ?")
      .get(old) as { status: string; superseded_at: string | null };
    assert.equal(row.status, "converted");
    assert.ok(row.superseded_at);
    const conv = s.events("directive_converted");
    assert.equal(conv.length, 1);
    assert.equal(conv[0]?.actor, "planner");
    assert.deepEqual(conv[0]?.body, {
      id: old,
      to,
      kind: "mandate",
      family: "vector-loads",
      words: "anything with vector loads",
    });
    assert.equal(s.events("directive").at(-1)?.actor, "control:owner:ui");
    // Control's view: the new rule in place of the old one, under its direction.
    const r = await controlQueue(s.events());
    assert.deepEqual(
      r.rules.map((x) => [x.id, x.legacy, x.author]),
      [
        [named, false, "control:owner:ui"],
        [to, false, "control:owner:ui"],
      ],
    );
    assert.deepEqual(r.rules[1]?.body.converted_from, {
      rule: old,
      words: "anything with vector loads",
    });
    assert.deepEqual(r.directions.find((d) => d.name === "vector-loads")?.rules, [
      { id: to, kind: "mandate" },
    ]);
    // Converted once: the old rule is no longer in force, and a rule on a direction is not one.
    assert.throws(
      () => ledger.directives.convertRule(RUN, old, "loads", "planner"),
      /no rule \d+ in force/,
    );
    assert.throws(
      () => ledger.directives.convertRule(RUN, named, "loads", "planner"),
      /names a direction already/,
    );
    assert.equal(s.events("directive_converted").length, 1);
  });
});
