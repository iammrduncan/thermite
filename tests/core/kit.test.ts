import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseContract } from "../../src/core/contract.ts";
import { cellParams, cellTimeoutS, KitSchema, kitProblems } from "../../src/core/kit.ts";
import { expandArgv } from "../../src/harness/judge/kits.ts";
import { makeJudgeEnv } from "../helpers/judge-env.ts";

const base = {
  schema_version: 1,
  name: "k",
  target: "cpu",
  build: { command: ["make"], outputs: ["out"] },
  cells: { small: { work: 1 } },
  run: { command: ["{build:out/bench}", "{out}"] },
  metrics: { ops: { unit: "op/s", work: "work" } },
  check: { command: ["python3", "{kit:check.py}", "{out}"] },
};
const withRun = (run: Record<string, unknown>) => ({ ...base, run: { ...base.run, ...run } });

describe("kit commands", () => {
  test("placeholders expand, a model is named by its sha256, and unknown ones are refused", () => {
    const sha = "a".repeat(64);
    assert.deepEqual(
      expandArgv(["{build:out/run}", "--model", `{models:${sha}}`, "{params}", "{out}"], {
        build: "/b",
        models: "/state/models",
        params: "/r/params.txt",
        out: "/r/out",
      }),
      ["/b/out/run", "--model", `/state/models/${sha}`, "/r/params.txt", "/r/out"],
    );
    assert.throws(() => expandArgv(["{model:x}"], { models: "/m" }), /unknown placeholder/);
  });

  test("a run reaches only the kit paths in run.copy", () => {
    const ok = KitSchema.parse(
      withRun({ copy: ["run", "data/x.txt"], command: ["python3", "{kit:run/cell.py}", "{kit}"] }),
    );
    assert.deepEqual(ok.run.copy, ["run", "data/x.txt"]);
    assert.deepEqual(KitSchema.parse(base).run.copy, []);
    for (const [copy, arg] of [
      [[], "{kit:run/cell.py}"],
      [[], "{kit}"],
      [["run"], "{kit:check.py}"],
      [["run"], "{kit:run/../refs/a1.json}"],
      [["run"], "{kit:runner/x}"],
    ] as const) {
      assert.throws(
        () => KitSchema.parse(withRun({ copy, command: ["python3", arg] })),
        /not in run\.copy/,
        `${JSON.stringify(copy)} ${arg}`,
      );
    }
  });

  test("a kit's driver writes the outputs, reaches only the kit paths in run.copy, and never the build", () => {
    const driven = withRun({
      copy: ["run"],
      command: ["{build:out/bench}", "{params}"],
      driver: ["python3", "{kit:run/drive.py}", "{params_json}", "{out}"],
    });
    assert.deepEqual(KitSchema.parse(driven).run.driver?.[1], "{kit:run/drive.py}");
    assert.equal(KitSchema.parse(base).run.driver, undefined, "a run alone needs no driver");
    const refused = (run: Record<string, unknown>, message: RegExp) =>
      assert.throws(() => KitSchema.parse({ ...driven, run: { ...driven.run, ...run } }), message);
    refused({ driver: ["{kit:check.py}"] }, /not in run\.copy/);
    refused(
      { driver: ["{kit:run/drive.py}", "{build:out/bench}"] },
      /\{build\} is not for the driver/,
    );
    refused({ command: ["{build:out/bench}", "{out}"] }, /the driver writes \{out\}/);
  });

  test("a cell may set its own time limit; a cell of parameters alone keeps the kit's", () => {
    const kit = KitSchema.parse({
      ...base,
      cells: {
        small: { work: 1, n: 64 },
        diag: { params: { work: 1, n: 8192, mode: "full" }, timeout_s: 1800 },
        plain: { params: { work: 2 } },
        // A parameter that happens to be called params is still a parameter.
        named: { params: "fast", work: 3 },
      },
      run: { ...base.run, timeout_s: 120 },
    });
    assert.deepEqual(cellParams(kit, "small"), { work: 1, n: 64 });
    assert.deepEqual(cellParams(kit, "diag"), { work: 1, n: 8192, mode: "full" });
    assert.deepEqual(cellParams(kit, "plain"), { work: 2 });
    assert.deepEqual(cellParams(kit, "named"), { params: "fast", work: 3 });
    assert.equal(cellParams(kit, "nope"), undefined);
    assert.equal(cellParams(kit, "constructor"), undefined);
    assert.equal(cellTimeoutS(kit, "diag"), 1800);
    assert.equal(cellTimeoutS(kit, "small"), 120);
    assert.equal(cellTimeoutS(kit, "plain"), 120);
    assert.equal(cellTimeoutS(kit, "named"), 120);
    // The kit's default when run.timeout_s is left out.
    assert.equal(cellTimeoutS(KitSchema.parse(base), "small"), 300);
    // An old kit parses exactly as it is written.
    assert.deepEqual(KitSchema.parse(base).cells, base.cells);
    for (const [cell, message] of [
      [{ params: { n: 1 }, timeout_s: 0 }, /too small|>0/i],
      [{ params: { n: 1 }, timeout_s: 1.5 }, /int/i],
      [{ params: { n: 1 }, timeout: 30 }, /unrecognized key/i],
      [{ params: { n: { deep: 1 } } }, /invalid/i],
    ] as const) {
      const r = KitSchema.safeParse({ ...base, cells: { bad: cell } });
      assert.equal(r.success, false, JSON.stringify(cell));
      assert.match(JSON.stringify(r.error?.issues), message, JSON.stringify(cell));
      assert.ok(
        r.error?.issues.some((i) => i.path[0] === "cells" && i.path[1] === "bad"),
        JSON.stringify(r.error?.issues),
      );
    }
  });

  test("every time limit is at most a day, the longest the broker runs anything", () => {
    const day = 86_400;
    const at = (limit: number) => ({
      ...base,
      build: { ...base.build, timeout_s: limit },
      cells: { ...base.cells, slow: { params: { work: 1 }, timeout_s: limit } },
      run: { ...base.run, timeout_s: limit },
      check: { ...base.check, timeout_s: limit },
    });
    const kit = KitSchema.parse(at(day));
    assert.equal(cellTimeoutS(kit, "slow"), day);
    assert.equal(kit.build.timeout_s, day);
    const r = KitSchema.safeParse(at(day + 1));
    assert.equal(r.success, false);
    const said = JSON.stringify(r.error?.issues);
    for (const where of [
      ["build", "timeout_s"],
      ["run", "timeout_s"],
      ["check", "timeout_s"],
    ])
      assert.ok(
        r.error?.issues.some(
          (i) =>
            i.path.join(".") === where.join(".") && /at most 86400 s \(24 hours\)/.test(i.message),
        ),
        `${where.join(".")}: ${said}`,
      );
    // The cell's own limit: its union's issue holds the same words.
    assert.ok(
      r.error?.issues.some((i) => i.path[0] === "cells" && i.path[1] === "slow"),
      said,
    );
    // Four limits over a day, four times the words.
    assert.equal(said.split("at most 86400 s (24 hours)").length - 1, 4, said);
  });

  test("copied kit paths stay inside the kit", () => {
    for (const bad of [".", "../x", "/etc", "run/../../x", "./run", "run/"]) {
      assert.throws(() => KitSchema.parse(withRun({ copy: [bad] })), /inside the kit/, bad);
      assert.throws(
        () => KitSchema.parse({ ...base, build: { ...base.build, copy: [bad] } }),
        /inside the kit/,
        bad,
      );
    }
  });

  test("verifier gates name other verifiers and never form a cycle", () => {
    const withVerifiers = (verifiers: unknown) => ({ ...base, verifiers });
    const ok = KitSchema.parse(
      withVerifiers({
        load: { cells: ["small"], priority: 1 },
        ppl: { cells: ["small"], requires: ["load"] },
      }),
    );
    assert.equal(ok.verifiers.ppl?.priority, 100);
    assert.deepEqual(ok.verifiers.load?.requires, []);
    assert.throws(
      () => KitSchema.parse(withVerifiers({ a: { cells: ["small"], requires: ["nope"] } })),
      /not another verifier/,
    );
    assert.throws(
      () => KitSchema.parse(withVerifiers({ a: { cells: ["small"], requires: ["a"] } })),
      /not another verifier/,
    );
    assert.throws(
      () =>
        KitSchema.parse(
          withVerifiers({
            a: { cells: ["small"], requires: ["b"] },
            b: { cells: ["small"], requires: ["a"] },
          }),
        ),
      /cycle/,
    );
  });

  test("a contract is checked against its kit: target, cells, metrics and verifiers", () => {
    const kit = KitSchema.parse({ ...base, verifiers: { builds: { cells: ["small"] } } });
    const contract = (fields: Record<string, unknown>) => {
      const r = parseContract({
        schema_version: 1,
        campaign: "c",
        version: 1,
        title: "t",
        project: { repo: "p", kit: { repo: "k", commit: "a".repeat(40) } },
        target: { type: "cpu", class: "test" },
        editable_paths: ["src/**"],
        ...fields,
      });
      if (!r.ok) throw new Error(r.errors.join("; "));
      return r.contract;
    };
    const hill = contract({
      mode: "hill_climb",
      objective: { primary: { metric: "ops", direction: "max", min_effect: 0.05 } },
      cells: ["small"],
    });
    assert.deepEqual(kitProblems(hill, kit, "cpu"), []);
    assert.match(kitProblems(hill, kit, "cuda-gpu").join(), /measures on cpu.*target is cuda-gpu/);
    const wrong = contract({
      mode: "hill_climb",
      objective: { primary: { metric: "flops", direction: "max", min_effect: 0.05 } },
      cells: ["small", "large"],
      held_out_cells: ["held"],
    });
    assert.deepEqual(kitProblems(wrong, kit), [
      "cells names cell large, which the kit does not have",
      "held_out_cells names cell held, which the kit does not have",
      "the objective names metric flops, which the kit does not have",
    ]);
    const goal = contract({
      mode: "goal",
      deliverable: "d",
      goals: [
        { id: "builds", description: "b", verify: { type: "code", verifier: "builds" } },
        { id: "loads", description: "l", verify: { type: "code", verifier: "loads" } },
        {
          id: "fast",
          description: "f",
          verify: { type: "metric_threshold", metric: "ops", op: ">=", value: 1, cells: ["big"] },
        },
      ],
      held_out_cells: ["small", "held"],
    });
    assert.deepEqual(kitProblems(goal, kit), [
      "held_out_cells names cell held, which the kit does not have",
      "goal loads names verifier loads, which the kit does not have",
      "goal fast names cell big, which the kit does not have",
    ]);

    // A rate divides each run's `work` parameter by its time: every cell the contract runs needs
    // it, a number above zero, or every run of that cell would fail as an infrastructure error.
    const rated = KitSchema.parse({
      ...base,
      cells: {
        small: { work: 1 },
        none: { n: 2 },
        zero: { params: { work: 0 }, timeout_s: 60 },
        text: { work: "lots" },
        gate: { n: 3 },
        unused: { n: 4 },
      },
      verifiers: {
        first: { cells: ["gate"] },
        second: { cells: ["small"], requires: ["first"] },
      },
    });
    const need = (c: string) =>
      `cell ${c} has no parameter work above zero, which rate metric ops divides by the run's time`;
    assert.deepEqual(
      kitProblems(
        contract({
          mode: "hill_climb",
          objective: { primary: { metric: "ops", direction: "max", min_effect: 0.05 } },
          cells: ["small", "none"],
          held_out_cells: ["zero"],
        }),
        rated,
      ),
      [need("none"), need("zero")],
    );
    assert.deepEqual(
      kitProblems(
        contract({
          mode: "goal",
          deliverable: "d",
          goals: [
            { id: "v", description: "v", verify: { type: "code", verifier: "second" } },
            {
              id: "t",
              description: "t",
              verify: {
                type: "metric_threshold",
                metric: "ops",
                op: ">=",
                value: 1,
                cells: ["text"],
              },
            },
          ],
          held_out_cells: ["small"],
        }),
        rated,
      ),
      // The verifier's gate runs too; a cell no part of the contract runs is not checked.
      [need("gate"), need("text")],
    );
    // A kit with no rate needs no such parameter.
    assert.deepEqual(
      kitProblems(
        contract({
          mode: "hill_climb",
          objective: { primary: { metric: "secs", direction: "min", min_effect: 0.05 } },
          cells: ["none"],
        }),
        KitSchema.parse({ ...rated, metrics: { secs: { from: "time" } } }),
      ),
      [],
    );
  });

  test("an assignment whose kit does not fit its contract is refused, with the reason, before any run", async () => {
    const env = makeJudgeEnv({ contract: { cells: ["small", "huge"] } });
    const out = (await env.service.applyCommand(env.assign)) as {
      accepted?: boolean;
      result?: unknown;
    };
    assert.equal(out.accepted, false);
    assert.match(
      JSON.stringify(out.result),
      /the kit does not fit the contract: cells names cell huge/,
    );
    assert.equal(env.ledger.runs.get("js-1"), undefined);
  });

  test("a run assigned with its own promotion policy keeps it; one without follows the rig's", async () => {
    const env = makeJudgeEnv({ promotion: "auto" });
    const base = (env.assign as unknown as { envelope: { payload: Record<string, unknown> } })
      .envelope.payload;
    const out = (await env.service.applyCommand(
      env.sign("assign_campaign", { ...base, promotion: "owner_approval" }),
    )) as { accepted?: boolean; result?: unknown };
    assert.equal(out.accepted, true, JSON.stringify(out.result));
    assert.equal(env.ledger.runs.get("js-1")?.promotion, "owner_approval");
    assert.equal(env.service.promotionFor("js-1"), "owner_approval");
    const created = env.ledger.eventsAfter(0, 1000).events.find((e) => e.kind === "run_created");
    assert.equal(
      (created?.body as { promotion?: string } | undefined)?.promotion,
      "owner_approval",
    );
    await env.service.applyCommand(env.sign("assign_campaign", { ...base, run: "js-2" }));
    assert.equal(env.ledger.runs.get("js-2")?.promotion, null);
    assert.equal(env.service.promotionFor("js-2"), "auto");
  });
});
