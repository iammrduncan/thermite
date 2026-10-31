#!/usr/bin/env node
// The one-container rig image (containers/rig/Containerfile), as a RunPod pod runs it, on this
// machine: built on the CPU harness image, started as root with the engine's default capabilities
// and without no-new-privileges, and given RunPod's variables (made up) and the launch values
// control mints for pull mode. Control runs in this process and connects to the pod's port, as
// it would through RunPod's proxy, and runs its message bus: the bus's server in a container of
// its pinned image (lib/control-bus.mjs), which dials the pod's leaf node on the check's network.
// Then:
//   - the harness waits for enrollment; once control has enrolled the pod, root checks control's
//     key against the launch's SHA-256 and gives the harness its own copy, and the rig's
//     settings from control reach the controller, but not the enrollment code;
//   - the supervisor registers its keys through control's connection, and the rig's reports reach
//     control on the bus, through the pod's leaf node;
//   - the state's snapshot folder (/workspace/thermite; on RunPod, the volume) is root's, mode
//     0700, closed to both parts and the roles, and root takes a snapshot right after enrollment,
//     sealed with the launch's key: the manifest and sealed files only, nothing in plain text;
//   - the snapshot key is in no part's environment and nowhere in the rig's output;
//   - the isolation selftest passes, both the harness's own check at start and one run as root,
//     with the container checks (the supervisor's user, its GPU access, set-id files, RunPod's
//     variables, the enrollment code, control's key, the snapshot folder and its key) and the
//     supervisor's places, the snapshot folder and its key probed for every role, and the image's
//     own kits and projects (/opt/thermite/checks) refused to every role;
//   - a key the supervisor writes after enrollment changes nothing the harness trusts;
//   - a supervisor that hangs is ended and starts again: frozen (SIGSTOP), its health route no
//     longer answers, and the broker, which asks it every 30 s, ends it at the third failure in a
//     row, about 100 s later (a loop that is really late would take 30 minutes);
//   - a supervisor or a controller that exits starts again;
//   - a stop takes a snapshot of the state, with the ledger, then ends both parts cleanly, with
//     exit code 0.
// With rootless Podman on a machine VM it also gives the container GPU device nodes it can't
// regroup (nobody's, mode 0666, as RunPod's are): the GPU fence alone must keep every role but
// the GPU's own off them, and the supervisor too. Nothing here needs or touches a real GPU.
//
//   COMPOSE="podman compose" node scripts/acceptance/rig-image.mjs
import { execFileSync, spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { acceptanceChecks } from "./lib/checks.mjs";
import { addressOn, followControlBus, startControlBus } from "./lib/control-bus.mjs";
import { cleanEngine, engine } from "./lib/smoke-env.mjs";

// Control's side, in this process (Node.js strips the types of these files), on its message bus.
const { buildInfo } = await import("../../src/common/build-info.ts");
const { createControlApi } = await import("../../src/control/api/index.ts");
const { controlParts } = await import("../../src/control/parts.ts");
const { SecretBox } = await import("../../src/control/secrets.ts");
const { ControlTunnels } = await import("../../src/control/runpod/tunnel.ts");
const { generateSigningKeys } = await import("../../src/core/commands.ts");
const { LEAF_PORT } = await import("../../src/core/link/leaf.ts");
const { keySha256 } = await import("../../src/core/tunnel.ts");

const harnessImage = "localhost/thermite-harness:rig-image-check";
const rigImage = "localhost/thermite-rig:rig-image-check";
const name = "thermite-rig-image-check";
/** Fake device nodes owned by the Podman VM's root, which a rootless container doesn't map. */
const FOREIGN = "/var/tmp/thermite-rig-image-foreign-nodes";
const NODES = ["nvidia0", "nvidiactl", "nvidia-uvm"];
/** The rig's live state, on the container's disk, and its snapshot (on RunPod, the volume). */
const STATE = "/var/lib/thermite-rig";
const SNAPSHOT = "/workspace/thermite";
const sh = (args, opts = {}) =>
  execFileSync(engine, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { check, failed } = acceptanceChecks();

/** As in the multi-GPU acceptance: rootless Podman on a machine VM can show such nodes. */
function foreignNodesPossible() {
  if (engine !== "podman") return false;
  const info = spawnSync(engine, ["info", "--format", "{{.Host.Security.Rootless}}"], {
    encoding: "utf8",
  });
  if (info.stdout.trim() !== "true") return false;
  return spawnSync(engine, ["machine", "inspect"], { stdio: "ignore" }).status === 0;
}
const foreign = foreignNodesPossible();

/** Control's pulls from the pod, once it is launched. */
let pump;
/** Control's bus (lib/control-bus.mjs), and its loops. */
let onBus;
let followed;
/** The bus's server's host port: RIG_IMAGE_CHECK_BUS_PORT, 14520 unless given (never 4222). */
const busPort = Number(process.env.RIG_IMAGE_CHECK_BUS_PORT ?? "14520");
const cleanup = async () => {
  clearInterval(pump);
  followed?.stop();
  await onBus?.remove();
  spawnSync(engine, ["rm", "-f", name], { stdio: "ignore" });
  spawnSync(engine, ["rmi", "-f", rigImage, harnessImage], { stdio: "ignore" });
  if (foreign) spawnSync(engine, ["machine", "ssh", `sudo rm -rf ${FOREIGN}`], { stdio: "ignore" });
  cleanEngine();
};

const logs = () => {
  const r = spawnSync(engine, ["logs", name], { encoding: "utf8" });
  return `${r.stdout}${r.stderr}`;
};
const logLines = (msg) =>
  logs()
    .split("\n")
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return undefined;
      }
    })
    .filter((l) => l?.msg === msg);
/** The `nth` log line (from 1) with this message, once it is there. */
async function waitFor(msg, ms = 180_000, nth = 1) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const l = logLines(msg)[nth - 1];
    if (l) return l;
    await sleep(1000);
  }
  throw new Error(`no "${msg}" (${nth}) in ${ms / 1000} s\n${logs().slice(-4000)}`);
}
/** Runs a Node.js snippet in the container as root (or as `user`) and returns its output. */
const inside = (code, user) =>
  sh(["exec", ...(user ? ["--user", user] : []), name, "node", "-e", code]).trim();
const pidsOf = (script) =>
  inside(
    `const fs=require("fs");const out=[];for(const p of fs.readdirSync("/proc")){if(!/^\\d+$/.test(p))continue;try{const a=fs.readFileSync("/proc/"+p+"/cmdline","utf8").split("\\0");if((a[1]||"").endsWith(${JSON.stringify(script)}))out.push(Number(p))}catch{}}console.log(JSON.stringify(out))`,
  );
const kill = (script) =>
  inside(
    `const fs=require("fs");for(const p of fs.readdirSync("/proc")){if(!/^\\d+$/.test(p))continue;try{const a=fs.readFileSync("/proc/"+p+"/cmdline","utf8").split("\\0");if((a[1]||"").endsWith(${JSON.stringify(script)}))process.kill(Number(p),"SIGKILL")}catch{}}`,
  );

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
  const setid = sh([
    "run",
    "--rm",
    "--entrypoint",
    "find",
    rigImage,
    "/",
    "-xdev",
    "-type",
    "f",
    "-perm",
    "/6000",
  ]).trim();
  check("the image has no set-id file", setid === "", setid.split("\n").slice(0, 5).join(", "));

  if (foreign) {
    // podman machine ssh joins its arguments into one remote command line: quote it whole.
    const list = NODES.join(" ");
    sh([
      "machine",
      "ssh",
      `sudo sh -c 'rm -rf ${FOREIGN} && mkdir -p ${FOREIGN} && cd ${FOREIGN} && touch ${list} && chown 0:0 ${list} && chmod 666 ${list}'`,
    ]);
  }
  // Control, on its bus, mints the rig, its one-time code and the pod's launch values, as a
  // launch does: its leaf node's too.
  const controlKeys = generateSigningKeys();
  const secrets = SecretBox.ephemeral();
  onBus = await startControlBus({ name, port: busPort, secrets });
  const { store } = onBus;
  const tunnels = new ControlTunnels(store, secrets, controlKeys.privateKeyPem, {
    busCa: onBus.caCert,
  });
  const parts = controlParts(
    store,
    controlKeys.privateKeyPem,
    { staleAfterMs: 180_000, secrets, tunnels, busCa: onBus.caCert },
    { staleAfterMs: 180_000, control: buildInfo() },
  );
  followed = followControlBus(onBus, parts);
  createControlApi(
    store,
    { admin: "an-admin-token-for-the-test", rigs: {} },
    controlKeys.privateKeyPem,
    {
      staleAfterMs: 180_000,
      secrets,
      tunnels,
      parts,
      busUsers: onBus.busUsers,
      busConfig: followed.busConfig,
    },
  );
  const rig = "rig-image-check";
  const minted = tunnels.mint({
    by: "owner:test",
    rig,
    config: { THERMITE_TARGET_CLASS: "rig-image-check" },
  });
  check("control's launch values use the image's port", minted.port === 8790, String(minted.port));
  // RunPod's eight variables, as the first spike found them; the values are made up.
  const runpod = {
    RUNPOD_API_KEY: "made-up-key-for-the-test",
    RUNPOD_CPU_COUNT: "4",
    RUNPOD_DC_ID: "dc-test",
    RUNPOD_GPU_COUNT: "1",
    RUNPOD_GPU_NAME: "none",
    RUNPOD_MEM_GB: "8",
    RUNPOD_POD_HOSTNAME: "pod-test-host",
    RUNPOD_POD_ID: "pod-test",
  };
  sh([
    "run",
    "-d",
    "--name",
    name,
    // RunPod's proxy reaches the pod's port; here control reaches it on this machine. Its leaf
    // node's port, on the bus's network, is what RunPod's public address stands for.
    "--network",
    onBus.net,
    "-p",
    "127.0.0.1::8790",
    "-e",
    "THERMITE_CALIBRATION_BLOCKS=0",
    "-e",
    "THERMITE_POLL_SECONDS=5",
    ...Object.entries(minted.env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
    ...Object.entries(runpod).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
    ...(foreign
      ? [
          // SELinux labels off for this container only: the VM would otherwise refuse the files
          // to every process, and the test must show the fence alone refusing the roles.
          "--security-opt",
          "label=disable",
          ...NODES.flatMap((n) => ["-v", `${FOREIGN}/${n}:/dev/${n}`]),
        ]
      : []),
    rigImage,
  ]);
  // Before enrollment: the supervisor serves the port, the harness waits.
  await waitFor("waiting for enrollment: the harness starts once control has enrolled the pod");
  const supervisorUp = await waitFor("waiting for the harness").catch(() => undefined);
  check("the supervisor runs", Boolean(supervisorUp) || pidsOf("dist/supervisor/main.js") !== "[]");
  await sleep(3000);
  check("the harness does not start before enrollment", pidsOf("dist/harness/main.js") === "[]");
  const keyFile = "/etc/thermite/control-signing.pub";
  check(
    "no key for the harness before enrollment",
    spawnSync(engine, ["exec", name, "test", "-e", keyFile]).status !== 0,
  );

  // Control connects to the pod and enrolls it, then exchanges with it as its loop does.
  const port = sh(["port", name, "8790/tcp"]).trim().split("\n")[0].split(":").at(-1);
  tunnels.attach(rig, "pod-test", `http://127.0.0.1:${port}`);
  store.tunnels.setLeafAddress(rig, `${addressOn(onBus.net, name)}:${LEAF_PORT}`);
  pump = setInterval(() => {
    tunnels.advance(1000).catch((err) => console.error(`pull: ${String(err)}`));
  }, 500);
  await waitFor("enrolled: the harness starts with control's key from enrollment", 120_000);
  check(
    "control enrolled the pod and pinned its keys",
    Boolean(store.tunnels.get(rig)?.enrolled_at),
  );
  await waitFor("judge ready");
  // The state snapshot: root's folder, closed to the parts and the roles, taken after enrollment.
  const closed = await waitFor("the snapshot folder is closed to the parts and the roles", 5000);
  const snapStat = sh(["exec", name, "stat", "-c", "%u %a", SNAPSHOT]).trim();
  check(
    "the state's snapshot folder is root's, mode 0700, closed to the parts and the roles",
    closed.dir === SNAPSHOT && snapStat === "0 700",
    `${snapStat}; ${JSON.stringify(closed)}`,
  );
  const enrolledSnap = (await waitFor("took a snapshot of the rig's state", 60_000)) ?? {};
  check(
    "root took a snapshot of the state right after enrollment",
    enrolledSnap.reason === "after enrollment" && enrolledSnap.files > 0,
    JSON.stringify(enrolledSnap),
  );
  // Sealed: the manifest and files named by a keyed hash, each sealed; nothing in plain text.
  const onVolume = JSON.parse(
    inside(
      `const fs=require("fs");const d=${JSON.stringify(SNAPSHOT)};const out={names:[],plain:[]};for(const n of fs.readdirSync(d)){out.names.push(n);const b=fs.readFileSync(d+"/"+n);if(b.length&&(b.subarray(0,8).toString("latin1")!=="THMSEAL1"||b.includes("PRIVATE KEY")||b.includes("SQLite format")))out.plain.push(n)}console.log(JSON.stringify(out))`,
    ),
  );
  // A snapshot after an export may be under way: its files being sealed are there too.
  check(
    "the snapshot is sealed: the manifest and sealed files only, nothing in plain text",
    onVolume.names.includes("manifest") &&
      onVolume.names.length > 2 &&
      onVolume.names.every((n) => /^(manifest(\.new)?|[0-9a-f]{64}|\.new-[0-9a-f]{32})$/.test(n)) &&
      onVolume.plain.length === 0,
    `${onVolume.names.length} names; not sealed: ${onVolume.plain.join(", ")}`,
  );
  const tokenMade = logLines("made the token between the supervisor and the harness").length;
  check("the broker made the token between the two parts once", tokenMade === 1);
  const keyNow = () => ({
    sha: keySha256(sh(["exec", name, "cat", keyFile])),
    stat: sh(["exec", name, "stat", "-c", "%U %a", keyFile]).trim(),
  });
  const given = keyNow();
  check(
    "root gave the harness its own copy of control's key, the one the launch named",
    given.sha === keySha256(controlKeys.publicKeyPem) && given.stat === "root 644",
    given.stat,
  );
  // The controller's environment, read as its own user: control's settings, not the code.
  const controller = JSON.parse(pidsOf("dist/harness/main.js"))[0];
  const ctlEnv = inside(
    `process.stdout.write(require("fs").readFileSync("/proc/${controller}/environ","latin1").split("\\0").map(kv=>kv.split("=")[0]+(kv.startsWith("THERMITE_TARGET_CLASS=")?"="+kv.split("=")[1]:"")).join("\\n"))`,
    "10010:10010",
  ).split("\n");
  check(
    "the controller has the rig's settings from control, and no code, path, snapshot key or RunPod variable",
    ctlEnv.includes("THERMITE_TARGET_CLASS=rig-image-check") &&
      !ctlEnv.some((k) =>
        /^(THERMITE_TUNNEL_(ENROLL_CODE|PREFIX|PORT)|THERMITE_STATE_SNAPSHOT_KEY|RUNPOD_)/.test(k),
      ),
    ctlEnv
      .filter((k) => /^(THERMITE_TUNNEL|THERMITE_STATE_SNAPSHOT_KEY|RUNPOD)/.test(k))
      .join(", "),
  );
  // The supervisor's environment, read as its own user: no snapshot key either.
  const supervisorPid = JSON.parse(pidsOf("dist/supervisor/main.js"))[0];
  const supEnv = inside(
    `process.stdout.write(require("fs").readFileSync("/proc/${supervisorPid}/environ","latin1").split("\\0").map(kv=>kv.split("=")[0]).join("\\n"))`,
    "10001:10001",
  ).split("\n");
  check(
    "the supervisor has no snapshot key",
    supEnv.includes("THERMITE_SUPERVISOR_HOME") && !supEnv.includes("THERMITE_STATE_SNAPSHOT_KEY"),
    supEnv.filter((k) => k.startsWith("THERMITE_STATE")).join(", "),
  );
  check(
    "RunPod's API key, the enrollment code and the snapshot key appear nowhere in the rig's output",
    !logs().includes("made-up-key-for-the-test") &&
      !logs().includes(minted.env.THERMITE_TUNNEL_ENROLL_CODE) &&
      !logs().includes(minted.env.THERMITE_STATE_SNAPSHOT_KEY),
  );
  // The rig's reports reach control on the bus, through the pod's leaf node.
  let reported = false;
  for (let i = 0; i < 60 && !reported; i++) {
    reported = store.reportedRigs.list().some((r) => r.id === rig);
    if (!reported) await sleep(2000);
  }
  check(
    "the supervisor registered its keys through control's connection, and its reports reach control on the bus",
    reported && Boolean(store.busKeys.rigKey(rig)),
  );

  if (foreign) {
    const seen = sh(["exec", name, "stat", "-c", "%U %a", "/dev/nvidia0"]).trim();
    check("the GPU's node is nobody's, 0666, as on RunPod", seen === "nobody 666", seen);
  }

  // The harness's own isolation check at start, as its controller's user.
  const started = JSON.parse(
    inside(
      `const {DatabaseSync}=require("node:sqlite");const db=new DatabaseSync(${JSON.stringify(`${STATE}/harness/ledger/ledger.db`)},{readOnly:true});console.log(JSON.stringify(db.prepare("select body from event where kind='rig_check_finished' order by id").all().map(r=>JSON.parse(r.body))))`,
    ),
  );
  const atStart = started.find((b) => b.check === "isolation");
  check("the harness's isolation check at start passes", atStart?.ok === true, atStart?.summary);
  const startContainer = atStart?.detail?.container ?? {};
  check(
    "it checked the container, from the controller's side too",
    startContainer["supervisor-user"] === "uid 10001, gid 10001, no_new_privs" &&
      /^none \(read [1-9]/.test(startContainer["runpod-variables"] ?? "") &&
      /^none \(read [1-9]/.test(startContainer["enroll-code"] ?? "") &&
      startContainer["control-key"] === "root's, the key the launch named" &&
      /^sealed, closed to thermite, supervisor, agent-1 /.test(
        startContainer["state-snapshot"] ?? "",
      ) &&
      /^none \(read [1-9]/.test(startContainer["snapshot-key"] ?? ""),
    JSON.stringify(startContainer),
  );

  // The selftest as root: every process's environment can be read.
  const self = spawnSync(engine, ["exec", name, "thermite", "selftest", "isolation", "--force"], {
    encoding: "utf8",
  });
  let report;
  try {
    report = JSON.parse(self.stdout);
  } catch {
    report = { ok: false, error: `${self.stdout}${self.stderr}`.slice(-3000) };
  }
  // What failed, as the selftest's own words mark it (selftest/probes.ts, FAILURES).
  const failedProbes = [
    ...Object.entries(report.container ?? {}).map(([k, v]) => [`container ${k}`, v]),
    ...Object.entries(report.supervisor?.probes ?? {}).map(([k, v]) => [`supervisor ${k}`, v]),
    ...Object.entries(report.roles ?? {}).flatMap(([role, r]) =>
      Object.entries(r).map(([k, v]) => [`${role} ${k}`, v]),
    ),
  ].filter(([, v]) =>
    /^(ALLOWED|UNREADABLE|UNREACHABLE|WRONG|FOUND|OPENED|MISSING|failed)/.test(String(v)),
  );
  check(
    "the isolation selftest passes",
    report.ok === true,
    report.ok === true
      ? report.devices
      : (report.error ??
          JSON.stringify({
            devices: report.devices,
            failed: failedProbes,
            skipped: report.skipped,
          })),
  );
  const c = report.container ?? {};
  check(
    "the supervisor runs as its own user, with no_new_privs",
    c["supervisor-user"] === "uid 10001, gid 10001, no_new_privs",
    c["supervisor-user"],
  );
  check("no set-id file on the container's disk", c["setid-files"] === "none", c["setid-files"]);
  // Root without CAP_SYS_PTRACE reads only root's processes: PID 1 (tini) and the broker, from
  // whose environment the supervisor's and the controller's are made.
  const rp = /^none \(read (\d+) of (\d+) processes\)$/.exec(c["runpod-variables"] ?? "");
  const rpOk = Boolean(rp) && Number(rp[1]) >= 2 && Number(rp[2]) >= 4;
  check(
    "no process of the rig holds a RunPod variable, PID 1 included",
    rpOk,
    rpOk
      ? c["runpod-variables"]
      : // Which processes there are, and whose, for the record of a failure.
        `${c["runpod-variables"]}; ${inside(
          `const fs=require("fs");const out=[];for(const p of fs.readdirSync("/proc")){if(!/^\\d+$/.test(p))continue;const r={p};for(const f of ["status","cmdline","environ"]){try{const t=fs.readFileSync("/proc/"+p+"/"+f,"latin1");r[f]=f==="status"?"uid "+(/^Uid:\\s*(\\d+)/m.exec(t)||[])[1]+", ppid "+(/^PPid:\\s*(\\d+)/m.exec(t)||[])[1]:f==="cmdline"?t.split("\\0").slice(0,2).join(" "):"read"}catch(e){r[f]=e.code}}out.push(r)}console.log(JSON.stringify(out))`,
        ).slice(0, 3000)}`,
  );
  check(
    "only root and the supervisor had the code; the harness's key is root's and the launch's",
    /^none \(read [1-9]/.test(c["enroll-code"] ?? "") &&
      c["control-key"] === "root's, the key the launch named",
    `${c["enroll-code"]}; ${c["control-key"]}`,
  );
  check(
    "the supervisor's user cannot open the GPU",
    foreign
      ? c["supervisor-gpu"] === "refused (fence: landlock)"
      : (c["supervisor-gpu"] ?? "").startsWith("no GPU node"),
    c["supervisor-gpu"],
  );
  check(
    "the snapshot is sealed, and neither part nor a role may open its folder",
    /^sealed, closed to thermite, supervisor, agent-1 \(owner 0:0, mode 700\); holds the manifest and [1-9]\d* sealed files$/.test(
      c["state-snapshot"] ?? "",
    ),
    c["state-snapshot"],
  );
  check(
    "no process of the rig but root's holds the snapshot key",
    /^none \(read [1-9]/.test(c["snapshot-key"] ?? ""),
    c["snapshot-key"],
  );
  const roles = report.roles ?? {};
  const mustRefuse = [
    "pid1-environ",
    "supervisor-home",
    "supervisor-token",
    "inbox-list",
    "supervisor-environ",
    "control-key-write",
    "state-snapshot",
  ];
  const leaks = Object.entries(roles).flatMap(([role, r]) => [
    ...mustRefuse.filter((p) => !/^E[A-Z]+$/.test(r[p] ?? "")).map((p) => `${role} ${p}: ${r[p]}`),
    ...["runpod-variables", "snapshot-key"]
      .filter((p) => r[p] !== "none")
      .map((p) => `${role} ${p}: ${r[p]}`),
  ]);
  check(
    "no role reaches the supervisor's places, PID 1's environment, the state's snapshot, its key or a RunPod variable",
    Object.keys(roles).length >= 6 && leaks.length === 0,
    leaks.slice(0, 6).join("; "),
  );
  // The smoke check's own kits and projects (/opt/thermite/checks): the controller's alone. Every
  // role, a lane's and an agent's users among them, must have probed them and been refused.
  const imageKits = [...new Set(["lane-1", "agent-1", ...Object.keys(roles)])].flatMap((role) =>
    ["image-checks-list", "image-kit-read"]
      .filter((p) => !/^E[A-Z]+$/.test(roles[role]?.[p] ?? ""))
      .map((p) => `${role} ${p}: ${roles[role]?.[p]}`),
  );
  check(
    "no role lists the image's own kits or reads one: only the harness does",
    imageKits.length === 0,
    imageKits.slice(0, 6).join("; "),
  );
  if (foreign) {
    const fenced = ["builder", "lane-1", "agent-1"].map((r) => [r, roles[r]?.["device:nvidia0"]]);
    check(
      "the GPU fence alone keeps every other role off the GPU",
      (report.devices ?? "").includes("fence: landlock") &&
        fenced.every(([, v]) => String(v).startsWith("EACCES")),
      `${report.devices}; ${JSON.stringify(fenced)}`,
    );
  } else {
    console.log("SKIP nodes a container can't regroup: needs rootless Podman on a machine VM");
  }

  // A supervisor that hangs starts again. Frozen, it stops answering its health route at once, as a
  // hung part would; the broker has watched the route since the supervisor first answered it, asks
  // it every 30 s, and ends the supervisor at the third failure in a row. Until the new supervisor
  // serves its port, control's pulls fail ("pull mode … fetch failed" in this script's output) and
  // wait a little longer each time: that is expected here, and below.
  await waitFor("watching the supervisor's health route", 60_000);
  const hung = pidsOf("dist/supervisor/main.js");
  inside(`for (const p of ${hung}) process.kill(p, "SIGSTOP")`);
  const unhealthy = await waitFor(
    "the supervisor is unhealthy: ending it to start it again",
    180_000,
  );
  await waitFor("supervisor exited; restarting", 30_000);
  let unhung = "[]";
  for (let i = 0; i < 30 && (unhung === "[]" || unhung === hung); i++) {
    await sleep(1000);
    unhung = pidsOf("dist/supervisor/main.js");
  }
  check(
    "a supervisor that hangs is ended after three failed health checks and starts again",
    unhealthy.failures?.length === 3 && unhung !== "[]" && unhung !== hung,
    `${hung} -> ${unhung}; ${JSON.stringify(unhealthy.failures)}`,
  );

  // A supervisor that exits starts again; so does the controller.
  const before = pidsOf("dist/supervisor/main.js");
  kill("dist/supervisor/main.js");
  await waitFor("supervisor exited; restarting", 30_000, 2);
  let after = "[]";
  for (let i = 0; i < 30 && (after === "[]" || after === before); i++) {
    await sleep(1000);
    after = pidsOf("dist/supervisor/main.js");
  }
  check(
    "a supervisor that exits starts again",
    after !== "[]" && after !== before,
    `${before} -> ${after}`,
  );
  // A supervisor that writes another key after enrollment changes nothing the harness trusts:
  // root copied the key once, at this start, after checking it.
  const otherKey = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" });
  inside(
    `require("fs").writeFileSync("${STATE}/supervisor/enrolled/control.pub", ${JSON.stringify(otherKey)})`,
    "10001:10001",
  );
  kill("dist/harness/main.js");
  await waitFor("controller exited; restarting", 30_000);
  await waitFor("judge ready", 180_000, 2);
  check("a controller that exits starts again", true);
  const kept = keyNow();
  check(
    "a key the supervisor writes later is not the one the harness trusts",
    kept.sha === given.sha && kept.stat === "root 644",
    kept.stat,
  );

  // A stop ends both parts, and the container exits with 0, even with control away. Control
  // stops connecting first, and a supervisor's call through the tunnel waits at its local port for
  // control's next exchange, for up to two minutes: the stop must end it at once, not wait for
  // control. (The engine's stop below also blocks this process, so
  // control could not answer during it anyway.)
  clearInterval(pump);
  await sleep(8000);
  const t0 = Date.now();
  sh(["stop", "-t", "60", name]);
  const stopS = Math.round((Date.now() - t0) / 1000);
  const code = sh(["inspect", name, "--format", "{{.State.ExitCode}}"]).trim();
  const stopped = logLines("stopped").length;
  const supervisorStopping = logLines("stopping").filter(
    (l) => l.component === "supervisor" && l.pull_mode === true,
  ).length;
  check(
    "a stop ends both parts cleanly, with control away",
    code === "0" && stopped === 1 && supervisorStopping === 1 && stopS < 60,
    `exit ${code}, ${stopS} s, "stopped" logged ${stopped} time(s), the supervisor stopping in pull mode ${supervisorStopping} time(s)`,
  );
  // The stop's snapshot, taken before the parts were told to stop, with the ledger.
  const lines = logs().split("\n");
  const atStop = lines.findIndex((l) => l.includes('"reason":"at the stop"'));
  const partsStopping = lines.findIndex(
    (l) => l.includes('"component":"supervisor"') && l.includes('"msg":"stopping"'),
  );
  const stopSnap = atStop >= 0 ? JSON.parse(lines[atStop]) : {};
  check(
    "the stop took a snapshot of the state, with the ledger, before the parts stopped",
    stopSnap.msg === "took a snapshot of the rig's state" &&
      stopSnap.ledger === true &&
      atStop < partsStopping,
    JSON.stringify(stopSnap),
  );
  if (code !== "0" || stopped !== 1) console.log(`the rig's last output:\n${logs().slice(-4000)}`);
} catch (err) {
  check("the script ran to its end", false, err instanceof Error ? err.message : String(err));
} finally {
  await cleanup();
}
console.log(failed() ? `rig image acceptance: ${failed()} FAILED` : "rig image acceptance: OK");
process.exit(failed() ? 1 : 0);
