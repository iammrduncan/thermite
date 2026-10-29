import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { describe, test } from "node:test";
import { runPiTrial } from "../../../src/harness/agents/programs.ts";
import { Scheduler } from "../../../src/harness/agents/scheduler/index.ts";
import { runTrial, type TrialSpec } from "../../../src/harness/agents/worker/index.ts";
import { LocalRunner } from "../../../src/harness/broker/runner.ts";
import type { Ledger } from "../../../src/harness/ledger/index.ts";
import { keepPrompt } from "../../../src/harness/prompts.ts";
import { startFakeModel } from "../../helpers/fake-model.ts";
import { makeJudgeEnv } from "../../helpers/judge-env.ts";
import { adviseRound, golden, kept, laneTool, PLAN, recorder, teachersScript } from "./capture.ts";

/**
 * The owner's additions to a campaign's roles (goal 166, decision 1), in the prompts sent: each
 * role's addition, from the run's contract, is a section of its own after the role's text,
 * labelled as the owner's, with the contract's version, and the prompt record shows it as the
 * owner's addition. Golden files of the roles with an addition sit beside the ones without, which
 * do not change.
 */

const ADDITIONS = {
  worker: "Keep every change small enough to read in one sitting.",
  planner: "Give each lane a different direction while the queue allows it.",
  teacher: "Name the file and the line each idea is about.",
  "merged-by": "Keep both teachers' ideas when they differ.",
};

/** The `agent_prompt` events of one role in a ledger, newest last. */
function promptEvents(ledger: Ledger, role: string) {
  return ledger.db
    .prepare("select body from event where kind = 'agent_prompt' order by id")
    .all()
    .map(
      (e) =>
        JSON.parse(String((e as { body: string }).body)) as {
          role: string;
          sections: { id: string; source: string; part: string; text?: string }[];
        },
    )
    .filter((b) => b.role === role);
}

/** The section the owner's addition is, in a kept prompt's event: after the role's own. */
function additionIn(ledger: Ledger, role: string, text: string, part: string) {
  const event = promptEvents(ledger, role)[0];
  assert.ok(event, `${role}: no agent_prompt event`);
  const i = event.sections.findIndex((s) => s.id === "owner-addition");
  assert.ok(i > 0, `${role}: no owner's addition in ${JSON.stringify(event.sections)}`);
  const s = event.sections[i];
  assert.equal(s?.source, "owner's addition");
  assert.equal(s?.part, part);
  assert.ok(s?.text?.endsWith(text), `${role}: the addition's text is in the event`);
  assert.match(String(s?.text), /^# The campaign owner's addition \(contract version 1\)\n/);
  // The role's own text comes first.
  assert.equal(event.sections[0]?.source, "role");
}

describe("the owner's additions in the prompts sent (goal 166)", () => {
  test("a hill-climb run whose contract adds to the worker and the planner, in Pi", async () => {
    const env = makeJudgeEnv({
      lanes: { count: 1, trials_per_epoch: 1 },
      contract: {
        notes: "The kernel sums an array of numbers. Keep its exported function's name.",
        role_additions: { worker: ADDITIONS.worker, planner: ADDITIONS.planner },
      },
    });
    await env.start();
    const { sent, script } = recorder(({ tools }) =>
      tools.some((t) => t.function.name === "submit_plan") ? PLAN : { text: "done" },
    );
    const fake = await startFakeModel(script);
    const runner = new LocalRunner(env.paths.scratchDir);
    const model = {
      baseUrl: fake.url,
      model: "m",
      apiKey: "k",
      contextWindow: 32000,
      maxTokens: 2000,
    };
    const scheduler = new Scheduler({
      service: env.service,
      runner,
      model,
      owner: "prompts-test",
      runTrial: (spec) =>
        runPiTrial(
          { mode: "code", spec },
          {
            handOver: () => () => undefined,
            sent: (p) =>
              keepPrompt(env.service.ledger, spec.run, p, { lane: spec.lane, trial: spec.trialId }),
            runner,
            scratchDir: env.paths.scratchDir,
            port: 0,
            signal: undefined,
            model: undefined,
          },
          async (trial) =>
            runTrial(trial.spec as TrialSpec, {
              runner,
              laneTool,
              model,
              submit: (req) => env.service.submitForTrial(String(spec.token), req) as never,
              status: async (id) => env.service.attemptStatus(id),
              devRun: async () => ({}),
              idea: async () => ({ experiment: "x-000000000000" }),
              note: async () => ({ note: 1 }),
              research: async () => ({}),
            }),
        ),
    });
    await scheduler.tick();
    await scheduler.idle();
    await scheduler.shutdown("test over");
    await fake.close();
    const paths = [env.paths.scratchDir, env.paths.stateDir, env.root, tmpdir()];
    golden("worker.pi.addition", sent.get("worker"), paths);
    golden("planner.pi.addition", sent.get("planner"), paths);
    // What each model was sent is the prompt kept, and its record shows the owner's addition.
    kept(env.service.ledger, "worker", sent.get("worker"));
    kept(env.service.ledger, "planner", sent.get("planner"));
    additionIn(env.service.ledger, "worker", ADDITIONS.worker, "system");
    additionIn(env.service.ledger, "planner", ADDITIONS.planner, "system");
    // In Pi it ends the system text; the first message has none of it.
    assert.ok(sent.get("worker")?.system.endsWith(ADDITIONS.worker));
    assert.ok(!sent.get("worker")?.first.includes(ADDITIONS.worker));
  });

  test("a hill-climb run's teachers and their merged by model, each with its own addition", async () => {
    const env = makeJudgeEnv({
      contract: {
        notes: "The kernel sums an array of numbers. Keep its exported function's name.",
        role_additions: { teacher: ADDITIONS.teacher, "merged-by": ADDITIONS["merged-by"] },
      },
    });
    await env.service.applyCommand(env.assign);
    const { sent, script } = recorder(teachersScript);
    const keys = await adviseRound(env, script, (runtime) => ({
      teachers: [runtime("teacher-a"), runtime("teacher-b")],
      merged_by: runtime("merged-by"),
    }));
    const paths = [env.paths.scratchDir, env.paths.stateDir, env.root, keys, tmpdir()];
    golden("teacher.pi.addition", sent.get("teacher"), paths);
    kept(env.service.ledger, "teacher", sent.get("teacher"));
    kept(env.service.ledger, "merged-by", sent.get("merged-by"));
    additionIn(env.service.ledger, "teacher", ADDITIONS.teacher, "system");
    additionIn(env.service.ledger, "merged-by", ADDITIONS["merged-by"], "system");
    // Each role gets its own: the merged by model is never sent the teachers'.
    assert.ok(!sent.get("merged-by")?.system.includes(ADDITIONS.teacher));
    assert.ok(!sent.get("teacher")?.system.includes(ADDITIONS["merged-by"]));
  });
});
