import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { keySha256 } from "../../src/core/tunnel.ts";
import { type ControlRoute, ModelSource } from "../../src/harness/agents/index.ts";
import { SUPERVISOR_RECORD } from "../../src/harness/broker/one-container.ts";
import type { Role } from "../../src/harness/broker/runner.ts";
import {
  inspectSnapshotFolder,
  SEALED,
  SNAPSHOT_RECORD,
} from "../../src/harness/broker/snapshot/index.ts";
import {
  callsBusy,
  clusterApi,
  containerChecks,
  controlKeyCheck,
  enrollCodeCheck,
  firstInboxFile,
  type IsolationReport,
  isFailure,
  isolationBusy,
  isolationSummary,
  oneContainerTargets,
  PROBE,
  type Probe,
  platformInit,
  readsResearch,
  researchProbeFolder,
  rigSecretFiles,
  runpodCheck,
  setIdCheck,
  snapshotKeyCheck,
  stateSnapshotCheck,
  supervisorGpuCheck,
  supervisorUserCheck,
} from "../../src/harness/selftest/index.ts";

/** A made-up /proc: each process's parent, command line, ids and environment. */
function fakeProc(
  procs: {
    pid: number;
    ppid: number;
    argv?: string[];
    uid?: number;
    gid?: number;
    nnp?: boolean;
    env?: Record<string, string>;
    hidden?: boolean;
  }[],
): string {
  const dir = mkdtempSync(join(tmpdir(), "proc-"));
  for (const p of procs) {
    const d = join(dir, String(p.pid));
    mkdirSync(d);
    const u = p.uid ?? 0;
    const g = p.gid ?? 0;
    writeFileSync(
      join(d, "status"),
      `Name:\tnode\nPPid:\t${p.ppid}\nUid:\t${u}\t${u}\t${u}\t${u}\nGid:\t${g}\t${g}\t${g}\t${g}\nNoNewPrivs:\t${p.nnp ? 1 : 0}\n`,
    );
    writeFileSync(join(d, "cmdline"), `${(p.argv ?? ["sleep"]).join("\0")}\0`);
    const environ = join(d, "environ");
    writeFileSync(
      environ,
      `${Object.entries(p.env ?? {})
        .map(([k, v]) => `${k}=${v}`)
        .join("\0")}\0`,
    );
    if (p.hidden) chmodSync(environ, 0o000);
  }
  return dir;
}

const SUPERVISOR = ["/usr/local/bin/node", "/opt/thermite/dist/supervisor/main.js"];
const asRoot = process.getuid?.() === 0;

/** Runs the roles' probe script here, as this user, with these probes and this environment. */
function probe(probes: Probe[], env: Record<string, string> = {}): Record<string, string> {
  const r = spawnSync(process.execPath, ["-e", PROBE, JSON.stringify(probes)], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env },
  });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout) as Record<string, string>;
}

describe("when the isolation selftest waits", () => {
  test("a live planner call or model check makes it wait: a probe would kill its user's processes", () => {
    const planner = { uid: 10040 };
    const check = { uid: 10041 };
    const lane = { uid: 10101 };
    assert.equal(callsBusy([]), undefined);
    assert.equal(callsBusy([lane, { uid: 0 }]), undefined);
    assert.equal(
      callsBusy([planner]),
      "a planner call is running: wait for it to end (each probe kills its role's processes)",
    );
    assert.equal(
      callsBusy([check, planner]),
      "a planner call and a model check are running: wait for them to end (each probe kills its role's processes)",
    );
    // With no ledger yet, only the live calls count.
    const state = mkdtempSync(join(tmpdir(), "thermite-busy-"));
    assert.equal(
      isolationBusy(state, () => []),
      undefined,
    );
    assert.match(String(isolationBusy(state, () => [check])), /^a model check is running/);
  });
});

describe("the isolation selftest's results", () => {
  test("what fails it", () => {
    for (const v of [
      "ALLOWED",
      "UNREADABLE EACCES",
      "UNREACHABLE EACCES",
      "WRONG GPUS GPU-1",
      "WRONG USER: pid 9 has uids 0 0 0 0, gids 0 0 0 0",
      "FOUND RUNPOD_API_KEY (own)",
      "OPENED /dev/nvidia0",
      "MISSING: no supervisor process",
      "failed: exit 1",
    ])
      assert.equal(isFailure(v), true, v);
    for (const v of ["EACCES", "ENOENT", "readable", "reachable", "sees GPU-1", "none", "refused"])
      assert.equal(isFailure(v), false, v);
  });

  test("the summary names a failed container check", () => {
    const report: IsolationReport = {
      ok: false,
      devices: "shared (fence: landlock)",
      roles: { builder: { ledger: "EACCES" } },
      container: { "setid-files": "FOUND 1 set-id files: /usr/bin/su", "runpod-variables": "none" },
      skipped: [],
    };
    assert.equal(
      isolationSummary(report),
      "isolation does NOT hold (devices: shared (fence: landlock)): container setid-files: FOUND 1 set-id files: /usr/bin/su",
    );
    assert.equal(
      isolationSummary({ ...report, ok: true, container: {} }),
      "isolation holds: every probe of 1 roles came out as it must (devices: shared (fence: landlock))",
    );
  });
});

describe("the cluster's network in the isolation selftest", () => {
  test("it probes the API server Kubernetes names, and only on Kubernetes", () => {
    assert.equal(clusterApi({}), undefined);
    assert.deepEqual(clusterApi({ KUBERNETES_SERVICE_HOST: "api.cluster.test" }), {
      host: "api.cluster.test",
      port: "443",
    });
    assert.deepEqual(
      clusterApi({ KUBERNETES_SERVICE_HOST: "fd00::1", KUBERNETES_SERVICE_PORT: "6443" }),
      { host: "fd00::1", port: "6443" },
    );
  });

  test("a connection that is made fails it; a refused one passes", async () => {
    const server = createServer((s) => s.end());
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const { port } = server.address() as { port: number };
    const probes: Probe[] = [
      { name: "cluster-network", op: "connect", path: "127.0.0.1", expect: String(port) },
    ];
    const open = probe(probes)["cluster-network"] as string;
    assert.equal(open, `ALLOWED: connected to 127.0.0.1 port ${port}`);
    assert.equal(isFailure(open), true);
    await new Promise((done) => server.close(done));
    const closed = probe(probes)["cluster-network"] as string;
    assert.equal(closed, "ECONNREFUSED");
    assert.equal(isFailure(closed), false);
  });

  test("the summary says the cluster does not hold the rig's network rules", () => {
    const report: IsolationReport = {
      ok: false,
      devices: "shared",
      roles: {
        "lane-1": {
          ledger: "EACCES",
          "cluster-network": "ALLOWED: connected to api.cluster.test port 443",
        },
        builder: { ledger: "ALLOWED" },
      },
      skipped: [],
    };
    assert.equal(
      isolationSummary(report),
      "isolation does NOT hold (devices: shared): the cluster does not hold the rig's network rules: lane-1 reached the cluster's API server (ALLOWED: connected to api.cluster.test port 443); builder ledger: ALLOWED",
    );
  });
});

describe("the research folder the selftest probes", () => {
  test("is written as the harness writes a run's: every role reads it, only its owner changes it", () => {
    // Whoever runs the selftest (root's shell, say, with a stricter umask), the folder is written
    // under the controller's umask.
    const umask = process.umask(0o077);
    try {
      const base = mkdtempSync(join(tmpdir(), "research-probe-"));
      chmodSync(base, 0o755);
      const dir = join(base, "selftest-research");
      // What a role's create probe left there last time goes first.
      mkdirSync(join(dir, "claims"), { recursive: true });
      writeFileSync(join(dir, "claims", "probe-10101"), "x");
      const { claim, claims } = researchProbeFolder(dir);
      assert.equal(claims, join(dir, "claims"));
      assert.deepEqual(readdirSync(claims), ["c-selftest.md"]);
      assert.deepEqual(readdirSync(dir).sort(), ["INDEX.md", "claims"]);
      for (const p of [dir, claims, claim, join(dir, "INDEX.md")]) {
        const mode = statSync(p).mode;
        assert.equal(mode & 0o022, 0, `${p}: no one but its owner may write it`);
        assert.equal(mode & 0o004, 0o004, `${p}: every role may read it`);
      }
      assert.deepEqual(probe([{ name: "research-read", op: "readable", path: claim }]), {
        "research-read": "readable",
      });
      // As another user (root can start one): it reads the folder, and changes nothing in it.
      if (asRoot) {
        const r = spawnSync(
          process.execPath,
          [
            "-e",
            PROBE,
            JSON.stringify([
              { name: "research-read", op: "readable", path: claim },
              { name: "research-write", op: "write", path: claim },
              { name: "research-create", op: "create", path: claims },
            ]),
          ],
          { encoding: "utf8", uid: 65534, gid: 65534 },
        );
        assert.deepEqual(JSON.parse(r.stdout), {
          "research-read": "readable",
          "research-write": "EACCES",
          "research-create": "EACCES",
        });
      }
    } finally {
      process.umask(umask);
    }
  });

  test("the workers' users and the planner's must read it; the other roles are not asked to", () => {
    for (const role of ["lane-1", "lane-12", "agent-3", "planner"])
      assert.equal(readsResearch(role as Role), true, role);
    for (const role of ["builder", "run", "run-1", "model-check", "lane-1-dev"])
      assert.equal(readsResearch(role as Role), false, role);
  });
});

describe("the rig's secret files in the isolation selftest", () => {
  test("both routes control set, the tokens and the model key: one list for the rig check and the command line", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "thermite-state-"));
    const env = {
      THERMITE_SUPERVISOR_TOKEN_FILE: "/run/secrets/harness-supervisor-token",
      THERMITE_PROPOSER_TOKEN_FILE: "/run/secrets/harness-proposer-token",
      THERMITE_MODEL_API_KEY_FILE: "/run/secrets/model-api-key",
    };
    const files = rigSecretFiles(env, stateDir);
    assert.deepEqual(files.slice(2), Object.values(env));
    // The two routes are where the rig keeps them: the planner's beside the agents'.
    const route: ControlRoute = {
      name: "opencode",
      version: 3,
      base_url: "https://models.example/v1/",
      model: "m-1",
      context_window: 262144,
      max_tokens: 0,
      reasoning: "none",
      key_hint: "…0001",
      revision: "0123456789abcdef",
      api_key: "a-made-up-key",
    };
    const models = new ModelSource(String(files[0]), undefined);
    models.set(route);
    models.setPlanner(route);
    for (const f of files.slice(0, 2)) assert.ok(existsSync(f), `${f} is where a route is kept`);
    // In one container with the supervisor: the keys its tunnel signs with.
    assert.equal(
      rigSecretFiles({ THERMITE_TUNNEL_DIR: "/var/lib/tunnel" }, stateDir).at(-1),
      "/var/lib/tunnel/keys.json",
    );
  });
});

describe("the inbox in the isolation selftest", () => {
  test("a file in it is found by its full path, below its folders; an empty or missing inbox has none", () => {
    const inbox = mkdtempSync(join(tmpdir(), "inbox-probe-"));
    assert.equal(firstInboxFile(inbox), undefined);
    assert.equal(firstInboxFile(join(inbox, "missing")), undefined);
    mkdirSync(join(inbox, "repos"));
    mkdirSync(join(inbox, "models"));
    assert.equal(firstInboxFile(inbox), undefined);
    writeFileSync(join(inbox, "repos", "kit.bundle"), "a kit's bundle");
    assert.equal(firstInboxFile(inbox), join(inbox, "repos", "kit.bundle"));
  });

  test("in its closed folder, a bundle is read only by the controller's group, whatever its own mode", () => {
    // As the harness image has it: a folder of root's with the controller's group, mode 0750, and
    // the inbox mounted in it, its files open to every user.
    const base = mkdtempSync(join(tmpdir(), "inbox-closed-"));
    chmodSync(base, 0o755);
    const closed = join(base, "controller");
    const inbox = join(closed, "inbox");
    mkdirSync(join(inbox, "repos"), { recursive: true });
    chmodSync(closed, 0o750);
    const bundle = join(inbox, "repos", "kit.bundle");
    writeFileSync(bundle, "a kit's answers", { mode: 0o644 });
    const probes: Probe[] = [
      { name: "inbox-list", op: "list", path: inbox },
      { name: "inbox-read", op: "read", path: bundle },
    ];
    // Its owner and group (here: this user) reach it, as the controller does.
    assert.deepEqual(probe(probes), { "inbox-list": "ALLOWED", "inbox-read": "ALLOWED" });
    // Another user, as every role is: refused at the closed folder (root can start one).
    if (asRoot) {
      const r = spawnSync(process.execPath, ["-e", PROBE, JSON.stringify(probes)], {
        encoding: "utf8",
        uid: 65534,
        gid: 65534,
      });
      assert.deepEqual(JSON.parse(r.stdout), { "inbox-list": "EACCES", "inbox-read": "EACCES" });
    }
  });
});

describe("a role's probe for RunPod's variables", () => {
  test("none in its own environment or any it can read", () => {
    const proc = fakeProc([{ pid: 1, ppid: 0, env: { PATH: "/bin" } }]);
    const out = probe([{ name: "runpod-variables", op: "runpod", path: proc }]);
    assert.equal(out["runpod-variables"], "none");
  });

  test("found in its own environment", () => {
    const proc = fakeProc([{ pid: 1, ppid: 0 }]);
    const out = probe([{ name: "runpod-variables", op: "runpod", path: proc }], {
      RUNPOD_API_KEY: "made-up",
    });
    assert.equal(out["runpod-variables"], "FOUND RUNPOD_API_KEY (own)");
  });

  test("found in a process's environment it can read; one it cannot read is passed over", () => {
    const proc = fakeProc([
      { pid: 1, ppid: 0, env: { RUNPOD_POD_ID: "pod-1" }, hidden: !asRoot },
      { pid: 42, ppid: 1, env: { A: "1", RUNPOD_API_KEY: "made-up" } },
    ]);
    const out = probe([{ name: "runpod-variables", op: "runpod", path: proc }]);
    assert.equal(
      out["runpod-variables"],
      asRoot
        ? "FOUND RUNPOD_POD_ID (pid 1), RUNPOD_API_KEY (pid 42)"
        : "FOUND RUNPOD_API_KEY (pid 42)",
    );
  });

  test("a probe that cannot list the processes fails", () => {
    const out = probe([{ name: "runpod-variables", op: "runpod", path: "/no/such/proc" }]);
    assert.equal(out["runpod-variables"], "failed: ENOENT");
    assert.equal(isFailure(out["runpod-variables"] as string), true);
  });
});

describe("the one-container image's checks of the container", () => {
  test("they apply only with THERMITE_ONE_CONTAINER=1, to the supervisor's places", () => {
    assert.equal(oneContainerTargets({}), undefined);
    assert.deepEqual(
      oneContainerTargets({
        THERMITE_ONE_CONTAINER: "1",
        THERMITE_SUPERVISOR_HOME: "/workspace/thermite/supervisor",
        THERMITE_INBOX_DIR: "/workspace/thermite/inbox",
      }),
      {
        supervisorHome: "/workspace/thermite/supervisor",
        supervisorToken: "/workspace/thermite/supervisor/harness-token",
      },
    );
    // Pull mode: the key the harness trusts, and the SHA-256 the launch named.
    assert.deepEqual(
      oneContainerTargets({
        THERMITE_ONE_CONTAINER: "1",
        THERMITE_CONTROL_PUBKEY_FILE: "/etc/thermite/control-signing.pub",
        THERMITE_TUNNEL_CONTROL_KEY_SHA256: "a".repeat(64),
      })?.controlKey,
      { file: "/etc/thermite/control-signing.pub", sha256: "a".repeat(64) },
    );
  });

  test("the enrollment code: only root's processes and the supervisor's own may hold it", () => {
    const code = { THERMITE_TUNNEL_ENROLL_CODE: "c".repeat(64) };
    const clean = fakeProc([
      { pid: 1, ppid: 0, env: code },
      { pid: 2, ppid: 1, env: code },
      { pid: 7, ppid: 2, argv: SUPERVISOR, uid: 10001, gid: 10001, env: code },
      // What the supervisor starts, after taking the code out of its environment.
      { pid: 8, ppid: 7, uid: 10001, gid: 10001, env: { PATH: "/bin" } },
      { pid: 9, ppid: 2, uid: 10010, gid: 10010, env: { THERMITE_TUNNEL_DIR: "/t" } },
    ]);
    assert.equal(enrollCodeCheck(clean), "none (read 5 of 5 processes)");
    const leaked = fakeProc([
      { pid: 1, ppid: 0 },
      { pid: 9, ppid: 1, uid: 10010, gid: 10010, env: code },
      { pid: 11, ppid: 1, uid: 10001, gid: 10001, env: code },
      // The leaf node's key (a rig on RunPod), which the supervisor takes out of its environment too.
      { pid: 12, ppid: 1, uid: 10001, gid: 10001, env: { THERMITE_LEAF_KEY: "a2V5" } },
    ]);
    assert.equal(
      enrollCodeCheck(leaked),
      "FOUND pid 9 (uid 10010): THERMITE_TUNNEL_ENROLL_CODE; pid 11 (uid 10001): THERMITE_TUNNEL_ENROLL_CODE; pid 12 (uid 10001): THERMITE_LEAF_KEY",
    );
  });

  test("control's key for the harness: root's, closed to other writers, the launch's", () => {
    const me = process.getuid?.() ?? 0;
    const top = mkdtempSync(join(tmpdir(), "etc-"));
    chmodSync(top, 0o755);
    const dir = join(top, "thermite");
    mkdirSync(dir, { mode: 0o755 });
    const file = join(dir, "control-signing.pub");
    const keys = generateKeyPairSync("ed25519");
    const pem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
    const sha = keySha256(pem);
    const check = (s = sha, uid = me) => controlKeyCheck(file, s, { rootUid: uid, top });
    assert.match(check(), /^MISSING: /);
    writeFileSync(file, pem, { mode: 0o644 });
    assert.equal(check(), "root's, the key the launch named");
    assert.equal(check("0".repeat(64)), "WRONG: it is not the key the launch named by its SHA-256");
    assert.match(
      check(sha, me + 1),
      /^WRONG: .* is uid \d+, mode 644: another user could change it/,
    );
    chmodSync(file, 0o664);
    assert.match(check(), /^WRONG: .*control-signing.pub is uid \d+, mode 664/);
    chmodSync(file, 0o644);
    chmodSync(dir, 0o777);
    assert.match(check(), /^WRONG: .*thermite is uid \d+, mode 777/);
    chmodSync(dir, 0o755);
    assert.equal(isFailure(check()), false);
  });

  test("the supervisor runs as its own user with no_new_privs", async () => {
    const good = fakeProc([
      { pid: 1, ppid: 0 },
      { pid: 7, ppid: 1, argv: SUPERVISOR, uid: 10001, gid: 10001, nnp: true },
    ]);
    assert.equal(await supervisorUserCheck(good, 0), "uid 10001, gid 10001, no_new_privs");
    const asRootProc = fakeProc([{ pid: 7, ppid: 1, argv: SUPERVISOR, nnp: true }]);
    assert.match(await supervisorUserCheck(asRootProc, 0), /^WRONG USER: pid 7 has uids 0 0 0 0/);
    const mayGain = fakeProc([{ pid: 7, ppid: 1, argv: SUPERVISOR, uid: 10001, gid: 10001 }]);
    assert.match(await supervisorUserCheck(mayGain, 0), /^WRONG: pid 7 may gain privileges/);
    const none = fakeProc([{ pid: 1, ppid: 0 }]);
    assert.equal(await supervisorUserCheck(none, 0), "MISSING: no supervisor process");
  });

  test("the supervisor's GPU access, as the broker recorded it", () => {
    const dir = mkdtempSync(join(tmpdir(), "broker-"));
    assert.match(supervisorGpuCheck(dir), /^MISSING: no record from the broker/);
    const record = (gpu: string) =>
      writeFileSync(
        join(dir, SUPERVISOR_RECORD),
        JSON.stringify({ uid: 10001, gid: 10001, fence: "landlock", gpu, home: "/h", at: "x" }),
      );
    record("refused");
    assert.equal(supervisorGpuCheck(dir), "refused (fence: landlock)");
    record("no GPU node");
    assert.equal(supervisorGpuCheck(dir), "no GPU node (fence: landlock)");
    record("OPENED /dev/nvidia0");
    assert.equal(supervisorGpuCheck(dir), "OPENED /dev/nvidia0");
  });

  test("set-id files are found, outside the folders left out", () => {
    const root = mkdtempSync(join(tmpdir(), "root-"));
    mkdirSync(join(root, "usr", "bin"), { recursive: true });
    mkdirSync(join(root, "scratch"));
    writeFileSync(join(root, "usr", "bin", "plain"), "");
    assert.equal(setIdCheck(root), "none");
    writeFileSync(join(root, "scratch", "own"), "");
    chmodSync(join(root, "scratch", "own"), 0o4755);
    assert.equal(setIdCheck(root, [join(root, "scratch")]), "none");
    writeFileSync(join(root, "usr", "bin", "su"), "");
    chmodSync(join(root, "usr", "bin", "su"), 0o4755);
    assert.equal(
      setIdCheck(root, [join(root, "scratch")]),
      `FOUND 1 set-id files: ${join(root, "usr", "bin", "su")}`,
    );
    assert.match(setIdCheck(root), /^FOUND 2 set-id files/);
  });

  test("RunPod's variables in the rig's processes, not in a shell started from outside", () => {
    const clean = fakeProc([
      { pid: 1, ppid: 0, env: { PATH: "/bin" } },
      { pid: 10, ppid: 1, env: { THERMITE_POD_ID: "pod-1" } },
      // A shell opened with `exec` keeps the container's variables; it is not the rig's.
      { pid: 99, ppid: 0, env: { RUNPOD_API_KEY: "made-up" } },
    ]);
    assert.equal(runpodCheck(clean), "none (read 2 of 2 processes)");
    const leaked = fakeProc([
      { pid: 1, ppid: 0 },
      { pid: 10, ppid: 1 },
      { pid: 11, ppid: 10, env: { RUNPOD_API_KEY: "made-up" } },
    ]);
    assert.equal(runpodCheck(leaked), "FOUND RUNPOD_API_KEY (pid 11)");
  });

  test("a platform's own init at PID 1 keeps RunPod's variables; the rig's processes don't", () => {
    // RunPod runs an init of its own as PID 1; the image's entry point is its child.
    const onRunpod = fakeProc([
      { pid: 1, ppid: 0, env: { RUNPOD_API_KEY: "made-up", RUNPOD_POD_ID: "pod-1" } },
      { pid: 10, ppid: 1, env: { THERMITE_TUNNEL_POD: "pod-1" } },
      { pid: 11, ppid: 10, env: { PATH: "/bin" } },
    ]);
    symlinkSync("/sbin/docker-init", join(onRunpod, "1", "exe"));
    assert.equal(platformInit(onRunpod), "/sbin/docker-init");
    assert.equal(
      runpodCheck(onRunpod),
      "none (read 2 of 2 processes); PID 1 is the platform's own init (/sbin/docker-init), not the rig's, and keeps the container's first environment",
    );
    // A process the entry point started still counts.
    const leaked = fakeProc([
      { pid: 1, ppid: 0, env: { RUNPOD_API_KEY: "made-up" } },
      { pid: 10, ppid: 1, env: { RUNPOD_API_KEY: "made-up" } },
    ]);
    symlinkSync("/sbin/docker-init", join(leaked, "1", "exe"));
    assert.equal(runpodCheck(leaked), "FOUND RUNPOD_API_KEY (pid 10)");
    // PID 1 as the image's own tini is the rig's: its variables count.
    const ownInit = fakeProc([{ pid: 1, ppid: 0, env: { RUNPOD_API_KEY: "made-up" } }]);
    symlinkSync("/usr/bin/tini", join(ownInit, "1", "exe"));
    assert.equal(platformInit(ownInit), undefined);
    assert.equal(runpodCheck(ownInit), "FOUND RUNPOD_API_KEY (pid 1)");
  });

  test("all of them together, as the selftest reports them", async () => {
    const proc = fakeProc([
      { pid: 1, ppid: 0 },
      { pid: 7, ppid: 1, argv: SUPERVISOR, uid: 10001, gid: 10001, nnp: true },
    ]);
    const broker = mkdtempSync(join(tmpdir(), "broker-"));
    writeFileSync(
      join(broker, SUPERVISOR_RECORD),
      JSON.stringify({ uid: 10001, gid: 10001, fence: "none", gpu: "no GPU node" }),
    );
    const root = mkdtempSync(join(tmpdir(), "root-"));
    const checks = await containerChecks({
      brokerDir: broker,
      procDir: proc,
      rootDir: root,
      waitMs: 0,
    });
    const { "file-capabilities": caps, ...others } = checks;
    assert.match(String(caps), /^none/);
    assert.deepEqual(others, {
      "supervisor-user": "uid 10001, gid 10001, no_new_privs",
      "supervisor-gpu": "no GPU node (fence: none)",
      "setid-files": "none",
      "runpod-variables": "none (read 2 of 2 processes)",
      "enroll-code": "none (read 2 of 2 processes)",
    });
    assert.equal(Object.values(checks).some(isFailure), false);
    // Pull mode adds the key the harness trusts: here missing, which fails the selftest.
    const pull = await containerChecks({
      brokerDir: broker,
      procDir: proc,
      rootDir: root,
      waitMs: 0,
      controlKey: { file: join(root, "control-signing.pub"), sha256: "a".repeat(64) },
    });
    assert.match(pull["control-key"] ?? "", /^MISSING: /);
    assert.equal(isFailure(pull["control-key"] ?? ""), true);
    // A rig that keeps a snapshot of its state adds its folder, where no record yet fails, and
    // its key, which only root's processes may hold.
    const kept = await containerChecks({
      brokerDir: broker,
      procDir: proc,
      rootDir: root,
      waitMs: 0,
      snapshotDir: "/workspace/thermite",
    });
    assert.match(kept["state-snapshot"] ?? "", /^MISSING: no record from the broker/);
    assert.equal(kept["snapshot-key"], "none (read 2 of 2 processes)");
  });
});

describe("the state snapshot in the isolation check", () => {
  const record = (
    brokerDir: string,
    r: { users: Record<string, string>; closed: boolean; sealed?: boolean; off?: string },
  ) =>
    writeFileSync(
      join(brokerDir, SNAPSHOT_RECORD),
      JSON.stringify({ dir: "/no/such/volume", owner: "0:0", mode: "700", sealed: true, ...r }),
    );
  const refused = {
    thermite: "refused (EACCES)",
    supervisor: "refused (EACCES)",
    "agent-1": "refused (EACCES)",
  };
  const opened = {
    thermite: "OPENED: lists it and writes in it",
    supervisor: "OPENED: lists it and writes in it",
    "agent-1": "OPENED: lists it and writes in it",
  };
  /** A snapshot folder as sealing leaves it: the manifest and `n` sealed files. */
  const sealedFolder = (n: number) => {
    const dir = mkdtempSync(join(tmpdir(), "volume-"));
    writeFileSync(join(dir, SEALED.manifest), `THMSEAL1M${"x".repeat(40)}`);
    for (let i = 0; i < n; i++)
      writeFileSync(join(dir, String(i).repeat(64).slice(0, 64)), `THMSEAL1B${"y".repeat(40)}`);
    return dir;
  };

  test("the folder: sealed and closed, sealed and open, or no key; plaintext or another name fails", () => {
    const broker = mkdtempSync(join(tmpdir(), "broker-"));
    assert.match(stateSnapshotCheck(broker), /^MISSING: no record from the broker/);
    // Closed to every user, and to this process: what it holds can't be seen, and needn't be.
    record(broker, { users: refused, closed: true });
    const closed = stateSnapshotCheck(broker, "/no/such/volume");
    assert.equal(closed, "sealed, closed to thermite, supervisor, agent-1 (owner 0:0, mode 700)");
    assert.equal(isFailure(closed), false);
    // Seen from root: only sealed files.
    const dir = sealedFolder(2);
    assert.equal(
      stateSnapshotCheck(broker, dir),
      "sealed, closed to thermite, supervisor, agent-1 (owner 0:0, mode 700); holds the manifest and 2 sealed files",
    );
    // A volume that lets every user in, as RunPod's does: open, sealed, not a failure.
    record(broker, { users: opened, closed: false });
    const open = stateSnapshotCheck(broker, dir);
    assert.equal(
      open,
      "open, sealed: thermite lists it and writes in it; supervisor lists it and writes in it; agent-1 lists it and writes in it (owner 0:0, mode 700); holds the manifest and 2 sealed files",
    );
    assert.equal(isFailure(open), false);
    // A plaintext file, an unsealed snapshot an older image left, or another name: it fails.
    writeFileSync(join(dir, "a".repeat(64)), '{"sign":"private"}');
    const plain = stateSnapshotCheck(broker, dir);
    assert.equal(plain, `FOUND a file that is not sealed: ${"a".repeat(64)}`);
    assert.equal(isFailure(plain), true);
    rmSync(join(dir, "a".repeat(64)));
    mkdirSync(join(dir, "snapshot"));
    assert.equal(
      stateSnapshotCheck(broker, dir),
      "FOUND an unsealed snapshot an older image left: snapshot",
    );
    rmSync(join(dir, "snapshot"), { recursive: true });
    // No key from the launch: nothing is written there, which is no failure; the log says why.
    record(broker, {
      users: opened,
      closed: false,
      sealed: false,
      off: "the launch gave no THERMITE_STATE_SNAPSHOT_KEY",
    });
    const off = stateSnapshotCheck(broker, mkdtempSync(join(tmpdir(), "volume-")));
    assert.equal(
      off,
      "no snapshot: the launch gave no THERMITE_STATE_SNAPSHOT_KEY (owner 0:0, mode 700); holds no snapshot yet",
    );
    assert.equal(isFailure(off), false);
    // Root could not make the folder.
    record(broker, { users: { root: "failed: EROFS" }, closed: false, sealed: false });
    assert.equal(isFailure(stateSnapshotCheck(broker)), true);
  });

  test("the key: only root's processes may hold it", () => {
    const key = { THERMITE_STATE_SNAPSHOT_KEY: "k".repeat(43) };
    const clean = fakeProc([
      // PID 1 and the broker, root's, start with it; the broker's helper is root's too.
      { pid: 1, ppid: 0, env: key },
      { pid: 2, ppid: 1, env: key },
      { pid: 3, ppid: 2, env: { PATH: "/bin" } },
      { pid: 7, ppid: 2, argv: SUPERVISOR, uid: 10001, gid: 10001, env: { PATH: "/bin" } },
      { pid: 9, ppid: 2, uid: 10010, gid: 10010, env: { PATH: "/bin" } },
    ]);
    assert.equal(snapshotKeyCheck(clean), "none (read 5 of 5 processes)");
    const leaked = fakeProc([
      { pid: 1, ppid: 0, env: key },
      { pid: 7, ppid: 1, argv: SUPERVISOR, uid: 10001, gid: 10001, env: key },
      { pid: 9, ppid: 1, uid: 10010, gid: 10010, env: key },
    ]);
    const found = snapshotKeyCheck(leaked);
    assert.equal(
      found,
      "FOUND THERMITE_STATE_SNAPSHOT_KEY in pid 7 (uid 10001), pid 9 (uid 10010)",
    );
    assert.equal(isFailure(found), true);
  });

  test("a role's probes: the folder refused, or open and sealed; the key in no environment it can read", () => {
    const dir = sealedFolder(3);
    const out = probe([{ name: "state-snapshot", op: "sealed", path: dir }]);
    assert.equal(
      out["state-snapshot"],
      "open, sealed: lists it and writes in it; the manifest and 3 sealed files",
    );
    assert.equal(isFailure(out["state-snapshot"] as string), false);
    assert.deepEqual(
      readdirSync(dir).filter((n) => n.startsWith("probe-")),
      [],
      "its file goes",
    );
    if (!asRoot) {
      chmodSync(dir, 0o000);
      const shut = probe([{ name: "state-snapshot", op: "sealed", path: dir }]);
      chmodSync(dir, 0o700);
      assert.equal(shut["state-snapshot"], "EACCES");
    }
    // The role's look and the isolation check's agree, file for file.
    const cases: [string, string, boolean][] = [
      ["probe-10013", "", false],
      [`.new-${"c".repeat(32)}`, "", false],
      ["probe-10014", "x", true],
      ["d".repeat(64), "plain text", true],
      [SEALED.next, `THMSEAL1B${"z".repeat(30)}`, true],
      ["notes.txt", "", true],
    ];
    for (const [name, content, fails] of cases) {
      writeFileSync(join(dir, name), content);
      const role = probe([{ name: "state-snapshot", op: "sealed", path: dir }])["state-snapshot"];
      const look = inspectSnapshotFolder(dir);
      assert.equal(role?.startsWith("FOUND "), fails, `${name}: ${role}`);
      assert.equal(role, look.problem ? `FOUND ${look.problem}` : role, name);
      rmSync(join(dir, name));
    }
    // The key: in its own environment, or in any process environment it can read.
    const proc = fakeProc([
      { pid: 1, ppid: 0, env: { PATH: "/bin" } },
      { pid: 42, ppid: 1, env: { THERMITE_STATE_SNAPSHOT_KEY: "k".repeat(43) } },
    ]);
    const probeKey: Probe = {
      name: "snapshot-key",
      op: "environ",
      path: proc,
      expect: "THERMITE_STATE_SNAPSHOT_KEY",
    };
    assert.equal(probe([probeKey])["snapshot-key"], "FOUND THERMITE_STATE_SNAPSHOT_KEY (pid 42)");
    assert.equal(
      probe([{ ...probeKey, path: fakeProc([{ pid: 1, ppid: 0 }]) }], {
        THERMITE_STATE_SNAPSHOT_KEY: "k",
      })["snapshot-key"],
      "FOUND THERMITE_STATE_SNAPSHOT_KEY (own)",
    );
    assert.equal(
      probe([{ ...probeKey, path: fakeProc([{ pid: 1, ppid: 0 }]) }])["snapshot-key"],
      "none",
    );
  });
});
