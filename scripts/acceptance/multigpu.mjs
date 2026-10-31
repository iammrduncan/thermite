#!/usr/bin/env node
// Rigs with several GPUs, under Podman (or Docker) with fake devices: the harness image starts on
// four fake GPUs (plain files in place of /dev/nvidia*, and a stand-in nvidia-smi; see
// containers/test-gpu), two for the judge and two for the agents. The broker's per-card groups,
// the timing user of the second judge card, the judge executors and the isolation selftest then
// run for real; every role, on every card, is refused the image's own kits and projects
// (/opt/thermite/checks). A second start with overlapping lists must be refused. The fakes refuse
// to start where a real NVIDIA device is present.
//
//   COMPOSE="podman compose" node scripts/acceptance/multigpu.mjs
import { execFileSync, spawnSync } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { acceptanceChecks } from "./lib/checks.mjs";
import { cleanEngine, engine } from "./lib/smoke-env.mjs";

const image = "localhost/thermite-harness:multigpu-check";
const names = [
  "thermite-multigpu-a",
  "thermite-multigpu-b",
  "thermite-multigpu-c",
  "thermite-multigpu-d",
];
/** Fake device nodes owned by the Podman VM's root, which a rootless container doesn't map. */
const FOREIGN = "/var/tmp/thermite-multigpu-foreign-nodes";
const sh = (args, opts = {}) =>
  execFileSync(engine, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { check, failed } = acceptanceChecks();

const dir = mkdtempSync(join(tmpdir(), "thermite-multigpu-"));
const token = randomBytes(24).toString("base64url");
const cleanup = () => {
  for (const n of names) spawnSync(engine, ["rm", "-f", n], { stdio: "ignore" });
  spawnSync(engine, ["rmi", "-f", image], { stdio: "ignore" });
  if (foreignNodesPossible())
    spawnSync(engine, ["machine", "ssh", `sudo rm -rf ${FOREIGN}`], { stdio: "ignore" });
  cleanEngine();
  rmSync(dir, { recursive: true, force: true });
};

/**
 * Whether this engine can show a container device nodes it can't regroup, as a GPU cloud that
 * runs containers in a user namespace does: rootless Podman on a machine VM, where files the VM's
 * root owns appear as nobody's and chown fails.
 */
function foreignNodesPossible() {
  if (engine !== "podman") return false;
  const info = spawnSync(engine, ["info", "--format", "{{.Host.Security.Rootless}}"], {
    encoding: "utf8",
  });
  if (info.stdout.trim() !== "true") return false;
  return spawnSync(engine, ["machine", "inspect"], { stdio: "ignore" }).status === 0;
}

/** Starts the harness on fake GPUs with these settings (the judge's and agents' lists, or a set). */
function start(name, gpuEnv, extra = []) {
  return sh([
    "run",
    "-d",
    "--name",
    name,
    "--cap-drop",
    "ALL",
    ...["CHOWN", "DAC_OVERRIDE", "FOWNER", "KILL", "SETGID", "SETUID"].flatMap((c) => [
      "--cap-add",
      c,
    ]),
    "--security-opt",
    "no-new-privileges",
    "-e",
    `THERMITE_RIG_ID=${name}`,
    "-e",
    "THERMITE_TARGET=cuda-gpu",
    "-e",
    "FAKE_GPUS=4",
    ...Object.entries(gpuEnv).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
    "-e",
    "THERMITE_CALIBRATION_BLOCKS=0",
    "-e",
    "THERMITE_CONTROL_PUBKEY_FILE=/keys/control-signing.pub",
    "-e",
    "THERMITE_SUPERVISOR_TOKEN_FILE=/run/secrets/harness-supervisor-token",
    "-e",
    `TEST_SUPERVISOR_TOKEN=${token}`,
    "-e",
    "PATH=/opt/fake-gpu:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    ...extra,
    "-v",
    `${join(dir, "keys")}:/keys:ro`,
    "-v",
    `${resolve("containers/test-gpu")}:/opt/fake-gpu:ro`,
    "--entrypoint",
    "/opt/fake-gpu/enter",
    image,
  ]).trim();
}

const logs = (name) => {
  const r = spawnSync(engine, ["logs", name], { encoding: "utf8" });
  return `${r.stdout}${r.stderr}`;
};
const logLines = (name, msg) =>
  logs(name)
    .split("\n")
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return undefined;
      }
    })
    .filter((l) => l?.msg === msg);
const logLine = (name, msg) => logLines(name, msg)[0];
/** The `nth` line (from 1) with this message, once it is there. */
async function waitFor(name, msg, ms = 180_000, nth = 1) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const l = logLines(name, msg)[nth - 1];
    if (l) return l;
    await sleep(2000);
  }
  throw new Error(`${name}: no "${msg}" (${nth}) in ${ms / 1000} s\n${logs(name).slice(-3000)}`);
}
const groupsOf = (name) =>
  sh([
    "exec",
    name,
    "stat",
    "-c",
    "%n %g",
    "/dev/nvidia0",
    "/dev/nvidia1",
    "/dev/nvidia2",
    "/dev/nvidia3",
  ])
    .trim()
    .replace(/\n/g, "; ");

try {
  mkdirSync(join(dir, "keys"));
  const { publicKey } = generateKeyPairSync("ed25519");
  writeFileSync(
    join(dir, "keys", "control-signing.pub"),
    publicKey.export({ type: "spki", format: "pem" }),
  );
  console.log("building the harness image ...");
  execFileSync(
    engine,
    ["build", "-q", "-t", image, "-f", "containers/harness/Containerfile", "."],
    {
      stdio: ["ignore", "ignore", "inherit"],
    },
  );

  // Two judge cards and two agents' cards.
  const a = names[0];
  start(a, { THERMITE_GPU_INDEX: "0,1", THERMITE_DEV_GPU_INDEX: "2,3" });
  const cards = await waitFor(a, "dedicated cards");
  check(
    "the broker set up two judge cards and two agents' cards",
    JSON.stringify(cards.judges) === JSON.stringify(["/dev/nvidia0", "/dev/nvidia1"]) &&
      JSON.stringify(cards.devs) === JSON.stringify(["/dev/nvidia2", "/dev/nvidia3"]),
    JSON.stringify(cards),
  );
  const groups = sh([
    "exec",
    a,
    "stat",
    "-c",
    "%n %g %a",
    "/dev/nvidia0",
    "/dev/nvidia1",
    "/dev/nvidia2",
    "/dev/nvidia3",
    "/dev/nvidiactl",
  ]).trim();
  check(
    "each card has its own group, the shared nodes gpuctl",
    groups ===
      [
        "/dev/nvidia0 10500 660",
        "/dev/nvidia1 10511 660",
        "/dev/nvidia2 10501 660",
        "/dev/nvidia3 10521 660",
        "/dev/nvidiactl 10502 660",
      ].join("\n"),
    groups.replace(/\n/g, "; "),
  );
  const run1 = sh(["exec", a, "id", "run-1"]).trim();
  check(
    "the second judge card's timing user",
    /uid=10031\(run-1\) gid=10511\(gpu-j1\)/.test(run1),
    run1,
  );
  const builder1 = sh(["exec", a, "id", "builder-1"]).trim();
  check(
    "the second judge card's builder",
    /uid=10021\(builder-1\) gid=10021\(builder-1\)/.test(builder1),
    builder1,
  );
  const ready = await waitFor(a, "judge ready");
  check("two judge executors", ready.judge_cards === 2, JSON.stringify(ready));
  const hw = logLine(a, "hardware");
  check(
    "the hardware report lists every card with its role",
    JSON.stringify(hw?.devices?.map((d) => d.split(":")[0])) ===
      JSON.stringify(["judge", "judge", "dev", "dev"]),
    JSON.stringify(hw?.devices),
  );
  const self = spawnSync(engine, ["exec", a, "thermite", "selftest", "isolation", "--force"], {
    encoding: "utf8",
  });
  let report;
  try {
    report = JSON.parse(self.stdout);
  } catch {
    report = { ok: false, error: `${self.stdout}${self.stderr}`.slice(-1500) };
  }
  check("the isolation selftest passes on every card", report.ok === true, report.devices ?? "");
  const roles = report.roles ?? {};
  check(
    "run-1 reaches only judge card 2",
    roles["run-1"]?.["device:nvidia1"] === "reachable" &&
      roles["run-1"]?.["device:nvidia0"]?.startsWith("EACCES") &&
      roles["run-1"]?.["device:nvidia3"]?.startsWith("EACCES") &&
      roles["run-1"]?.["visible-gpus"] === "sees GPU-00000000-0000-0000-0000-000000000001",
    JSON.stringify(roles["run-1"]),
  );
  check(
    "the second card's builder can't reach the first card's build under way",
    roles["builder-1"]?.["build-work"]?.startsWith("EACCES") &&
      roles["builder-1"]?.["builds-list"]?.startsWith("EACCES"),
    JSON.stringify(roles["builder-1"]),
  );
  check(
    "a dev run on the second agents' card reaches only that card",
    roles["lane-1+gpu@2"]?.["device:nvidia3"] === "reachable" &&
      roles["lane-1+gpu@2"]?.["device:nvidia2"]?.startsWith("EACCES") &&
      roles["lane-1+gpu@2"]?.["device:nvidia1"]?.startsWith("EACCES"),
    JSON.stringify(roles["lane-1+gpu@2"]),
  );
  check(
    "a lane's plain commands reach no card",
    Object.values(roles["lane-1"] ?? {}).every((v) => !String(v).startsWith("ALLOWED")) &&
      roles["lane-1"]?.["device:nvidia1"]?.startsWith("EACCES"),
    JSON.stringify(roles["lane-1"]),
  );
  // The smoke check's own kits and projects (/opt/thermite/checks): the controller's alone. Every
  // role, a lane's and an agent's users among them, must have probed them and been refused.
  const imageKits = [...new Set(["lane-1", "agent-1", ...Object.keys(roles)])].flatMap((role) =>
    ["image-checks-list", "image-kit-read"]
      .filter((p) => !/^E[A-Z]+$/.test(roles[role]?.[p] ?? ""))
      .map((p) => `${role} ${p}: ${roles[role]?.[p]}`),
  );
  check(
    "no role lists the image's own kits or reads one, on any card: only the harness does",
    imageKits.length === 0,
    imageKits.slice(0, 6).join("; "),
  );

  // Overlapping lists: refused, and the rig neither times nor allows dev runs.
  const b = names[1];
  start(b, { THERMITE_GPU_INDEX: "0,1", THERMITE_DEV_GPU_INDEX: "1,2" });
  const refused = await waitFor(b, "could not set up the dedicated development card");
  check("overlapping lists are refused", /both index 1/.test(refused.error ?? ""), refused.error);

  // A rig configured with its GPU set: the deployment's starting split, then a new one from the
  // rig's settings (as Edit rig or a campaign's deployment sends it), applied when the harness
  // restarts: the broker regroups the cards.
  const c = names[2];
  start(c, { THERMITE_GPUS: "0,1,2,3", THERMITE_JUDGE_GPUS: "1" });
  const first = await waitFor(c, "judge ready");
  check(
    "a GPU set starts with the deployment's split: one judge card, three agents' cards",
    first.judge_cards === 1 &&
      groupsOf(c) ===
        "/dev/nvidia0 10500; /dev/nvidia1 10501; /dev/nvidia2 10521; /dev/nvidia3 10522",
    groupsOf(c),
  );
  sh([
    "exec",
    c,
    "sh",
    "-c",
    `printf '{"judge_gpus":3}' > /var/lib/thermite/rig-settings.json && chmod 0644 /var/lib/thermite/rig-settings.json`,
  ]);
  // The controller exits to apply a new split (as it does when the setting changes).
  sh([
    "exec",
    c,
    "node",
    "-e",
    `const fs = require("fs"); for (const p of fs.readdirSync("/proc")) { if (!/^\\d+$/.test(p) || Number(p) === process.pid) continue; try { const argv = fs.readFileSync("/proc/" + p + "/cmdline", "utf8").split("\\0"); if ((argv[1] || "").endsWith("dist/harness/main.js")) process.kill(Number(p), "SIGTERM"); } catch {} }`,
  ]);
  const regrouped = await waitFor(c, "the rig's GPU split changed: regrouping the cards");
  const second = await waitFor(c, "judge ready", 180_000, 2);
  check(
    "a new split in the rig's settings regroups the cards at the next start: three judge cards, one agents' card",
    regrouped.judge === "0,1,2" &&
      second.judge_cards === 3 &&
      groupsOf(c) ===
        "/dev/nvidia0 10500; /dev/nvidia1 10511; /dev/nvidia2 10512; /dev/nvidia3 10501",
    groupsOf(c),
  );

  // Device nodes this container can't regroup, as on a GPU cloud that runs containers in a user
  // namespace: owned by a user the container doesn't map, mode 0666. The broker can't give them
  // to the gpu group; the GPU fence (Landlock) alone must keep every other role off them.
  if (foreignNodesPossible()) {
    const d = names[3];
    const nodes = ["nvidia0", "nvidiactl", "nvidia-uvm"];
    // podman machine ssh joins its arguments into one remote command line: quote it whole.
    const nodeList = nodes.join(" ");
    sh([
      "machine",
      "ssh",
      `sudo sh -c 'rm -rf ${FOREIGN} && mkdir -p ${FOREIGN} && cd ${FOREIGN} && touch ${nodeList} && chown 0:0 ${nodeList} && chmod 666 ${nodeList}'`,
    ]);
    start(
      d,
      { FAKE_GPUS: "1" },
      // SELinux labels off for this container only: the VM would otherwise refuse the files to
      // every process, and the test must show the fence alone refusing the roles.
      [
        "--security-opt",
        "label=disable",
        ...nodes.flatMap((n) => ["-v", `${FOREIGN}/${n}:/dev/${n}`]),
      ],
    );
    const only = await waitFor(
      d,
      "the GPU's device nodes kept their owner and mode: only the Landlock fence keeps roles off them",
    );
    const seen = sh(["exec", d, "stat", "-c", "%U %a", "/dev/nvidia0"]).trim();
    check(
      "nodes the container can't regroup (nobody's, 0666): the broker says only the fence holds",
      seen === "nobody 666" && only.landlock_abi > 0,
      `${seen}; ${JSON.stringify(only)}`,
    );
    await waitFor(d, "judge ready");
    const selfD = spawnSync(engine, ["exec", d, "thermite", "selftest", "isolation", "--force"], {
      encoding: "utf8",
    });
    let rd;
    try {
      rd = JSON.parse(selfD.stdout);
    } catch {
      rd = { ok: false, error: `${selfD.stdout}${selfD.stderr}`.slice(-1500) };
    }
    const fenced = ["builder", "lane-1", "agent-1"].map((r) => [
      r,
      rd.roles?.[r]?.["device:nvidia0"],
    ]);
    check(
      "the isolation selftest passes with the fence alone: no other role opens the GPU",
      rd.ok === true && fenced.every(([, v]) => String(v).startsWith("EACCES")),
      JSON.stringify(fenced),
    );
  } else {
    console.log("SKIP nodes a container can't regroup: needs rootless Podman on a machine VM");
  }
} catch (err) {
  check("the script ran to its end", false, err instanceof Error ? err.message : String(err));
} finally {
  cleanup();
}
console.log(failed() ? `multigpu acceptance: ${failed()} FAILED` : "multigpu acceptance: OK");
process.exit(failed() ? 1 : 0);
