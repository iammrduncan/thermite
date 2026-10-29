#!/usr/bin/env node
// Backup and restore acceptance (goal 173): the compose stack's own backup service, as the page
// "Back up and restore control" runs it. It starts control and one rig, gives the rig work so that
// the bus's EVENTS stream holds its events, backs control up while it runs, gives the rig more work,
// then restores the backup by the page's steps: control and the bus stopped, the bus's store set
// aside, the bus started alone with room for the restore, the restore, then the stack again.
// Control must start on the restored store with its start check holding, and the events the rig
// recorded after the backup must come back from the rig. A restore run again on the bus that ran
// on must be refused, and change nothing.
//
// Usage: COMPOSE="podman compose" node scripts/acceptance/backup.mjs (or "docker compose", or
// "podman-compose"). KEEP=1 leaves the stack up.
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  api,
  assign,
  candidatePatch,
  compose,
  control,
  dc,
  events,
  latestVerdicts,
  prepare,
  submit,
  until,
} from "./lib/smoke-env.mjs";

const composeEnv = { THERMITE_POLL_SECONDS: "3", THERMITE_CALIBRATION_BLOCKS: "0" };
const stack = (...args) => dc(composeEnv, ...args);
/** The backup service, as the page runs it. */
const backup = (...args) => stack("--profile", "backup", "run", "--rm", "backup", ...args);

/** The backup service's run that must fail: its exit code and what it wrote on standard error. */
function backupFails(...args) {
  try {
    execFileSync(
      compose[0],
      [...compose.slice(1), "--profile", "backup", "run", "--rm", "backup", ...args],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, ...composeEnv },
      },
    );
  } catch (err) {
    return { status: err.status, stderr: String(err.stderr ?? "") };
  }
  throw new Error(`thermite ${args.slice(1).join(" ")} did not fail`);
}

/** The EVENTS stream's messages and last place, from the server's monitoring. */
function eventsStream() {
  const url = "http://127.0.0.1:8222/jsz?streams=true";
  const jsz = JSON.parse(stack("exec", "-T", "nats", "wget", "-q", "-O", "-", url));
  const s = (jsz.account_details ?? [])
    .flatMap((a) => a.stream_detail ?? [])
    .find((x) => x.name === "EVENTS");
  return { messages: s?.state?.messages ?? 0, last: s?.state?.last_seq ?? 0 };
}

/** Control's health, once it serves, with its bus connected. */
const healthy = () =>
  until(
    "control serves, on its bus",
    async () => {
      const h = await (await fetch(`${control}/v1/health`)).json();
      return h.ok && h.bus === "connected" ? h : undefined;
    },
    300_000,
  );

/** A candidate submitted, and its verdict at control. */
async function judged(env, dir, why) {
  const a = submit(composeEnv, "smoke-1", candidatePatch(env, dir), why);
  return await until(
    `the verdict of ${a.attempt} at control`,
    async () => latestVerdicts(await events())[a.attempt] && a.attempt,
    300_000,
    2000,
  );
}

const env = prepare();
const made = [];
console.log("compose: build and start");
stack("up", "-d", "--build");
try {
  await healthy();
  await assign(env, "smoke-1");
  const first = await judged(env, "kits/smoke-cpu/candidates/noop", "rename the accumulator");
  console.log("the rig's first attempt judged:", first);

  // The backup, while control runs.
  const out = backup("thermite", "backup", "/backups");
  console.log(out.trim());
  const name = /backup: \/backups\/(thermite-backup-[^ ]+) /.exec(out)?.[1];
  if (!name) throw new Error("the backup named no folder");
  made.push(name);
  const manifest = JSON.parse(readFileSync(join(".dev", "backups", name, "manifest.json"), "utf8"));
  const stream = manifest.streams.find((s) => s.name === "EVENTS");
  if (!stream?.messages) throw new Error("the backup holds no EVENTS stream");
  const place = manifest.store.positions.EVENTS ?? 0;
  if (place > stream.last_seq) throw new Error(`control's place ${place} is past the stream's end`);
  console.log(
    `backup: EVENTS ${stream.messages} messages to ${stream.last_seq}, control at ${place}`,
  );

  // Work after the backup: the rig records more, which a restore must bring back from the rig.
  const second = await judged(env, "kits/smoke-cpu/candidates/noop", "after the backup");
  const ranOn = eventsStream();
  console.log("after the backup, EVENTS holds", ranOn.messages);
  if (ranOn.last <= stream.last_seq) throw new Error("the stream did not grow after the backup");

  // A restore on the bus that ran on is refused, and changes nothing.
  stack("stop", "control");
  const refused = backupFails("thermite", "restore", `/backups/${name}`);
  if (refused.status !== 1 || !/EVENTS on the bus is not the backup's/.test(refused.stderr))
    throw new Error(
      `the restore was not refused as it should be: ${refused.status} ${refused.stderr}`,
    );
  console.log("refused, as it should be:", refused.stderr.trim().slice(0, 160));

  // The page's steps.
  stack("stop", "nats");
  console.log(
    backup("thermite", "restore", "--bus-store", "/bus-store", `/backups/${name}`).trim(),
  );
  dc({ ...composeEnv, THERMITE_NATS_MEMORY: "512m" }, "up", "-d", "--no-deps", "nats");
  const restored = await until(
    "the restore, once the bus serves",
    async () =>
      backup("thermite", "restore", "--control", "http://control:8800", `/backups/${name}`),
    120_000,
    3000,
  );
  console.log(restored.trim());
  if (!/EVENTS: restored and checked/.test(restored)) throw new Error("EVENTS was not restored");
  const back = eventsStream();
  if (back.messages !== stream.messages || back.last !== stream.last_seq)
    throw new Error(`EVENTS came back as ${JSON.stringify(back)}, not the backup's`);
  const kept = stack("exec", "-T", "nats", "ls", "/data");
  if (!/replaced-/.test(kept)) throw new Error("the bus's store was not kept aside");
  stack("up", "-d", "nats", "control");
  await healthy();
  const state = backup("ls", "/var/lib/thermite-control");
  if (!/replaced-/.test(state)) throw new Error("control's replaced state was not kept aside");

  // Control applied the stream from its place, and the rig sends what came after the backup.
  const caught = await until(
    "the attempt after the backup back at control, from the rig",
    async () => latestVerdicts(await events())[second] && (await api("/v1/bus")).body.events,
    300_000,
    2000,
  );
  if (caught.apply?.stopped !== null)
    throw new Error(`control's apply stopped: ${caught.apply?.stopped}`);
  console.log(
    "after the restore:",
    JSON.stringify({ apply: caught.apply, stream: eventsStream() }),
  );
  console.log("backup acceptance: OK");
} finally {
  if (process.env.KEEP !== "1") {
    stack("down", "-v");
    for (const name of made)
      rmSync(join(".dev", "backups", name), { recursive: true, force: true });
  }
}
