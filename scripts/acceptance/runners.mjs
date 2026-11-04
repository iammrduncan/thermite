#!/usr/bin/env node
// @ts-check
// Runners acceptance (goal 206): a rig's core and two runner processes on one computer. Control,
// the rig local-1, whose harness is its core and judges on its runners alone, and runner-1 and
// runner-2 (compose.runners.yaml), each a harness started as a runner and its supervisor, with
// volumes and networks of their own; each supervisor registers its own key on the message bus
// with the rig's token and answers the core's asks there. The check gives the rig its runners
// over REST: runner-1 the judge's, runner-2 lane-1's. A scripted model on the host plans one lane,
// whose worker writes a faster kernel, runs it on its runner with run_experiment and submits; the
// judge measures it on runner-1. Then, while the judge measures another change on runner-1, the
// rig's runners change: runner-1 leaves and runner-2 becomes shared. The job goes back to the
// queue with no verdict and ends on runner-2, with its verdict at control.
// Usage: COMPOSE="podman compose" node scripts/acceptance/runners.mjs.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostName, scriptedModel } from "./lib/scripted-model.mjs";
import {
  api,
  assign,
  candidatePatch,
  control,
  dc,
  dcLogs,
  events,
  latestVerdicts,
  prepare,
  submit,
  until,
} from "./lib/smoke-env.mjs";

const GOOD = readFileSync("kits/smoke-cpu/candidates/good/src/kernel/matmul.c", "utf8");
/** What the worker's tools answered, as the model was sent them. */
const seen = { onRunner: false };

/**
 * The scripted model: the planner gives lane-1 one experiment; lane-1's worker writes the faster
 * kernel, runs a command with it on its runner, and submits.
 * @param {any[]} messages
 * @param {any[]} tools
 * @returns {import("./lib/scripted-model.mjs").ScriptedTurn}
 */
function script(messages, tools) {
  if (!tools.length) return { text: "A Thermite trial" };
  if (tools.some((t) => t.function.name === "submit_plan"))
    return {
      toolCalls: [
        {
          name: "submit_plan",
          args: {
            new_directions: [{ id: "loop-order", description: "loop order for locality" }],
            assignments: [
              {
                lane: "lane-1",
                direction: "loop-order",
                focus: "make the inner loop contiguous",
                parent: "champion",
              },
            ],
          },
        },
      ],
    };
  const steps = [
    { name: "write_file", args: { path: "src/kernel/matmul.c", content: GOOD } },
    {
      name: "run_experiment",
      args: {
        command:
          "cc -O2 -std=c11 -Iinclude -c src/kernel/matmul.c -o k.o && grep -c 'i-k-j' src/kernel/matmul.c; echo BUILT-ON-RUNNER",
      },
    },
    {
      name: "submit_experiment",
      args: { hypothesis: "i-k-j loop order, tried on its runner" },
    },
  ];
  const done = messages.filter((m) => m.role === "tool").length;
  const step = steps[done];
  return step ? { toolCalls: [step] } : { text: "done" };
}

const model = await scriptedModel(script, {
  observe: (messages) => {
    for (const m of messages) {
      if (m.role !== "tool") continue;
      const text = JSON.stringify(m.content ?? "");
      if (text.includes("BUILT-ON-RUNNER") && text.includes("runner-2-0")) seen.onRunner = true;
    }
  },
});

const composeEnv = {
  THERMITE_POLL_SECONDS: "3",
  THERMITE_CALIBRATION_BLOCKS: "0",
  THERMITE_MODEL_BASE_URL: `http://${hostName()}:${model.port}/v1`,
  THERMITE_MODEL: "scripted",
  THERMITE_MAX_TRIALS: "1",
};
const files = ["-f", "compose.yaml", "-f", "compose.runners.yaml"];
/** @param {...string} args */
const stack = (...args) => dc(composeEnv, ...files, ...args);
/** @param {string} what @param {boolean} ok @param {unknown} [detail] */
const check = (what, ok, detail) => {
  console.log(
    `${ok ? "PASS" : "FAIL"} ${what}${ok || detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`,
  );
  if (!ok) throw new Error(`failed: ${what}`);
};
/** @param {string} service @param {string} command */
const sh = (service, command) => stack("exec", "-T", service, "sh", "-c", command).trim();
/** The rig's runners, as REST sends them. @param {{name: string, pools: string[]}[]} runners */
const giveRunners = async (runners) => {
  const r = await api("/v1/rigs/local-1/settings", {
    method: "POST",
    body: JSON.stringify({ runners }),
  });
  check(`the rig's runners set: ${JSON.stringify(runners)}`, r.status === 200, r.body);
};
/** @param {string} service @param {string} line */
const logged = (service, line) => dcLogs(composeEnv, service).includes(line);
const dump = async () => {
  const all = await events().catch(() => []);
  for (const e of all.slice(-30))
    console.log("event:", e.at, e.kind, e.actor, JSON.stringify(e.body ?? {}).slice(0, 300));
  for (const s of [
    "harness",
    "harness-r1",
    "harness-r2",
    "supervisor",
    "supervisor-r1",
    "supervisor-r2",
  ])
    console.log(`--- ${s}\n${dcLogs(composeEnv, s).split("\n").slice(-40).join("\n")}`);
};

const env = prepare();
// One lane, one trial.
const contract = JSON.parse(readFileSync(env.contractFile, "utf8"));
contract.lanes = { count: 1, trials_per_epoch: 1 };
writeFileSync(env.contractFile, JSON.stringify(contract));
for (const d of [".dev/inbox-r1", ".dev/inbox-r2"]) mkdirSync(d, { recursive: true });
console.log("compose: build and start control, local-1's core, runner-1 and runner-2");
stack("up", "-d", "--build");
try {
  await until("control health", async () => (await fetch(`${control}/v1/health`)).ok);
  for (const s of ["supervisor-r1", "supervisor-r2"])
    await until(
      `${s} answers its core's asks on the bus`,
      async () => logged(s, "the runner answers its core's asks on the message bus") || undefined,
      300_000,
      3000,
    );
  check("each runner's supervisor is on the bus with its own key", true);
  await until(
    "the core reports its settings",
    async () => (await api("/v1/rigs/local-1/settings")).body.settings ?? undefined,
    300_000,
    3000,
  );
  await giveRunners([
    { name: "runner-1", pools: ["judge"] },
    { name: "runner-2", pools: ["lane-1"] },
  ]);
  for (const r of ["runner-1", "runner-2"])
    await until(
      `the core gives ${r} runs once it answers`,
      async () =>
        dcLogs(composeEnv, "harness")
          .split("\n")
          .some((l) => l.includes("a runner process answers: it takes runs") && l.includes(r)) ||
        undefined,
      120_000,
      2000,
    );
  check("the core judges on its runners alone", logged("harness", '"judge_cards":0'));

  await assign(env, "smoke-1");
  console.log("assign_campaign delivered and accepted");
  const evs = await until(
    "lane-1's submission judged, with its verdict at control",
    async () => {
      const all = await events();
      const t = all.find((e) => e.kind === "trial_finished" && e.body.lane === "lane-1");
      return t?.body.attempt && latestVerdicts(all)[t.body.attempt] ? all : undefined;
    },
    1_200_000,
    3000,
  ).catch(async (err) => {
    await dump();
    throw err;
  });
  const trial = evs.find((e) => e.kind === "trial_finished" && e.body.lane === "lane-1");
  check("lane-1's trial submitted", trial?.body.stopped === "submitted", trial?.body);
  console.log("verdict:", latestVerdicts(evs)[trial?.body.attempt]);
  check("its run_experiment ran on its own runner, runner-2", seen.onRunner);
  check(
    "the run_experiment's record names its runner",
    evs.some((e) => e.kind === "dev_run" && e.body.runner === "runner-2-0"),
    evs.filter((e) => e.kind === "dev_run").map((e) => e.body),
  );
  const holders = [...new Set(evs.filter((e) => e.kind === "job_leased").map((e) => e.actor))];
  check(
    "every judge job was held by runner-1's executor",
    holders.length > 0 && holders.every((h) => h === "executor-runner-1-0"),
    holders,
  );
  const builds = (/** @type {string} */ service) =>
    sh(service, "ls /var/lib/thermite/builds 2>/dev/null | wc -l");
  check("runner-1 built the arms", Number(builds("harness-r1")) >= 2, builds("harness-r1"));
  check("the core built none", Number(builds("harness")) === 0, builds("harness"));
  const view = await api("/v1/rigs/local-1/view");
  const reported = view.body?.summary?.runners?.processes ?? [];
  check(
    "the core reports both runners to control, each answering",
    reported.length === 2 && reported.every((/** @type {any} */ p) => p.up === true),
    reported,
  );

  // Mid-run: runner-1 leaves while the judge measures a change there, and runner-2 is shared.
  const noop = submit(
    composeEnv,
    "smoke-1",
    candidatePatch(env, "kits/smoke-cpu/candidates/noop"),
    "rename the accumulator",
  );
  // A job's lease names the job; its queueing names the attempt.
  const job = await until(
    "the judge measures the change on runner-1",
    async () => {
      const all = await events();
      const queued = all.find((e) => e.kind === "job_queued" && e.body.attempt === noop.attempt);
      const id = queued ? String(queued.subject) : undefined;
      return all.some(
        (e) =>
          e.kind === "job_leased" && String(e.subject) === id && e.actor === "executor-runner-1-0",
      )
        ? id
        : undefined;
    },
    600_000,
    500,
  );
  await giveRunners([{ name: "runner-2", pools: ["shared"] }]);
  const after = await until(
    "the change's job went back to the queue and got its verdict on runner-2",
    async () => {
      const all = await events();
      return latestVerdicts(all)[noop.attempt] ? all : undefined;
    },
    900_000,
    3000,
  ).catch(async (err) => {
    await dump();
    throw err;
  });
  check(
    "runner-1's job went back to the queue once, with no verdict against the change",
    after.some((e) => e.kind === "crash_infra" && String(e.subject) === job) &&
      !after.some(
        (e) =>
          e.kind === "verdict" && e.subject === noop.attempt && e.body.verdict === "crash_infra",
      ),
    after.filter((e) => String(e.subject) === job).map((e) => [e.kind, e.actor]),
  );
  check(
    "it ended on runner-2",
    after.some(
      (e) =>
        e.kind === "job_leased" && String(e.subject) === job && e.actor === "executor-runner-2-0",
    ),
  );
  console.log("verdict:", latestVerdicts(after)[noop.attempt]);
  check(
    "the core no longer gives runner-1 runs",
    logged("harness", '"runner":"runner-1","why":"the runner runner-1 left the rig"'),
  );
  console.log("runners acceptance: OK");
} finally {
  if (process.env.KEEP !== "1") stack("down", "-v");
  model.close();
}
