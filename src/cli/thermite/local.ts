import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { newToken } from "../../common/secrets.ts";
import { generateSigningKeys } from "../../core/commands.ts";
import { parseContract } from "../../core/contract.ts";
import { HARNESS_INBOX_DIR } from "../../core/paths.ts";
import {
  answeringEngines,
  doctor,
  doctorExit,
  formatReport,
  machineProbes,
} from "../doctor/index.ts";
import {
  chooseOwner,
  localInit,
  parentOwner,
  readStackCompose,
  writeGpuOverride,
} from "../local-init.ts";
import {
  containerEngine,
  detectInContainer,
  detectOnMachine,
  GPU_OVERRIDE,
  gpuOverride,
  harnessImageFrom,
  rigReport,
  upWithGpus,
} from "../machine.ts";
import { fail } from "./shared.ts";
import { USAGE } from "./usage.ts";

/**
 * The commands that need neither control nor a harness: the machine's checks, a contract's check,
 * keys and tokens, the local stack's folder and the harness container's isolation selftest.
 */

/** thermite doctor: check this machine. */
export async function thermiteDoctor(rest: string[]): Promise<void> {
  const { values } = parseArgs({
    args: rest,
    options: {
      control: { type: "string" },
      "model-url": { type: "string" },
      port: { type: "string" },
      json: { type: "boolean" },
    },
  });
  const port = values.port === undefined ? undefined : Number(values.port);
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535))
    fail("--port is a port number from 1 to 65535");
  const findings = await doctor(machineProbes(), {
    control: values.control?.replace(/\/+$/, ""),
    modelUrl: values["model-url"],
    port,
  });
  process.stdout.write(
    values.json
      ? `${JSON.stringify({ ok: doctorExit(findings) === 0, checks: findings }, null, 2)}\n`
      : formatReport(findings),
  );
  process.exitCode = doctorExit(findings);
}

/** thermite contract validate: check a contract and print its sha256. */
export function thermiteContract(rest: string[]): void {
  const [sub, file] = rest;
  if (sub !== "validate" || !file) fail(USAGE);
  const r = parseContract(JSON.parse(readFileSync(file, "utf8")));
  if (!r.ok) {
    process.stderr.write(`${r.errors.join("\n")}\n`);
    process.exit(1);
  }
  process.stdout.write(
    `ok ${r.contract.mode} ${r.contract.campaign} v${r.contract.version} sha256=${r.sha}\n`,
  );
  // Valid, but not yet runnable: say what an assignment will still need.
  if (r.contract.mode !== "research" && !r.contract.project.kit)
    process.stderr.write(
      "warning: no project.kit: the judge cannot measure this campaign until the contract names a kit repository and commit\n",
    );
}

/** thermite keys generate: a new control signing key pair. */
export function thermiteKeys(rest: string[]): void {
  const [sub, dir] = rest;
  if (sub !== "generate" || !dir) fail(USAGE);
  mkdirSync(dir, { recursive: true });
  const keys = generateSigningKeys();
  writeFileSync(join(dir, "control-signing.key"), keys.privateKeyPem, { mode: 0o600 });
  writeFileSync(join(dir, "control-signing.pub"), keys.publicKeyPem, { mode: 0o644 });
  process.stdout.write(`wrote ${dir}/control-signing.{key,pub}\n`);
}

/** thermite token new: a new control token, and its SHA-256. */
export function thermiteToken(rest: string[]): void {
  const [sub, ...args] = rest;
  const { values } = parseArgs({ args, options: { out: { type: "string" } } });
  if (sub !== "new" || !values.out) fail(USAGE);
  if (existsSync(values.out)) fail(`${values.out} exists; a token is never overwritten`);
  const t = newToken();
  writeFileSync(values.out, `${t.token}\n`, { mode: 0o600, flag: "wx" });
  process.stdout.write(
    `wrote the token to ${values.out}\nsha256 ${t.sha256}\nDeploy control with the hash as THERMITE_CONTROL_<ROLE>_TOKEN_SHA256, where ROLE is ADMIN (the owner), OPERATOR, AGENT or READ.\n`,
  );
}

/** thermite local init: the local compose stack's .dev folder. */
export async function thermiteLocal(rest: string[]): Promise<void> {
  const [sub, ...args] = rest;
  if (sub !== "init") fail(USAGE);
  const { values, positionals } = parseArgs({
    args,
    options: { engine: { type: "string" } },
    allowPositionals: true,
  });
  const [dir, ...extra] = positionals;
  if (!dir || extra.length) fail(USAGE);
  const engine = values.engine;
  if (engine !== undefined && engine !== "docker" && engine !== "podman")
    fail("--engine is docker or podman");
  const root = resolve(dir);
  const owner = chooseOwner(process.getuid?.(), parentOwner(root));
  const { made, kept } = localInit(root, owner);
  const name = basename(root);
  for (const rel of made) process.stdout.write(`made ${rel === "." ? name : `${name}/${rel}`}\n`);
  if (owner && made.length)
    process.stdout.write(
      `gave what it made to ${owner.uid}:${owner.gid}, the owner of the folder that holds ${name}\n`,
    );
  // What the local rig gets. In the release's init service (a container) the engine is the
  // one that runs it, and the GPUs are the ones the driver lists.
  const p = machineProbes();
  const box = containerEngine(p);
  const machine = box
    ? await detectInContainer(p, engine ?? box)
    : await detectOnMachine(p, await answeringEngines(p), engine);
  const report = rigReport(machine);
  for (const line of report.lines) process.stdout.write(`rig: ${line}\n`);
  if (report.fix) process.stdout.write(`rig: Fix: ${report.fix}\n`);
  if (report.gpus) {
    const text = gpuOverride(
      report.gpus.engine,
      report.gpus.names,
      harnessImageFrom(readStackCompose(root)),
    );
    writeGpuOverride(root, text, owner);
    process.stdout.write(
      `wrote ${GPU_OVERRIDE}: start Thermite with ${upWithGpus(report.gpus.engine)}\n`,
    );
  }
  process.stdout.write(`local init: ${name} ready (${made.length} made, ${kept.length} kept)\n`);
}

/** thermite selftest isolation: inside the harness container, as root. */
export async function thermiteSelftest(rest: string[]): Promise<void> {
  if (rest[0] !== "isolation") fail(USAGE);
  const { clusterApi, isolationSelftest, oneContainerTargets, readSupervisorIsolation } =
    await import("../../harness/selftest/index.ts");
  const { effectiveGpuLists, savedJudgeGpus } = await import("../../harness/broker/devices.ts");
  const env = process.env;
  const secretFiles = [
    env.THERMITE_SUPERVISOR_TOKEN_FILE,
    env.THERMITE_PROPOSER_TOKEN_FILE,
    env.THERMITE_MODEL_API_KEY_FILE,
    // In one container with the supervisor (pull mode): the keys its tunnel signs with.
    env.THERMITE_TUNNEL_DIR ? join(env.THERMITE_TUNNEL_DIR, "keys.json") : undefined,
  ].filter((f): f is string => Boolean(f));
  const report = await isolationSelftest({
    socketPath: join(env.THERMITE_BROKER_DIR ?? "/run/thermite", "broker.sock"),
    stateDir: env.THERMITE_STATE_DIR ?? "/var/lib/thermite",
    scratchDir: env.THERMITE_SCRATCH_DIR ?? "/scratch",
    outboxDir: env.THERMITE_OUTBOX_DIR ?? "/outbox",
    inboxDir: env.THERMITE_INBOX_DIR ?? HARNESS_INBOX_DIR,
    secretFiles,
    // As the broker set the cards up: explicit lists, or the rig's GPU set and its split.
    dedicated:
      effectiveGpuLists(env, savedJudgeGpus(env.THERMITE_STATE_DIR ?? "/var/lib/thermite")).dev !==
      undefined,
    force: rest.includes("--force"),
    // The one-container rig image (THERMITE_ONE_CONTAINER): the supervisor's places too.
    oneContainer: oneContainerTargets(env),
    // The state's snapshot on the host's volume, where the rig keeps one.
    snapshotDir: env.THERMITE_STATE_SNAPSHOT_DIR || undefined,
    // On Kubernetes: the API server, which no lane may reach.
    clusterApi: clusterApi(env),
    // What the supervisor's advisor users reached, as it last said.
    supervisor: readSupervisorIsolation(env.THERMITE_STATE_DIR ?? "/var/lib/thermite"),
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exit(1);
}
