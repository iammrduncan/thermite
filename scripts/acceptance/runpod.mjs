#!/usr/bin/env node
// Rigs on RunPod from end to end, with no RunPod and nothing paid. Control runs in this process,
// with its REST API, pull mode and the RunPod rigs' loop, against the fake RunPod API
// (tests/helpers/fake-runpod.ts), and on its message bus: the bus's server in a container of its
// pinned image (lib/control-bus.mjs), which dials each pod's leaf node, as the address the fake
// RunPod gives for the pod's port 7422. Each pod the fake makes is a container of the one-container rig
// image on this machine: the launch's environment, RunPod's variables (made up), a volume at
// /workspace that a stop keeps, and the pull mode port, which the fake's stand-in for RunPod's
// proxy reaches. A stop removes the container and keeps the volume, as RunPod empties a stopped
// pod's disk; a start makes the container again on the same volume; a terminate removes both.
// The rig's live state is on the container's disk; root keeps a snapshot of it on the volume.
//
//   launch     the owner launches a rig over REST: the pod starts with only the launch values;
//   enroll     control enrolls the pod through the proxy and pins its keys;
//   report     the supervisor registers its keys through the proxy, and the rig's reports reach
//              control on the bus, through the pod's leaf node;
//   stop       the runs are paused, an export leaves the pod for control, the stop takes a
//              snapshot of the state onto the volume, sealed with the pod's snapshot key from
//              the launch, then the pod stops; nothing on the volume was ever given an owner but
//              root, and nothing there is in plain text;
//   start      the pod runs again with its launch values: root restores its state from the
//              sealed snapshot on its fresh disk, every file verified, and it reports with the
//              same keys, enrollment and token;
//   reset      a full reset: an export leaves the pod, the harness and the supervisor wipe their
//              state and start again in the pod, and both report again (goal 165);
//   terminate  a full export leaves the pod, then the pod and its volume are removed, and the
//              rig is retired.
//
// Every step is in the rig's history and RunPod's API sees only the calls it should.
//
//   COMPOSE="podman compose" node scripts/acceptance/runpod.mjs
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { acceptanceChecks } from "./lib/checks.mjs";
import { addressOn, followControlBus, startControlBus } from "./lib/control-bus.mjs";
import { cleanEngine, engine } from "./lib/smoke-env.mjs";

// Control's side, in this process (Node.js strips the types of these files), on its message bus.
const { buildInfo } = await import("../../src/common/build-info.ts");
const { createControlApi } = await import("../../src/control/api/index.ts");
const { controlParts } = await import("../../src/control/parts.ts");
const { advanceResets } = await import("../../src/control/lifecycle.ts");
const { RunpodRigs } = await import("../../src/control/runpod/rigs.ts");
const { SecretBox } = await import("../../src/control/secrets.ts");
const { ControlTunnels } = await import("../../src/control/runpod/tunnel.ts");
const { generateSigningKeys } = await import("../../src/core/commands.ts");
const { LEAF_PORT } = await import("../../src/core/link/leaf.ts");
const { FAKE_RUNPOD_KEY, fakeRunpod } = await import("../../tests/helpers/fake-runpod.ts");

const harnessImage = "localhost/thermite-harness:runpod-check";
const rigImage = "localhost/thermite-rig:runpod-check";
/** Each pod's container and volume: thermite-runpod-check-<pid>-<pod>[-volume]. */
const prefix = `thermite-runpod-check-${process.pid}`;
const OWNER = "an-owner-token-for-the-runpod-check";
/** The bus's server's host port: RUNPOD_CHECK_BUS_PORT, 14510 unless given (never 4222). */
const busPort = Number(process.env.RUNPOD_CHECK_BUS_PORT ?? "14510");
/** Control's bus, once started: the pods join its network. */
let onBus;
// Inside the fake's hooks: control's loops go on while the engine works, as they do on RunPod.
const run = async (args) => (await promisify(execFile)(engine, args, { encoding: "utf8" })).stdout;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { check, failed } = acceptanceChecks();
/** Waits until `fn` gives something, checking every `every` ms; throws, in words, at the end. */
async function until(what, fn, ms = 300_000, every = 1000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`no ${what} within ${ms / 1000} s`);
    await sleep(every);
  }
}

const container = (pod) => `${prefix}-${pod.id}`;
const volume = (pod) => `${prefix}-${pod.id}-volume`;
/** Whether the engine has this container or volume (`kind`), with Docker as with Podman. */
const has = (kind, name) =>
  spawnSync(engine, [kind, "inspect", name], { stdio: "ignore" }).status === 0;
const logsOf = (name) => {
  const r = spawnSync(engine, ["logs", name], { encoding: "utf8" });
  return `${r.stdout}${r.stderr}`;
};

/**
 * Starts a pod's container on its volume; its pull mode port is the proxy's way in, and its leaf
 * node's port, on the bus's network, is the address the fake RunPod gives control's server.
 */
async function startContainer(pod) {
  await run([
    "run",
    "-d",
    "--name",
    container(pod),
    "--network",
    onBus.net,
    "-v",
    `${volume(pod)}:/workspace`,
    "-p",
    "127.0.0.1::8790",
    // Test speed: no calibration, reports every 5 s.
    "-e",
    "THERMITE_CALIBRATION_BLOCKS=0",
    "-e",
    "THERMITE_POLL_SECONDS=5",
    // RunPod's own variables (made up), which the image keeps from every process.
    "-e",
    `RUNPOD_POD_ID=${pod.id}`,
    "-e",
    "RUNPOD_API_KEY=made-up-key-for-the-runpod-check",
    "-e",
    "RUNPOD_GPU_COUNT=1",
    ...Object.entries(pod.env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
    rigImage,
  ]);
  const port = (await run(["port", container(pod), "8790/tcp"])).trim().split("\n")[0];
  pod.upstream = `http://127.0.0.1:${port.split(":").at(-1)}`;
  pod.tcp = { [LEAF_PORT]: { ip: addressOn(onBus.net, container(pod)), public: LEAF_PORT } };
}

const cloud = fakeRunpod({
  onCreate: startContainer,
  // RunPod stops the container and empties its disk; the volume stays.
  onStop: async (pod) => {
    await run(["stop", "-t", "60", container(pod)]);
    pod.stopCode = (
      await run(["inspect", container(pod), "--format", "{{.State.ExitCode}}"])
    ).trim();
    pod.stopLog = logsOf(container(pod));
    await run(["rm", container(pod)]);
    pod.upstream = undefined;
  },
  onStart: startContainer,
  onTerminate: async (pod) => {
    await run(["rm", "-f", container(pod)]);
    await run(["volume", "rm", "-f", volume(pod)]);
  },
});

const exportsDir = mkdtempSync(join(tmpdir(), "thermite-runpod-check-"));
const timers = [];
let followed;
const cleanup = async () => {
  for (const t of timers) clearInterval(t);
  followed?.stop();
  await onBus?.remove();
  for (const pod of cloud.pods.values()) {
    spawnSync(engine, ["rm", "-f", container(pod)], { stdio: "ignore" });
    spawnSync(engine, ["volume", "rm", "-f", volume(pod)], { stdio: "ignore" });
  }
  spawnSync(engine, ["rmi", "-f", rigImage, harnessImage], { stdio: "ignore" });
  rmSync(exportsDir, { recursive: true, force: true });
  cleanEngine();
};

try {
  console.log("building the CPU harness image and the rig image on it ...");
  execFileSync(
    engine,
    ["build", "-q", "-t", harnessImage, "-f", "containers/harness/Containerfile", "."],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
  execFileSync(
    engine,
    [
      "build",
      "-q",
      "-t",
      rigImage,
      "--build-arg",
      `HARNESS_IMAGE=${harnessImage}`,
      "-f",
      "containers/rig/Containerfile",
      ".",
    ],
    { stdio: ["ignore", "ignore", "inherit"] },
  );

  // Control, on its bus, with one RunPod account in Providers: the fake's key, sealed.
  const keys = generateSigningKeys();
  const secrets = SecretBox.ephemeral();
  onBus = await startControlBus({ name: prefix, port: busPort, secrets });
  const { store } = onBus;
  store.gpuClouds.add({
    name: "runpod",
    kind: "runpod",
    key_sealed: secrets.seal(FAKE_RUNPOD_KEY),
    key_hint: "…cdef",
    by: "owner:test",
  });
  // Pull mode reaches pods only through the fake's proxy, as through RunPod's; a launch gives the
  // pod its leaf node, which trusts control's authority for the bus.
  const tunnels = new ControlTunnels(store, secrets, keys.privateKeyPem, {
    fetch: cloud.fetch,
    busCa: onBus.caCert,
  });
  const rigs = new RunpodRigs(store, secrets, tunnels, {
    fetch: cloud.fetch,
    image: rigImage,
    staleAfterMs: 180_000,
    privateKeyPem: keys.privateKeyPem,
  });
  const parts = controlParts(
    store,
    keys.privateKeyPem,
    {
      staleAfterMs: 180_000,
      secrets,
      tunnels,
      runpodRigs: rigs,
      cloudFetch: cloud.fetch,
      busCa: onBus.caCert,
    },
    { staleAfterMs: 180_000, control: buildInfo() },
  );
  followed = followControlBus(onBus, parts);
  const app = createControlApi(store, { admin: OWNER, rigs: {} }, keys.privateKeyPem, {
    staleAfterMs: 180_000,
    secrets,
    tunnels,
    runpodRigs: rigs,
    cloudFetch: cloud.fetch,
    exportsDir,
    parts,
    busUsers: onBus.busUsers,
    busConfig: followed.busConfig,
  });
  const api = async (path, body) => {
    const r = await app.request(path, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${OWNER}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: r.status, body: await r.json() };
  };
  // Control's loops, faster than main.ts's: pull mode, and the RunPod rigs every 2 s.
  timers.push(
    setInterval(() => {
      tunnels.advance(1000).catch((err) => console.error(`pull: ${String(err)}`));
    }, 500),
    setInterval(() => {
      rigs.advance().catch((err) => console.error(`runpod rigs: ${String(err)}`));
    }, 2000),
    setInterval(() => {
      const privateKeyPem = keys.privateKeyPem;
      advanceResets({ store, privateKeyPem, staleAfterMs: 180_000 }).catch((err) =>
        console.error(`resets: ${String(err)}`),
      );
    }, 2000),
  );

  // Launch.
  const launched = await api("/v1/gpu-clouds/runpod/rigs", {
    gpu: "RTX A4000",
    rig: "runpod-check",
    settings: { THERMITE_TARGET: "cpu", THERMITE_TARGET_CLASS: "runpod-check" },
  });
  check(
    "the owner launches a rig over REST",
    launched.status === 201,
    JSON.stringify(launched.body).slice(0, 300),
  );
  const rig = launched.body.rig;
  const pod = cloud.pods.get(launched.body.pod);
  check(
    "its pod runs: a container of the rig image",
    Boolean(pod) && has("container", container(pod)),
    pod ? container(pod) : "no pod",
  );
  check(
    "the launch gave the pod pull mode's values, its leaf node's and its snapshot key, and nothing else",
    JSON.stringify(Object.keys(pod.env).sort()) ===
      JSON.stringify([
        "THERMITE_LEAF_CERT",
        "THERMITE_LEAF_CONTROL_CA",
        "THERMITE_LEAF_KEY",
        "THERMITE_RIG_ID",
        "THERMITE_STATE_SNAPSHOT_KEY",
        "THERMITE_TUNNEL_CONTROL_BOX",
        "THERMITE_TUNNEL_CONTROL_KEY_SHA256",
        "THERMITE_TUNNEL_ENROLL_CODE",
        "THERMITE_TUNNEL_PORT",
        "THERMITE_TUNNEL_PREFIX",
      ]),
    Object.keys(pod.env).join(", "),
  );

  // Enroll, then report.
  const enrolled = await until("enrollment", () => store.tunnels.get(rig)?.enrolled_at);
  check("control enrolled the pod through the proxy and pinned its keys", Boolean(enrolled));
  const keysBefore = store.tunnels.get(rig)?.pod_sign_public;
  await until("report", () =>
    store.reportedRigs.list().find((u) => u.id === rig && Date.parse(u.last_seen) > 0),
  );
  check(
    "the supervisor registered its keys through the proxy, and its reports reach control on the bus, through the pod's leaf node",
    Boolean(store.busKeys.rigKey(rig)) && Boolean(store.tunnels.get(rig)?.leaf_address),
    store.tunnels.get(rig)?.leaf_address ?? "no leaf address",
  );
  await until(
    "the supervisor's export figures",
    () => store.reportedRigs.supervisor(rig)?.export?.to === "control",
  );
  check("the supervisor sends its exports to control", true);

  // Stop: the results leave first, then the pod stops.
  const stopAsked = await api(`/v1/rigs/${rig}/runpod/stop`, {});
  check(
    "the owner stops the pod over REST",
    stopAsked.status === 200 && stopAsked.body.op?.kind === "stop",
    stopAsked.body.op_words ?? JSON.stringify(stopAsked.body),
  );
  const stopped = await until("the stop", () => {
    const v = rigs.view(rig);
    return v?.status === "EXITED" && !v.op ? v : undefined;
  });
  const stopExport = stopped.last_export;
  check(
    "its export left the pod for control before the pod stopped",
    stopped.last_export_left === true && Boolean(store.exports.get(rig, stopExport)?.complete_at),
    `${stopExport}: ${JSON.stringify(store.rigHistory.list(rig).at(-1)?.detail)}`,
  );
  check(
    "the pod's container stopped cleanly",
    pod.stopCode === "0" && pod.stopLog.includes('"msg":"stopped"'),
    `exit ${pod.stopCode}`,
  );
  check(
    "the pod's disk is gone and its volume stays",
    !has("container", container(pod)) && has("volume", volume(pod)),
  );
  // The live state was on the pod's disk; the stop took a snapshot of it onto the volume first.
  const stopSnap = pod.stopLog
    .split("\n")
    .filter((l) => l.includes('"reason":"at the stop"'))
    .map((l) => JSON.parse(l))[0];
  check(
    "the stop took a snapshot of the rig's state, with its ledger, onto the volume",
    stopSnap?.msg === "took a snapshot of the rig's state" && stopSnap.ledger === true,
    JSON.stringify(stopSnap),
  );
  // RunPod's volume refuses root a change of owner: nothing on it was ever given one, and its
  // snapshot folder is root's alone. RunPod's volume also lets any user in, whatever the modes:
  // the snapshot is sealed, its manifest and files named by a keyed hash, nothing in plain text
  // (no private key, no SQLite file, no token).
  const onVolume = (
    await run([
      "run",
      "--rm",
      "-v",
      `${volume(pod)}:/workspace`,
      "--entrypoint",
      "sh",
      rigImage,
      "-c",
      "stat -c '%u %a' /workspace/thermite; find /workspace ! -uid 0 | head -5",
    ])
  )
    .trim()
    .split("\n");
  check(
    "nothing on the volume belongs to anyone but root, and the snapshot folder is root's, 0700",
    onVolume.length === 1 && onVolume[0] === "0 700",
    onVolume.join("; "),
  );
  const sealedLook = JSON.parse(
    await run([
      "run",
      "--rm",
      "-v",
      `${volume(pod)}:/workspace`,
      "--entrypoint",
      "node",
      rigImage,
      "-e",
      `const fs=require("fs");const d="/workspace/thermite";const out={names:[],plain:[]};for(const n of fs.readdirSync(d)){out.names.push(n);const b=fs.readFileSync(d+"/"+n);if(b.subarray(0,8).toString("latin1")!=="THMSEAL1"||b.includes("PRIVATE KEY")||b.includes("SQLite format"))out.plain.push(n)}console.log(JSON.stringify(out))`,
    ]),
  );
  check(
    "the snapshot on the volume is sealed: the manifest and sealed files only, nothing in plain text",
    sealedLook.names.includes("manifest") &&
      sealedLook.names.every((n) => n === "manifest" || /^[0-9a-f]{64}$/.test(n)) &&
      sealedLook.plain.length === 0 &&
      !JSON.stringify(sealedLook).includes(pod.env.THERMITE_STATE_SNAPSHOT_KEY),
    `${sealedLook.names.length} names; not sealed: ${sealedLook.plain.join(", ")}`,
  );
  check(
    "the snapshot key appears nowhere in the pod's output",
    !pod.stopLog.includes(pod.env.THERMITE_STATE_SNAPSHOT_KEY),
  );
  check("the rig shows who stopped it", stopped.stopped_by === "owner", stopped.stopped_by);

  // Start: the pod runs again from its volume, with its keys, and reports.
  const startedAt = Date.now();
  const started = await api(`/v1/rigs/${rig}/runpod/start`, {});
  check(
    "the owner starts the pod again over REST",
    started.status === 200,
    started.body.op_words ?? started.body.status,
  );
  await until("a report after the start", () =>
    store.reportedRigs.list().find((u) => u.id === rig && Date.parse(u.last_seen) > startedAt),
  );
  check(
    "the pod reports again with the keys and the enrollment on its volume",
    store.tunnels.get(rig)?.enrolled_at === enrolled &&
      store.tunnels.get(rig)?.pod_sign_public === keysBefore,
  );
  // On its fresh disk, root restored the state from the snapshot: the ledger, the supervisor's
  // keys and enrollment, and the token between the two parts, which is not made again.
  const startLog = logsOf(container(pod));
  const restored = startLog
    .split("\n")
    .filter((l) => l.includes("restored the rig's state from its snapshot"))
    .map((l) => JSON.parse(l))[0];
  check(
    "the start restored the rig's state from the sealed snapshot, every file verified, with the same token",
    restored?.parts?.harness?.files > 0 &&
      restored.parts.supervisor?.files > 0 &&
      restored.parts.secrets?.files === 1 &&
      restored.snapshot === "manifest" &&
      restored.seq >= 1 &&
      !restored.refused &&
      !startLog.includes("the snapshot did not verify") &&
      !startLog.includes("made the token between the supervisor and the harness"),
    JSON.stringify(restored),
  );

  // Full reset: the pod and its GPU stay. An export leaves the pod first; after the owner's
  // confirmation the harness and the supervisor wipe their state and start again in the pod, the
  // supervisor's files made again by root (goal 165), and both report again.
  const resetAsked = await api(`/v1/rigs/${rig}/reset`, { confirm: `reset ${rig}` });
  check(
    "the owner asks for a full reset over REST",
    resetAsked.status === 201,
    resetAsked.body.error,
  );
  const resetOf = () =>
    store.fullResets.list(50).find((r) => Number(r.id) === resetAsked.body.reset);
  const resetIn = (...states) => (states.includes(String(resetOf()?.state)) ? true : undefined);
  await until("the reset's export", () => resetIn("awaiting_owner", "failed", "cancelled"));
  check(
    "the reset's export reached control, and the reset waits for the owner",
    resetIn("awaiting_owner"),
    String(resetOf()?.detail),
  );
  const ledgerBefore = store.reportedRigs.list().find((u) => u.id === rig)?.ledger_id;
  await api(`/v1/resets/${resetAsked.body.reset}/confirm`, {});
  await until("the wipe", () => resetIn("done", "failed"));
  const wipedAt = Date.now();
  check("the rig wiped its state", resetIn("done"), String(resetOf()?.detail));
  await until("a report from the wiped harness", () =>
    store.reportedRigs.list().find((u) => u.id === rig && u.ledger_id !== ledgerBefore),
  );
  await until("a report from the supervisor after the wipe", () =>
    Date.parse(store.reportedRigs.supervisor(rig)?.received_at ?? "") > wipedAt ? true : undefined,
  );
  check("the harness reports a new ledger, and the supervisor reports again", true);

  // Terminate: a full export leaves the pod, then the pod and its volume go.
  const termAt = new Date().toISOString();
  const termAsked = await api(`/v1/rigs/${rig}/runpod/terminate`, { confirm: `terminate ${rig}` });
  check(
    "the owner terminates the pod over REST",
    termAsked.status === 200 && termAsked.body.op?.kind === "terminate",
    termAsked.body.op_words ?? JSON.stringify(termAsked.body),
  );
  const gone = await until("the terminate", () => {
    const v = rigs.view(rig);
    return v && !v.active ? v : undefined;
  });
  // The terminate's own export: full, made after it was asked, every file on control.
  const exports = store.exports.ofRig(rig);
  const lastFull = exports.find((e) => e.full && e.complete_at && e.created_at >= termAt);
  check(
    "a full export reached control before the pod was removed",
    gone.status === "TERMINATED" && Boolean(lastFull),
    lastFull?.name ?? exports.map((e) => `${e.name} full=${e.full} ${e.complete_at}`).join("; "),
  );
  check(
    "the pod and its volume are gone",
    !has("container", container(pod)) && !has("volume", volume(pod)),
  );
  check("the rig is retired: control no longer connects to it", Boolean(store.retired.get(rig)));

  const history = store.rigHistory.list(rig).map((e) => `${e.step}${e.ok ? "" : " (not ok)"}`);
  const want = [
    "runpod_launched",
    "runpod_stopping",
    "runpod_stopped",
    "runpod_starting",
    "runpod_running",
    "reset_requested",
    "reset_done",
    "runpod_terminating",
    "runpod_terminated",
  ];
  check(
    "each change is in the rig's history",
    JSON.stringify(history) === JSON.stringify(want),
    history.join(", "),
  );
  const calls = cloud.calls
    .filter((c) => c.host === "api.runpod.io" && c.method !== "GET")
    .map((c) => `${c.method} ${c.path}${c.body?.action ? ` ${c.body.action}` : ""}`);
  check(
    "RunPod's API got a create, a stop, a start and a delete, nothing more",
    JSON.stringify(calls) ===
      JSON.stringify([
        "POST /v2/pods",
        `POST /v2/pods/${pod.id}/action stop`,
        `POST /v2/pods/${pod.id}/action start`,
        `DELETE /v2/pods/${pod.id}`,
      ]),
    calls.join("; "),
  );
} catch (err) {
  check("the script ran to its end", false, err instanceof Error ? err.message : String(err));
  for (const pod of cloud.pods.values())
    console.error(`${container(pod)}'s last output:\n${logsOf(container(pod)).slice(-3000)}`);
} finally {
  await cleanup();
}
console.log(failed() ? `runpod acceptance: ${failed()} FAILED` : "runpod acceptance: OK");
process.exit(failed() ? 1 : 0);
