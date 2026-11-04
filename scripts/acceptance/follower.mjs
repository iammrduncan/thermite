#!/usr/bin/env node
// @ts-check
// Follower acceptance (goal 205): a rig over two machines on one computer. Control and the rig
// local-1, whose harness leads, and follower-1 (compose.follower.yaml), a harness started as a
// follower and its supervisor, with volumes and networks of their own. The follower's supervisor
// registers its own key on the message bus and answers the leader's asks there, through control's
// server, with the user control gives it; the leader judges only on the follower's CPU. The check
// runs the smoke campaign's first candidate and checks that every judge job was held by the
// follower's executor, that the builds are on the follower and not on the leader, and that the
// verdict reached control. Usage: COMPOSE="podman compose" node scripts/acceptance/follower.mjs.
import { mkdirSync } from "node:fs";
import {
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

const composeEnv = {
  THERMITE_POLL_SECONDS: "3",
  THERMITE_CALIBRATION_BLOCKS: "0",
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

const env = prepare();
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
    /"judge_cards":1/.test(leader) && /"followers":\["follower-1=1"\]/.test(leader),
    leader.split("\n").find((l) => l.includes("judge ready")),
  );

  await assign(env, "smoke-1");
  console.log("assign_campaign delivered and accepted");
  const a = submit(
    composeEnv,
    "smoke-1",
    candidatePatch(env, "kits/smoke-cpu/candidates/good"),
    "a candidate that is faster",
  );
  console.log("submitted", a.attempt, a.lifecycle);
  const verdict = await until(
    "verdict at control",
    async () => latestVerdicts(await events())[a.attempt],
    900_000,
    3000,
  ).catch(async (err) => {
    const evs = await events().catch(() => []);
    for (const e of evs.slice(-25))
      console.log("event:", e.at, e.kind, JSON.stringify(e.body ?? {}).slice(0, 300));
    for (const s of ["harness", "harness-f", "supervisor", "supervisor-f"])
      console.log(`--- ${s}\n${dcLogs(composeEnv, s).split("\n").slice(-40).join("\n")}`);
    throw err;
  });
  console.log("verdict:", verdict);

  // Every judge job was held by the follower's executor.
  const evs = await events();
  const holders = [...new Set(evs.filter((e) => e.kind === "job_leased").map((e) => e.actor))];
  check(
    "every judge job was held by the follower's executor",
    holders.length > 0 && holders.every((h) => h === "executor-follower-1-0"),
    holders,
  );
  // The builds are on the follower, and none on the leader; the leader keeps their records.
  const builds = (/** @type {string} */ service) =>
    stack(
      "exec",
      "-T",
      service,
      "sh",
      "-c",
      "ls /var/lib/thermite/builds 2>/dev/null | wc -l",
    ).trim();
  check("the follower built the arms", Number(builds("harness-f")) >= 2, builds("harness-f"));
  check("the leader built none", Number(builds("harness")) === 0, builds("harness"));
  check(
    "the leader keeps the builds' records",
    evs.some((e) => e.kind === "build_recorded"),
  );
  console.log("follower acceptance: OK");
} finally {
  if (process.env.KEEP !== "1") stack("down", "-v");
}
