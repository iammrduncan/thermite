import { chownSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  BrokerClient,
  builderRole,
  cardsOf,
  IDS,
  judgeCardOf,
  type Role,
  readLayout,
  runRole,
  SNAPSHOT_KEY_VAR,
  walk,
} from "../broker/index.ts";
import { copyForRun } from "../judge/index.ts";
import { isolationBusy } from "./busy.ts";
import {
  containerChecks,
  type OneContainerTargets,
  pidsRunning,
  SUPERVISOR_SCRIPT,
} from "./container.ts";
import { deviceProbes, deviceSide, isFailure, PROBE, type Probe } from "./probes.ts";
import {
  firstBaselineFile,
  firstBuildFile,
  firstInboxFile,
  firstKitFile,
  readsResearch,
  removeOwnTree,
  researchProbeFolder,
  sharedRecord,
} from "./targets.ts";

export { busyReason, callsBusy, isolationBusy } from "./busy.ts";
export {
  containerChecks,
  controlKeyCheck,
  enrollCodeCheck,
  type OneContainerTargets,
  oneContainerTargets,
  pidsRunning,
  platformInit,
  runpodCheck,
  setIdCheck,
  snapshotKeyCheck,
  stateSnapshotCheck,
  supervisorGpuCheck,
  supervisorUserCheck,
} from "./container.ts";
export { deviceProbes, isFailure, PROBE, type Probe } from "./probes.ts";
export { firstInboxFile, readsResearch, researchProbeFolder } from "./targets.ts";

/**
 * Isolation self-test, run as root inside the harness container (`thermite selftest
 * isolation`). For each role it asks the broker to run a probe as that role's user, which tries
 * to read, list or write what the role must not reach, the inbox and a file in it among them, in
 * every placement. Every probe must be refused, except a `readable` or `reachable` probe, which
 * must succeed. In the one-container rig image it also
 * checks the container as a whole (containerChecks): the supervisor's user, its GPU access,
 * set-id files, RunPod's variables, the enrollment code, in pull mode control's key, and the state
 * snapshot (THERMITE_STATE_SNAPSHOT_DIR): its folder holds nothing but sealed files, and only
 * root has its key. Each role probes the folder and the key too.
 *
 * Its parts are in selftest/: probes.ts (what each role probes, and the script it runs),
 * container.ts (the one-container image's checks), targets.ts (what the probes aim at) and busy.ts
 * (whether the rig is too busy to probe now).
 */

export interface IsolationReport {
  ok: boolean;
  /** "shared", or "dedicated" with the judge's and the development card's nodes. */
  devices: string;
  roles: Record<string, Record<string, string>>;
  /** The one-container rig image: checks of the container as a whole (containerChecks). */
  container?: Record<string, string>;
  skipped: string[];
}

function controllerPid(): number | undefined {
  return pidsRunning("dist/harness/main.js")[0];
}

/**
 * The roles probed by default: each judge card's builder and timing user, the planner's and the
 * model check's users, and lane 1's users (every lane's are made the same way).
 */
export function probedRoles(judgeCards = 1): Role[] {
  const more = Array.from({ length: Math.max(0, judgeCards - 1) }, (_, i) => i + 1);
  return [
    "builder",
    // Each further judge card's builder (goal 135) and timing user.
    ...more.map(builderRole),
    "run",
    ...more.map(runRole),
    "planner",
    "model-check",
    "lane-1",
    "lane-1-dev",
    "agent-1",
  ] as Role[];
}

export async function isolationSelftest(opts: {
  socketPath: string;
  stateDir: string;
  scratchDir: string;
  outboxDir: string;
  /** The inbox, which the supervisor fills for the controller alone. */
  inboxDir: string;
  secretFiles: string[];
  roles?: Role[];
  /** The rig is configured for a dedicated development card (THERMITE_DEV_GPU_INDEX). */
  dedicated?: boolean;
  /** Probe even while trials or judge jobs are live (they may be killed). */
  force?: boolean;
  /** The controller's pid, when the controller itself runs the selftest (a rig check). */
  controllerPid?: number;
  /** The one-container rig image (oneContainerTargets): the supervisor shares the container. */
  oneContainer?: OneContainerTargets | undefined;
  /** THERMITE_STATE_SNAPSHOT_DIR: no role may list the state's snapshot or write in it. */
  snapshotDir?: string | undefined;
}): Promise<IsolationReport> {
  const busy = opts.force ? undefined : isolationBusy(opts.stateDir);
  if (busy) throw new Error(`the rig is busy: ${busy}; rerun with --force to probe anyway`);
  const skipped: string[] = [];
  // First, as it waits for a supervisor that is still starting.
  const container = opts.oneContainer
    ? await containerChecks({
        brokerDir: dirname(opts.socketPath),
        skip: [opts.scratchDir],
        controlKey: opts.oneContainer.controlKey,
        snapshotDir: opts.snapshotDir,
      })
    : undefined;
  const probes: Probe[] = [
    { name: "ledger", op: "read", path: join(opts.stateDir, "ledger", "ledger.db") },
    { name: "state-list", op: "list", path: opts.stateDir },
    { name: "kits", op: "list", path: join(opts.stateDir, "kits") },
    { name: "git-mirrors", op: "list", path: join(opts.stateDir, "git") },
    { name: "models-list", op: "list", path: join(opts.stateDir, "models") },
    { name: "builds-list", op: "list", path: join(opts.stateDir, "builds") },
    // The folders a hill climb's kit check keeps with its baseline (goal 115): the judge's alone.
    { name: "baselines-list", op: "list", path: join(opts.stateDir, "baselines") },
    { name: "broker-socket", op: "access", path: opts.socketPath },
    { name: "outbox-write", op: "access", path: opts.outboxDir },
    { name: "outbox-read", op: "list", path: opts.outboxDir },
    { name: "inbox-list", op: "list", path: opts.inboxDir },
    { name: "runs-list", op: "list", path: join(opts.scratchDir, "thermite", "runs") },
    { name: "tmp-create", op: "create", path: "/tmp" },
    { name: "var-tmp-create", op: "create", path: "/var/tmp" },
    { name: "shm-create", op: "create", path: "/dev/shm" },
    // The container's first process holds what the container was started with (on RunPod, its
    // API key among it); nor may any process a role can read hold one of RunPod's variables.
    { name: "pid1-environ", op: "read", path: "/proc/1/environ" },
    { name: "runpod-variables", op: "runpod", path: "/proc" },
  ];
  const pod = opts.oneContainer;
  if (pod) {
    probes.push(
      { name: "supervisor-home", op: "list", path: pod.supervisorHome },
      { name: "supervisor-token", op: "read", path: pod.supervisorToken },
    );
    const sup = pidsRunning(SUPERVISOR_SCRIPT)[0];
    if (sup) probes.push({ name: "supervisor-environ", op: "read", path: `/proc/${sup}/environ` });
    else skipped.push("supervisor-environ (supervisor not found)");
    // Pull mode: the key the harness trusts for control's commands.
    if (pod.controlKey)
      probes.push({ name: "control-key-write", op: "access", path: pod.controlKey.file });
  }
  // The state's snapshot on the host's volume: closed to every role where the volume keeps
  // permissions; where it does not, it holds nothing but sealed files. No role has its key.
  if (opts.snapshotDir)
    probes.push(
      { name: "state-snapshot", op: "sealed", path: opts.snapshotDir },
      { name: "snapshot-key", op: "environ", path: "/proc", expect: SNAPSHOT_KEY_VAR },
    );
  // A file the supervisor fetched (a kit's bundle, say), reached by its full path.
  const fetched = firstInboxFile(opts.inboxDir);
  if (fetched) probes.push({ name: "inbox-read", op: "read", path: fetched });
  else skipped.push("inbox-read (nothing in the inbox yet)");
  const kitFile = firstKitFile(join(opts.stateDir, "kits"));
  if (kitFile) probes.push({ name: "kit-by-path", op: "read", path: kitFile });
  else skipped.push("kit-by-path (no kit checked out yet)");
  for (const f of opts.secretFiles) probes.push({ name: `secret:${f}`, op: "read", path: f });
  const build = firstBuildFile(join(opts.stateDir, "builds"));
  if (build) probes.push({ name: "build-overwrite", op: "write", path: build });
  else skipped.push("build-overwrite (no build yet)");
  const kept = firstBaselineFile(join(opts.stateDir, "baselines"));
  if (kept) probes.push({ name: "baseline-by-path", op: "read", path: kept });
  else skipped.push("baseline-by-path (no baseline kept a file yet)");
  // A run's copy of the kit's run.copy paths, made as the judge makes it and owned by the
  // controller's user: the run user reads it, and no role may change or add to it.
  const runKit = join(opts.scratchDir, "thermite", "selftest-run-kit");
  removeOwnTree(runKit);
  mkdirSync(join(runKit, "src", "run"), { recursive: true });
  writeFileSync(join(runKit, "src", "run", "driver.sh"), "#!/bin/sh\n", { mode: 0o755 });
  copyForRun(join(runKit, "src"), ["run"], join(runKit, "kit"));
  walk(join(runKit, "kit"), (p) => chownSync(p, IDS.thermite.uid, IDS.thermite.gid));
  const driver = join(runKit, "kit", "run", "driver.sh");
  probes.push(
    { name: "run-kit-write", op: "write", path: driver },
    { name: "run-kit-create", op: "create", path: join(runKit, "kit", "run") },
  );
  // A run's research folder, written as the harness writes one and owned by the controller's
  // user: no role may change a record or add one; the workers and the planner read it.
  const researchDir = join(opts.scratchDir, "thermite", "selftest-research");
  const research = researchProbeFolder(researchDir);
  walk(researchDir, (p) => chownSync(p, IDS.thermite.uid, IDS.thermite.gid));
  probes.push(
    { name: "research-write", op: "write", path: research.claim },
    { name: "research-create", op: "create", path: research.claims },
  );
  const pid = opts.controllerPid ?? controllerPid();
  if (pid) probes.push({ name: "controller-environ", op: "read", path: `/proc/${pid}/environ` });
  else skipped.push("controller-environ (controller not found)");
  const nodes = (existsSync("/dev") ? readdirSync("/dev") : [])
    .filter((d) => d.startsWith("nvidia") && !statSync(join("/dev", d)).isDirectory())
    .map((d) => join("/dev", d));
  // A dedicated development card is probed as the broker set it up; a failed setup fails here.
  const card = opts.dedicated ? readLayout(opts.socketPath) : {};
  const cards = card.layout ? cardsOf(card.layout) : undefined;
  // Shared mode: how the broker keeps roles off the nodes, or why it could not.
  const shared = opts.dedicated ? undefined : sharedRecord(opts.socketPath);
  const sharedError = shared && !shared.ok ? shared.error : undefined;
  const devices = cards
    ? `dedicated: judge ${cards.judges.map((c) => c.node).join(", ")}, development ${cards.devs.map((c) => c.node).join(", ")}`
    : card.error
      ? `dedicated, NOT SET UP: ${card.error}`
      : sharedError
        ? `shared, NOT SET UP: ${sharedError}`
        : shared?.ok && shared.fence
          ? `shared (fence: ${shared.fence})`
          : "shared";

  const client = new BrokerClient(opts.socketPath);
  // A build under way, handed to the first card's builder as the judge hands one over: no other
  // role may list it, another card's builder among them, as two cards build at once (goal 135).
  const buildWork = join(opts.scratchDir, "thermite", "selftest-build");
  removeOwnTree(buildWork);
  mkdirSync(join(buildWork, "src"), { recursive: true });
  await client.handOver(buildWork, "builder");
  const roles = opts.roles ?? probedRoles(cards?.judges.length ?? 1);
  // A lane's development run is the lane's user with the device group: probed as itself too,
  // once on each development card.
  const subjects = roles.flatMap((role) =>
    role === "lane-1"
      ? [
          { key: role, role, gpu: false, card: 0 },
          ...(cards?.devs ?? [undefined]).map((_, k) => ({
            key: k ? `lane-1+gpu@${k + 1}` : "lane-1+gpu",
            role,
            gpu: true,
            card: k,
          })),
        ]
      : [{ key: role as string, role, gpu: false, card: judgeCardOf(role) ?? 0 }],
  );
  const report: IsolationReport = {
    ok:
      card.error === undefined &&
      sharedError === undefined &&
      !Object.values(container ?? {}).some(isFailure),
    devices,
    roles: {},
    ...(container ? { container } : {}),
    skipped,
  };
  try {
    for (const { key, role, gpu, card: n } of subjects) {
      const cwd = join(opts.scratchDir, "thermite", `selftest-${key}`);
      mkdirSync(cwd, { recursive: true });
      await client.handOver(cwd, role);
      const mine = [...probes, ...deviceProbes(nodes, deviceSide(role, gpu), card.layout, n)];
      if (judgeCardOf(role) !== undefined)
        mine.push({ name: "run-kit-read", op: "readable", path: driver });
      if (readsResearch(role))
        mine.push({ name: "research-read", op: "readable", path: research.claim });
      if (role !== "builder") mine.push({ name: "build-work", op: "list", path: buildWork });
      const r = await client.run({
        role,
        argv: [process.execPath, "-e", PROBE, JSON.stringify(mine)],
        cwd,
        timeoutMs: 30_000,
        ...(gpu ? { gpu: true, ...(n ? { devCard: n } : {}) } : {}),
      });
      await client.remove(cwd);
      let results: Record<string, string>;
      try {
        results = JSON.parse(r.stdout) as Record<string, string>;
      } catch {
        results = { probe: `failed: exit ${r.exitCode} ${r.stderr.slice(-200)}` };
      }
      report.roles[key] = results;
      if (Object.values(results).some(isFailure)) report.ok = false;
    }
  } finally {
    await client.remove(buildWork).catch(() => {});
    client.close();
    removeOwnTree(runKit);
    removeOwnTree(researchDir);
  }
  return report;
}

/** A selftest's outcome in a sentence: what passed, or which probes a role got through. */
export function isolationSummary(report: IsolationReport): string {
  const bad = [
    ...Object.entries(report.container ?? {})
      .filter(([, v]) => isFailure(v))
      .map(([check, v]) => `container ${check}: ${v}`),
    ...Object.entries(report.roles).flatMap(([role, results]) =>
      Object.entries(results)
        .filter(([, v]) => isFailure(v))
        .map(([probe, v]) => `${role} ${probe}: ${v}`),
    ),
  ];
  const roles = Object.keys(report.roles).length;
  if (report.ok)
    return `isolation holds: every probe of ${roles} roles came out as it must (devices: ${report.devices})`;
  return `isolation does NOT hold (devices: ${report.devices}): ${bad.slice(0, 12).join("; ") || "the device setup failed"}`;
}
