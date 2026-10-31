/**
 * Old rules in words, from before rules named directions: converted at the planner's round, never
 * out of force without a rule in their place, and kept in force until a round can convert them.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { body, command, type Env, events, RUN, setup } from "./setup.ts";

describe("the planner as the queue's coordinator", () => {
  test("an old rule in words converts at the planner's round: to a named direction, with its author, kind, why and words", async (t) => {
    let x = "";
    let old = 0;
    const s = await setup(t, {
      // The first answer leaves the old rule as it is; the second converts it to a direction it
      // designs, and gives out an experiment the new rule asks for.
      planner: (_p, call) => ({
        ...(call > 1
          ? {
              new_families: [
                { id: "vector loads", description: "wider loads, such as half2 or float4" },
              ],
              convert: [{ rule: old, family: ":vector loads:" }],
            }
          : {}),
        assignments: [
          { lane: "lane-1", experiment: x, why: "w" },
          { lane: "lane-2", title: "load float4", family: "vector-loads", why: "the rule" },
        ],
      }),
    });
    x = await s.add("tile it", { family: "tiling" });
    // A rule in words from before rules named directions: a new one can't be made, so the
    // ledger gets it as an older harness wrote it.
    old = Number(
      s.env.service.ledger.directives.addSet(
        RUN,
        "control:owner:ui",
        [
          {
            kind: "try",
            match: "anything with vector loads",
            rationale: "old",
            citations: ["a-1"],
          },
        ],
        false,
      )[0],
    );
    const refused = await s.env.service.applyCommand(
      s.env.sign("redirect", {
        run: RUN,
        directives: [{ kind: "try", match: "anything", rationale: "r", citations: [] }],
      }),
    );
    assert.equal(refused.status, "rejected");
    assert.match(JSON.stringify(refused), /a rule no longer takes match/);
    await s.round();
    // The planner read it marked legacy, with what to convert.
    const prompt = String(s.prompts[0]);
    assert.match(
      prompt,
      /\\"kind\\":\\"try\\",\\"legacy\\":true,\\"match\\":\\"anything with vector loads\\"/,
    );
    assert.ok(
      prompt.includes(
        `\\"to_convert\\":[{\\"kind\\":\\"try\\",\\"rationale\\":\\"old\\",\\"rule\\":${old},\\"words\\":\\"anything with vector loads\\"}]`,
      ),
    );
    assert.match(
      prompt,
      /A directive marked legacy is an old rule[\s\S]*?to_convert lists them\. Convert/,
    );
    // The first answer left it as it was: refused, with what to do. The retry converted it.
    const epoch = body(events(s.env, "epoch_started")[0]);
    assert.equal(epoch.source, "planner");
    assert.ok(
      JSON.stringify(epoch.refused).includes(
        `rule ${old} is an old rule in words (\\"anything with vector loads\\"): convert it, in convert`,
      ),
    );
    // The new rule: the old one's author, kind, why and citations, on the direction, with the
    // words it replaced. The old rule ends as converted, by the planner.
    const active = s.env.service.ledger.directives.active(RUN);
    assert.equal(active.length, 1);
    const to = active[0]?.id;
    assert.deepEqual(active[0], {
      id: to,
      author: "control:owner:ui",
      body: {
        kind: "try",
        family: "vector-loads",
        rationale: "old",
        citations: ["a-1"],
        converted_from: { rule: old, words: "anything with vector loads" },
      },
    });
    assert.deepEqual(
      events(s.env, "directive_converted").map((e) => [e.actor, body(e)]),
      [
        [
          "planner",
          {
            id: old,
            to,
            kind: "try",
            family: "vector-loads",
            words: "anything with vector loads",
          },
        ],
      ],
    );
    // The direction it designed for the old rule, in its words: the run's now.
    const made = events(s.env, "family_added").find((e) => body(e).family === "vector-loads");
    assert.deepEqual(body(made), {
      family: "vector-loads",
      description: "wider loads, such as half2 or float4",
      for_rules: [old],
    });
    assert.ok(s.q.directions(RUN).includes("vector-loads"));
    // The round's record names the rule in force now; its live line says what converted.
    assert.deepEqual(epoch.directives, [to]);
    assert.ok(
      s.env.service.live
        .since(0, 1000)
        .entries.some((l) =>
          l.text.includes(`old rules in words converted: rule ${old} to :vector-loads:`),
        ),
    );
    assert.deepEqual(s.given(), ["lane-1:tile it", "lane-2:load float4"]);
  });

  test("no rule in words leaves force without a rule on a direction in its place", async (t) => {
    // The ledger's invariant: every old rule in words no longer in force was converted (a rule in
    // force names it) or removed by the owner. It fails on one that left force any other way.
    const unreplaced = (env: Env) => {
      const rows = (
        env.service.ledger.db.prepare("select id, status, body from directive").all() as {
          id: number;
          status: string;
          body: string;
        }[]
      ).map((r) => ({ ...r, b: JSON.parse(r.body) as Record<string, unknown> }));
      const byOwner = new Set(
        events(env, "directive_dropped")
          .filter((e) => e.actor.startsWith("control:owner"))
          .map((e) => Number(body(e).id)),
      );
      const replaced = (id: number) =>
        rows.some(
          (n) =>
            n.status === "active" &&
            (n.b.converted_from as { rule?: number } | undefined)?.rule === id,
        );
      return rows
        .filter((r) => typeof r.b.match === "string" && !r.b.family && r.status !== "active")
        .filter((r) => !byOwner.has(r.id) && !replaced(r.id))
        .map((r) => r.id);
    };
    let x = "";
    let ids: number[] = [];
    // The model converts both, one to a direction it designs; the teachers' next set
    // replaces only its own rules.
    const s = await setup(t, {
      planner: () => ({
        new_families: [{ id: "timer code", description: "any change to the timing code" }],
        convert: [
          { rule: ids[0], family: "timer code" },
          { rule: ids[1], family: "tiling" },
        ],
        assignments: [
          { lane: "lane-1", experiment: x, why: "w" },
          { lane: "lane-2", title: "tile more", family: "tiling", why: "w" },
        ],
      }),
    });
    x = await s.add("tile it", { family: "tiling" });
    ids = s.env.service.ledger.directives.addSet(
      RUN,
      "control:owner:ui",
      [
        { kind: "avoid", match: "anything with the timer", rationale: "a", citations: [] },
        { kind: "mandate", match: "loop tiling", rationale: "b", citations: [] },
      ],
      false,
    );
    s.env.service.addDirectives(
      RUN,
      [{ kind: "note", value: "a note", rationale: "r", citations: ["a-1"] }],
      "supervisor",
    );
    // A third, removed by the owner: it may leave force with nothing in its place.
    const [removed] = s.env.service.ledger.directives.addSet(
      RUN,
      "control:owner:ui",
      [{ kind: "try", match: "anything cheap", rationale: "c", citations: [] }],
      false,
    );
    await command(s.env, "drop_directive", { run: RUN, id: removed });
    await s.round();
    assert.equal(events(s.env, "directive_converted").length, 2);
    assert.deepEqual(
      s.env.service.ledger.directives
        .active(RUN)
        .map((d) => (d.body as { family?: string }).family),
      [undefined, "timer-code", "tiling"],
    );
    assert.deepEqual(unreplaced(s.env), []);
    // The check fails on an old rule in words that left force with nothing in its place.
    const [lost] = s.env.service.ledger.directives.addSet(
      RUN,
      "control:owner:ui",
      [{ kind: "try", match: "anything quick", rationale: "d", citations: [] }],
      false,
    );
    s.env.service.ledger.db
      .prepare("update directive set status = 'superseded' where id = ?")
      .run(Number(lost));
    assert.deepEqual(unreplaced(s.env), [lost]);
  });

  test("without the planner's model, an old rule in words stays in force, marked, until a round can convert it", async (t) => {
    // The planner off: the fixed rules plan, and the rule waits.
    const off = await setup(t);
    await off.add("first");
    const [kept] = off.env.service.ledger.directives.addSet(
      RUN,
      "control:owner:ui",
      [{ kind: "avoid", match: "anything slow", rationale: "old", citations: [] }],
      false,
    );
    await off.round();
    assert.equal(body(events(off.env, "epoch_started")[0]).source, "fallback");
    assert.deepEqual(
      off.env.service.ledger.directives.active(RUN).map((d) => d.id),
      [kept],
    );
    assert.equal(events(off.env, "directive_converted").length, 0);
    // A model whose answers leave it as it is, on both tries: the round falls back, and the
    // rule still waits.
    const stubborn = await setup(t, {
      planner: () => ({
        assignments: [
          { lane: "lane-1", title: "a", family: "misc", why: "w" },
          { lane: "lane-2", title: "b", family: "misc", why: "w" },
        ],
      }),
    });
    await stubborn.add("first");
    const [waits] = stubborn.env.service.ledger.directives.addSet(
      RUN,
      "control:owner:ui",
      [{ kind: "avoid", match: "anything slow", rationale: "old", citations: [] }],
      false,
    );
    await stubborn.round();
    const epoch = body(events(stubborn.env, "epoch_started")[0]);
    assert.equal(epoch.source, "fallback");
    assert.match(JSON.stringify(epoch.refused), /try 2: refused: rule \d+ is an old rule in words/);
    assert.deepEqual(
      stubborn.env.service.ledger.directives.active(RUN).map((d) => d.id),
      [waits],
    );
    assert.equal(events(stubborn.env, "directive_converted").length, 0);
  });
});
