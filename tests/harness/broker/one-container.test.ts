import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { restartAfter } from "../../../src/common/restart.ts";
import { SUPERVISOR_PASSWD_HOME } from "../../../src/core/paths.ts";
import { generateBoxKeys, keySha256, publicKeyLine } from "../../../src/core/tunnel.ts";
import {
  ENROLLED_MAX_BYTES,
  isRootOnly,
  isRunpodVariable,
  isSupervisorOnly,
  OPEN_NODES_JS,
  oneContainer,
  parseRigEnv,
  pullMode,
  readEnrollment,
  readSupervisorFile,
  supervisorArgv,
  supervisorEnv,
  supervisorGpu,
  supervisorPaths,
  withoutRunpod,
  writeControlKey,
} from "../../../src/harness/broker/one-container.ts";
import { pullModeOptions } from "../../../src/supervisor/tunnel-pod.ts";

// RunPod's variables as the first spike found them (names only; the values are made up).
const RUNPOD = {
  RUNPOD_API_KEY: "made-up-key",
  RUNPOD_CPU_COUNT: "8",
  RUNPOD_DC_ID: "dc-1",
  RUNPOD_GPU_COUNT: "1",
  RUNPOD_GPU_NAME: "a gpu",
  RUNPOD_MEM_GB: "31",
  RUNPOD_POD_HOSTNAME: "pod-1-host",
  RUNPOD_POD_ID: "pod-1",
};
const SECRET_VARS = ["THERMITE_SUPERVISOR_TOKEN_FILE", "THERMITE_PROPOSER_TOKEN_FILE"];

describe("the one-container rig image", () => {
  test("only THERMITE_ONE_CONTAINER=1 turns it on", () => {
    assert.equal(oneContainer({ THERMITE_ONE_CONTAINER: "1" }), true);
    assert.equal(oneContainer({ THERMITE_ONE_CONTAINER: "0" }), false);
    assert.equal(oneContainer({}), false);
  });

  test("RunPod's variables and the snapshot key are left out of an environment", () => {
    assert.equal(isRunpodVariable("RUNPOD_API_KEY"), true);
    assert.equal(isRunpodVariable("THERMITE_TUNNEL_POD"), false);
    assert.equal(isRootOnly("THERMITE_STATE_SNAPSHOT_KEY"), true);
    assert.equal(isRootOnly("THERMITE_STATE_SNAPSHOT_DIR"), false);
    const env = withoutRunpod({
      ...RUNPOD,
      PATH: "/bin",
      GONE: undefined,
      THERMITE_STATE_SNAPSHOT_KEY: "k".repeat(43),
    });
    assert.deepEqual(env, { PATH: "/bin" });
  });

  test("the supervisor gets its own places and none of RunPod's or the harness's secrets", () => {
    const base = {
      ...RUNPOD,
      PATH: "/usr/bin",
      THERMITE_RIG_ID: "rig-1",
      THERMITE_TUNNEL_POD: "pod-1",
      THERMITE_TUNNEL_ENROLL_CODE: "c".repeat(64),
      THERMITE_SUPERVISOR_HOME: "/workspace/thermite/supervisor",
      THERMITE_INBOX_DIR: "/workspace/thermite/inbox",
      THERMITE_SUPERVISOR_TOKEN_FILE: "/workspace/thermite/secrets/supervisor-token",
      THERMITE_PROPOSER_TOKEN_FILE: "/run/secrets/proposer",
      // Root's alone, should the broker ever still hold it when it starts the supervisor.
      THERMITE_STATE_SNAPSHOT_KEY: "k".repeat(43),
      HOME: "/root",
    };
    const paths = supervisorPaths(base);
    assert.deepEqual(paths, {
      home: "/workspace/thermite/supervisor",
      tmp: "/workspace/thermite/supervisor/tmp",
      inbox: "/workspace/thermite/inbox",
      tokenFile: "/workspace/thermite/supervisor/harness-token",
      advisorRuns: "/workspace/thermite/thermite-advisors",
    });
    const env = supervisorEnv(base, paths, SECRET_VARS);
    assert.deepEqual(
      Object.keys(env).filter((k) => k.startsWith("RUNPOD_")),
      [],
    );
    assert.equal(env.THERMITE_SUPERVISOR_TOKEN_FILE, undefined);
    assert.equal(env.THERMITE_PROPOSER_TOKEN_FILE, undefined);
    assert.equal(env.THERMITE_STATE_SNAPSHOT_KEY, undefined);
    assert.equal(env.THERMITE_HARNESS_TOKEN_FILE, paths.tokenFile);
    assert.equal(env.HOME, SUPERVISOR_PASSWD_HOME);
    assert.equal(env.TMPDIR, paths.tmp);
    assert.equal(env.USER, "supervisor");
    assert.equal(env.THERMITE_RIG_ID, "rig-1");
    // The advisors' runner the broker serves, and where the supervisor makes each run's folder.
    assert.equal(env.THERMITE_ADVISOR_SOCKET, "/run/thermite-advisors/runs.sock");
    assert.equal(env.THERMITE_ADVISOR_RUNS_DIR, paths.advisorRuns);
    // Pull mode's launch values are the supervisor's: the code is spent at its enrollment.
    assert.equal(env.THERMITE_TUNNEL_POD, "pod-1");
    assert.equal(env.THERMITE_TUNNEL_ENROLL_CODE, "c".repeat(64));
    // Defaults: the supervisor image's places.
    assert.equal(supervisorPaths({}).home, "/var/lib/thermite-supervisor");
    assert.equal(supervisorPaths({}).inbox, "/inbox");
    assert.equal(supervisorPaths({}).advisorRuns, "/var/lib/thermite-advisors");
  });

  test("the supervisor starts with no_new_privs, in the GPU fence where there is one", () => {
    const cmd = ["/usr/local/bin/node", "/opt/thermite/dist/supervisor/main.js"];
    assert.deepEqual(supervisorArgv(cmd, { setpriv: "/usr/bin/setpriv", fence: "/f" }), [
      "/usr/bin/setpriv",
      "--no-new-privs",
      "--",
      "/f",
      "--",
      ...cmd,
    ]);
    assert.deepEqual(supervisorArgv(cmd, { setpriv: "/usr/bin/setpriv", fence: undefined }), [
      "/usr/bin/setpriv",
      "--no-new-privs",
      "--",
      ...cmd,
    ]);
    assert.throws(() => supervisorArgv(cmd, { setpriv: undefined, fence: "/f" }), /setpriv/);
  });

  test("the supervisor's GPU probe: refused, opened, no node, or failed", () => {
    const answer =
      (stdout: string, status = 0) =>
      () => ({ status, stdout, stderr: "boom" });
    assert.equal(supervisorGpu([], "node", answer("[]")), "no GPU node");
    assert.equal(supervisorGpu(["/dev/nvidia0"], "node", answer("[]")), "refused");
    assert.equal(
      supervisorGpu(["/dev/nvidia0", "/dev/nvidiactl"], "node", answer('["/dev/nvidia0"]')),
      "OPENED /dev/nvidia0",
    );
    assert.match(supervisorGpu(["/dev/nvidia0"], "node", answer("", 126)), /^failed: exit 126/);
    assert.match(supervisorGpu(["/dev/nvidia0"], "node", answer("{}")), /^failed/);
  });

  test("the GPU probe's script opens what it may and reports only that", () => {
    const dir = mkdtempSync(join(tmpdir(), "rig-gpu-"));
    const open = join(dir, "nvidia0");
    const closed = join(dir, "nvidia1");
    writeFileSync(open, "");
    writeFileSync(closed, "");
    chmodSync(closed, 0o000);
    const got = supervisorGpu([open, closed, join(dir, "missing")], process.execPath, (c) => {
      const r = spawnSync(c[0] as string, c.slice(1), { encoding: "utf8" });
      return { status: r.status, stdout: r.stdout, stderr: r.stderr };
    });
    // Root opens a file whatever its mode: then both show.
    assert.equal(got, process.getuid?.() === 0 ? `OPENED ${open}, ${closed}` : `OPENED ${open}`);
    assert.ok(OPEN_NODES_JS.includes("r+"), "it opens each node for reading and writing");
  });

  test("a part that exits soon waits longer each time, up to 30 seconds", () => {
    let r = 0;
    const delays: number[] = [];
    for (let i = 0; i < 7; i++) {
      const next = restartAfter(1000, r);
      r = next.restarts;
      delays.push(next.delayMs);
    }
    assert.deepEqual(delays, [2000, 4000, 8000, 16000, 30000, 30000, 30000]);
    // After a long run it starts again after a second.
    assert.deepEqual(restartAfter(120_000, 5), { restarts: 0, delayMs: 1000 });
  });
});

describe("pull mode in the one-container image: what root takes from enrollment", () => {
  const me = process.getuid?.() ?? 0;
  const pem = (type: "ed25519" | "x25519" = "ed25519") =>
    generateKeyPairSync(type as "ed25519")
      .publicKey.export({ type: "spki", format: "pem" })
      .toString();
  const control = pem();
  /** The files as the supervisor writes them (src/supervisor/tunnel-pod.ts). */
  const enrolled = (files: { key?: string; env?: string }) => {
    const dir = mkdtempSync(join(tmpdir(), "enrolled-"));
    if (files.env !== undefined) writeFileSync(join(dir, "rig.env"), files.env);
    if (files.key !== undefined) writeFileSync(join(dir, "control.pub"), files.key);
    return dir;
  };
  const read = (dir: string, sha = keySha256(control)) =>
    readEnrollment({ dir, rig: "rp-1a2b3c4d", controlKeySha256: sha, owner: me });
  const ENV = "THERMITE_RIG_ID=rp-1a2b3c4d\nTHERMITE_TARGET=cuda-gpu\nTHERMITE_GPUS=0,1\n";

  test("pull mode is THERMITE_TUNNEL_PORT; its launch values reach the supervisor alone", () => {
    assert.equal(pullMode({ THERMITE_TUNNEL_PORT: "8790" }), true);
    assert.equal(pullMode({ THERMITE_TUNNEL_PORT: "" }), false);
    assert.equal(pullMode({}), false);
    for (const k of [
      "THERMITE_TUNNEL_ENROLL_CODE",
      "THERMITE_TUNNEL_PREFIX",
      "THERMITE_TUNNEL_PORT",
      "THERMITE_TUNNEL_CONTROL_BOX",
      "THERMITE_TUNNEL_POD",
      "THERMITE_TUNNEL_ENROLLED_DIR",
    ])
      assert.equal(isSupervisorOnly(k), true, k);
    // The controller's isolation check reads these two; neither is secret.
    assert.equal(isSupervisorOnly("THERMITE_TUNNEL_DIR"), false);
    assert.equal(isSupervisorOnly("THERMITE_TUNNEL_CONTROL_KEY_SHA256"), false);
    assert.equal(isSupervisorOnly("THERMITE_RIG_ID"), false);
  });

  test("waiting until control.pub is there; then ready, with the settings by name", () => {
    assert.deepEqual(read(enrolled({})), { state: "waiting" });
    assert.deepEqual(read(enrolled({ env: ENV })), { state: "waiting" });
    assert.deepEqual(read(enrolled({ key: control, env: ENV })), {
      state: "ready",
      controlKeyPem: control,
      settings: { THERMITE_TARGET: "cuda-gpu", THERMITE_GPUS: "0,1" },
    });
    // The launch's hash may come in capitals.
    assert.equal(
      read(enrolled({ key: control, env: ENV }), keySha256(control).toUpperCase()).state,
      "ready",
    );
  });

  test("a key other than the one the launch named is refused, whatever the supervisor writes", () => {
    const other = pem();
    assert.deepEqual(read(enrolled({ key: other, env: ENV })), {
      state: "refused",
      why: "control.pub is not the key the launch named by its SHA-256",
    });
    assert.match(
      (read(enrolled({ key: pem("x25519"), env: ENV })) as { why: string }).why,
      /not an Ed25519 public key/,
    );
    assert.match(
      (read(enrolled({ key: "junk", env: ENV })) as { why: string }).why,
      /not a public key/,
    );
    assert.deepEqual(read(enrolled({ key: control })), {
      state: "refused",
      why: "rig.env is missing",
    });
  });

  test("rig.env is data: only the settings control gives, each once, with plain values", () => {
    const rig = "rp-1a2b3c4d";
    assert.deepEqual(parseRigEnv(`THERMITE_RIG_ID=${rig}\n`, rig), { settings: {} });
    assert.deepEqual(parseRigEnv(`\nTHERMITE_RIG_ID=${rig}\n\nTHERMITE_MAX_TRIALS=4\n`, rig), {
      settings: { THERMITE_MAX_TRIALS: "4" },
    });
    const refused = (text: string) => (parseRigEnv(text, rig) as { refused?: string }).refused;
    // Names a launch can't give: the broker's own places, a secret's file, the loader.
    for (const line of [
      "THERMITE_STATE_DIR=/tmp/x",
      "THERMITE_CONTROL_PUBKEY_FILE=/tmp/key",
      "LD_PRELOAD=/tmp/x.so",
      "PATH=/tmp",
      "export THERMITE_TARGET=cpu",
      "=cpu",
      "THERMITE_TARGET",
    ])
      assert.match(
        refused(`THERMITE_RIG_ID=${rig}\n${line}\n`) ?? "",
        /line 2 is not a setting/,
        line,
      );
    // Values a shell would expand, or that are not one plain word.
    for (const value of ["$(id)", "`id`", "a b", "cpu;id", "", "x".repeat(101)])
      assert.match(
        refused(`THERMITE_RIG_ID=${rig}\nTHERMITE_TARGET=${value}\n`) ?? "",
        /THERMITE_TARGET is not letters, digits/,
        value,
      );
    assert.match(
      refused(`THERMITE_RIG_ID=${rig}\nTHERMITE_GPUS=0\nTHERMITE_GPUS=1\n`) ?? "",
      /twice/,
    );
    assert.match(refused("THERMITE_RIG_ID=rp-other\n") ?? "", /not for this rig/);
    assert.match(refused("THERMITE_TARGET=cpu\n") ?? "", /not for this rig/);
  });

  test("files root reads must be the supervisor's own plain files, not links, FIFOs or large", () => {
    const dir = mkdtempSync(join(tmpdir(), "enrolled-"));
    writeFileSync(join(dir, "plain"), "x");
    assert.deepEqual(readSupervisorFile(join(dir, "plain"), me), { text: "x" });
    assert.deepEqual(readSupervisorFile(join(dir, "none"), me), { missing: true });
    assert.deepEqual(readSupervisorFile(join(dir, "plain"), me + 1), {
      refused: `it belongs to uid ${me}, not the supervisor`,
    });
    // A link to a file only root may read (here: any file) is not followed.
    symlinkSync(join(dir, "plain"), join(dir, "link"));
    assert.deepEqual(readSupervisorFile(join(dir, "link"), me), { refused: "it is a link" });
    // A FIFO with no writer would block a plain read for ever.
    const fifo = join(dir, "fifo");
    if (spawnSync("mkfifo", [fifo]).status === 0)
      assert.deepEqual(readSupervisorFile(fifo, me), { refused: "it is not a plain file" });
    mkdirSync(join(dir, "folder"));
    assert.deepEqual(readSupervisorFile(join(dir, "folder"), me), {
      refused: "it is not a plain file",
    });
    writeFileSync(join(dir, "large"), "x".repeat(ENROLLED_MAX_BYTES + 1));
    assert.match(
      (readSupervisorFile(join(dir, "large"), me) as { refused: string }).refused,
      /larger than/,
    );
    // In readEnrollment, a linked control.pub is refused too.
    const linked = enrolled({ env: ENV });
    writeFileSync(join(linked, "real.pub"), control);
    symlinkSync(join(linked, "real.pub"), join(linked, "control.pub"));
    assert.deepEqual(read(linked), { state: "refused", why: "control.pub: it is a link" });
  });

  test("root's copy of the key: written whole, mode 0644, in a folder of its own", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "etc-")), "thermite");
    const file = join(dir, "control-signing.pub");
    writeControlKey(file, control, me);
    assert.equal(readFileSync(file, "utf8"), control);
    assert.equal(statSync(file).mode & 0o777, 0o644);
    assert.equal(statSync(dir).mode & 0o777, 0o755);
    // Again: the new key replaces the old one whole.
    const next = pem();
    writeControlKey(file, next, me);
    assert.equal(readFileSync(file, "utf8"), next);
    // A folder of another user's is never written in.
    assert.throws(() => writeControlKey(file, control, me + 1), /not a folder of root's own/);
    // Nor is one that is a link.
    const linkDir = join(mkdtempSync(join(tmpdir(), "etc-")), "thermite");
    symlinkSync(dir, linkDir);
    assert.throws(
      () => writeControlKey(join(linkDir, "control-signing.pub"), control, me),
      /not a folder of root's own/,
    );
  });
});

describe("the entry point removes RunPod's variables", () => {
  const start = join(
    import.meta.dirname,
    "..",
    "..",
    "..",
    "containers",
    "rig",
    "thermite-rig-start",
  );
  // What the started program sees, exactly: its environment as JSON.
  const run = (env: Record<string, string>) => {
    const r = spawnSync(
      "/bin/sh",
      [start, process.execPath, "-e", "process.stdout.write(JSON.stringify(process.env))"],
      { encoding: "utf8", env },
    );
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout) as Record<string, string>;
  };

  test("no RUNPOD_ variable reaches what it starts; the pod's ID goes on as THERMITE_TUNNEL_POD", () => {
    const env = run({ PATH: "/usr/bin:/bin", ...RUNPOD, THERMITE_RIG_ID: "rig-1" });
    assert.deepEqual(
      Object.keys(env).filter((k) => k.startsWith("RUNPOD_")),
      [],
    );
    assert.equal(env.THERMITE_TUNNEL_POD, "pod-1");
    assert.equal(env.THERMITE_RIG_ID, "rig-1");
    // What pull mode reads: the supervisor finds its pod with RunPod's variable gone.
    const o = pullModeOptions(
      {
        ...env,
        THERMITE_TUNNEL_PORT: "8790",
        THERMITE_TUNNEL_PREFIX: "a".repeat(64),
        THERMITE_TUNNEL_CONTROL_KEY_SHA256: "b".repeat(64),
        THERMITE_TUNNEL_CONTROL_BOX: publicKeyLine(generateBoxKeys().boxPublicPem),
        THERMITE_TUNNEL_ENROLL_CODE: "c".repeat(64),
      },
      "rig-1",
      "/workspace/thermite/supervisor",
    );
    assert.equal(o?.pod, "pod-1");
  });

  test("a THERMITE_TUNNEL_POD given at launch stays, and none is made up without a pod", () => {
    assert.equal(
      run({ PATH: "/usr/bin:/bin", RUNPOD_POD_ID: "pod-1", THERMITE_TUNNEL_POD: "given" })
        .THERMITE_TUNNEL_POD,
      "given",
    );
    assert.equal(run({ PATH: "/usr/bin:/bin" }).THERMITE_TUNNEL_POD, undefined);
  });

  test("a value that looks like a RunPod line is left as it is", () => {
    const env = run({ PATH: "/usr/bin:/bin", NOTE: "x\nRUNPOD_FAKE=1", RUNPOD_API_KEY: "k" });
    assert.equal(env.RUNPOD_API_KEY, undefined);
    assert.equal(env.NOTE, "x\nRUNPOD_FAKE=1");
    assert.equal(env.RUNPOD_FAKE, undefined);
  });
});
