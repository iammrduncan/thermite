#!/usr/bin/env node
// @ts-check
// Follower acceptance (goal 205): a rig over two machines on one computer. Control and the rig
// local-1, whose harness leads, and follower-1 (compose.follower.yaml), a harness started as a
// follower and its supervisor, with volumes and networks of their own. The follower's supervisor
// registers its own key on the message bus and answers the leader's asks there, through control's
// server, with the user control gives it. The leader neither judges nor works: the follower's CPU
// is the judge's and the workers' (THERMITE_FOLLOWERS=follower-1=1+1). A scripted model on the
// host plans one lane, whose trial runs on the follower (step 2): its Pi worker writes a faster
// kernel there, builds it, makes a dev run and submits, its calls for the run's records reaching
// the leader. The check wants that trial's submission judged, every judge job held by the
// follower's executor, the builds and the workspace on the follower and none on the leader, and
// the verdict at control. Usage: COMPOSE="podman compose" node scripts/acceptance/follower.mjs.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostName, scriptedModel } from "./lib/scripted-model.mjs";
import {
  assign,
  control,
  dc,
  dcLogs,
  events,
  latestVerdicts,
  prepare,
  until,
} from "./lib/smoke-env.mjs";

const GOOD = readFileSync("kits/smoke-cpu/candidates/good/src/kernel/matmul.c", "utf8");
/** What the worker's tools answered, as the model was sent them. */
const seen = { devRun: false, built: false };

/**
 * The scripted model: the planner gives lane-1 one experiment; lane-1's worker writes the faster
 * kernel, builds it, makes a dev run and submits.
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
      name: "run",
      args: {
        command: "cc -O2 -std=c11 -Iinclude -c src/kernel/matmul.c -o k.o && echo BUILT-HERE",
      },
    },
    { name: "dev_run", args: { command: "cc --version | head -1" } },
    { name: "submit", args: { hypothesis: "i-k-j loop order, from a lane on the follower" } },
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
      if (text.includes("diagnostic only")) seen.devRun = true;
      if (text.includes("BUILT-HERE")) seen.built = true;
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
const files = ["-f", "compose.yaml", "-f", "compose.follower.yaml"];
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

const env = prepare();
// One lane, one trial.
const contract = JSON.parse(readFileSync(env.contractFile, "utf8"));
contract.lanes = { count: 1, trials_per_epoch: 1 };
writeFileSync(env.contractFile, JSON.stringify(contract));
mkdirSync(".dev/inbox-f", { recursive: true });
console.log("compose: build and start control, local-1 leading, and follower-1");
stack("up", "-d", "--build");
try {
  await until("control health", async () => (await fetch(`${control}/v1/health`)).ok);
  // The follower's supervisor registered its key with control, signed in with it, and serves the
  // leader's asks on its own subject.
  await until(
    "the follower answers its leader's asks on the bus",
    async () =>
      dcLogs(composeEnv, "supervisor-f").includes(
        "the follower answers its leader's asks on the message bus",
      ) || undefined,
    300_000,
    3000,
  );
  check("the follower's supervisor is on the bus with its own key", true);
  const leader = dcLogs(composeEnv, "harness");
  check(
    "the leader's judge has the follower's executor and none of its own",
    /"judge_cards":1/.test(leader) && /"followers":\["follower-1=1\+1"\]/.test(leader),
    leader.split("\n").find((l) => l.includes("judge ready")),
  );
  check(
    "the leader puts its lanes on the follower",
    /lanes over the rig's machines.*"places":\["follower-1"\]/.test(leader),
    leader.split("\n").find((l) => l.includes("lanes over")),
  );

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
    const all = await events().catch(() => []);
    for (const e of all.slice(-30))
      console.log("event:", e.at, e.kind, JSON.stringify(e.body ?? {}).slice(0, 300));
    for (const s of ["harness", "harness-f", "supervisor", "supervisor-f"])
      console.log(`--- ${s}\n${dcLogs(composeEnv, s).split("\n").slice(-40).join("\n")}`);
    throw err;
  });
  const trial = evs.find((e) => e.kind === "trial_finished" && e.body.lane === "lane-1");
  check("lane-1's trial submitted", trial?.body.stopped === "submitted", trial?.body);
  console.log("verdict:", latestVerdicts(evs)[trial?.body.attempt]);
  const follower = dcLogs(composeEnv, "harness-f");
  check(
    "the trial ran on the follower",
    follower.includes("a trial of the leader's runs here") &&
      follower.includes(String(trial?.body.trial ?? "?")),
    follower.split("\n").filter((l) => l.includes("runs here")),
  );
  check("its build ran in its workspace there", seen.built);
  check("its dev run ran there", seen.devRun);

  // Every judge job was held by the follower's executor.
  const holders = [...new Set(evs.filter((e) => e.kind === "job_leased").map((e) => e.actor))];
  check(
    "every judge job was held by the follower's executor",
    holders.length > 0 && holders.every((h) => h === "executor-follower-1-0"),
    holders,
  );
  // The builds and the lane's workspace are the follower's; the leader keeps the records.
  const builds = (/** @type {string} */ service) =>
    sh(service, "ls /var/lib/thermite/builds 2>/dev/null | wc -l");
  check("the follower built the arms", Number(builds("harness-f")) >= 2, builds("harness-f"));
  check("the leader built none", Number(builds("harness")) === 0, builds("harness"));
  check(
    "the leader keeps the builds' records",
    evs.some((e) => e.kind === "build_recorded"),
  );
  const lanes = (/** @type {string} */ service) =>
    sh(service, "ls /scratch/lanes/lane-1 2>/dev/null | grep -v '^cache$' | wc -l");
  check(
    "the leader made no workspace, and the follower's went with its trial",
    Number(lanes("harness")) === 0 &&
      Number(lanes("harness-f")) === 0 &&
      sh("harness-f", "test -d /scratch/lanes/lane-1/cache && echo yes") === "yes",
    { leader: lanes("harness"), follower: lanes("harness-f") },
  );
  console.log("follower acceptance: OK");
} finally {
  if (process.env.KEEP !== "1") stack("down", "-v");
  model.close();
}
