// @ts-check
// Shared setup for the compose smoke and the judge acceptance test: the smoke project and kit
// as git bundles in the inbox, the stack, signed commands through control, submissions from
// inside the harness, and verdicts read back from control's event stream.
import { execFileSync, execSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * An answer of control's API: its status and its JSON body. The body is read loosely (`any`): each
 * script checks the fields it needs, and a field that is not there fails that check.
 * @typedef {{ status: number, body: any }} ApiAnswer
 */
/**
 * One event as control lists it, with its body read loosely, as the answer's.
 * @typedef {{ seq: number, kind: string, subject: string | null, at: string, actor: string, body: any }} ControlEvent
 */
/** What prepare() made: the smoke project and kit in the inbox, and the contract's file. */
/** @typedef {ReturnType<typeof prepare>} SmokeEnv */
/** A compose command's environment, added to this process's. */
/** @typedef {Record<string, string | undefined>} ComposeEnv */

export const compose = (process.env.COMPOSE ?? "podman compose").split(" ");
/**
 * The container engine under the compose command, for the engine's own commands (build, run, exec,
 * image prune): Docker for Docker's compose, Podman for the rest. Never the command's first word,
 * which may be a launcher, as in `uvx podman-compose`.
 */
export const engine = compose.some((w) => /^docker(-compose)?$/.test(w)) ? "docker" : "podman";
/**
 * A container's removal with a short stop first: Podman's `rm` takes the stop's time (`-t`),
 * Docker's has no such option and kills at once.
 */
export const rmFast = ["rm", "-f", ...(engine === "podman" ? ["-t", "3"] : [])];
/** The Containerfile control, the harness and the supervisor are built from, each its target. */
export const CONTAINERFILE = "containers/Containerfile";
/** The one-container rig image's, built on a harness image (its build argument HARNESS_IMAGE). */
export const RIG_CONTAINERFILE = "containers/rig/Containerfile";
/** The arguments of an engine's build that build one image: control, harness or supervisor. */
export const imageTarget = (/** @type {string} */ target) => [
  "-f",
  CONTAINERFILE,
  "--target",
  target,
];
// THERMITE_PROJECT and THERMITE_CONTROL_PORT let a second stack (a long run) run beside the usual
// one, with THERMITE_NATS_PUBLISH for its message bus's port (such as 127.0.0.1:4223).
export const control = `http://127.0.0.1:${process.env.THERMITE_CONTROL_PORT ?? "8800"}`;
/**
 * Where control's store is in this check: SQLite, or PostgreSQL with THERMITE_CONTROL_STORE=postgres
 * (goal 268), which compose hands to control. The stack then has the postgres service too.
 */
export const STORE = process.env.THERMITE_CONTROL_STORE === "postgres" ? "postgres" : "sqlite";
/** The compose options that start the store's own service with the stack: its profile. */
export const storeProfile = STORE === "postgres" ? ["--profile", "postgres"] : [];
const project = [
  ...(process.env.THERMITE_PROJECT ? ["-p", process.env.THERMITE_PROJECT] : []),
  ...storeProfile,
];
/** @type {(ms: number) => Promise<void>} */
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Runs a program and returns what it printed; its errors go to this process's.
 * @param {string} cmd
 * @param {readonly string[]} args
 * @param {Omit<import("node:child_process").ExecFileSyncOptions, "encoding">} [opts]
 * @returns {string}
 */
export const sh = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], ...opts });

/** Makes the stack's `.dev/` as a checkout does: `npm run dev:init`, `thermite local init .dev`. */
export const devInit = () => sh("npm", ["run", "--silent", "dev:init"]);

/**
 * @param {ComposeEnv} env
 * @param {...string} args
 */
export function dc(env, ...args) {
  const out = sh(/** @type {string} */ (compose[0]), [...compose.slice(1), ...project, ...args], {
    env: { ...process.env, ...env },
  });
  if (args.includes("down")) cleanEngine();
  return out;
}

/**
 * A service's whole log, its output and its errors: larger than execFileSync's usual buffer.
 * `files`: the compose files (`-f` each) of a stack that has services beyond compose.yaml's,
 * whose logs compose finds only with them.
 * @param {ComposeEnv} env
 * @param {string} service
 * @param {string[]} [files]
 */
export function dcLogs(env, service, files = []) {
  const r = spawnSync(
    /** @type {string} */ (compose[0]),
    [...compose.slice(1), ...project, ...files, "logs", service],
    {
      encoding: "utf8",
      env: { ...process.env, ...env },
      maxBuffer: 256 * 1024 * 1024,
    },
  );
  return `${r.stdout ?? ""}${r.stderr ?? ""}`;
}

/**
 * Fails unless control runs on the store this check was asked for: a control on PostgreSQL says
 * so as it starts.
 * @param {ComposeEnv} env
 */
export function storeAsAsked(env) {
  const says = /the store is on PostgreSQL/.test(dcLogs(env, "control"));
  if (says !== (STORE === "postgres"))
    throw new Error(
      `control's store was to be on ${STORE}, and its log says ${says ? "PostgreSQL" : "nothing of PostgreSQL"}`,
    );
  console.log(`control's store: ${STORE === "postgres" ? "PostgreSQL" : "SQLite"}`);
}

/**
 * After a stack comes down: remove the build layers it left (dangling images only; tagged images
 * may be other projects') and, on a Podman machine, hand the freed disk back to the host.
 */
export function cleanEngine() {
  try {
    sh(engine, ["image", "prune", "-f"]);
    if (engine === "podman" && process.platform !== "linux")
      sh("podman", ["machine", "ssh", "sudo", "fstrim", "-a"]);
  } catch {}
}

export const secret = (/** @type {string} */ n) =>
  readFileSync(join(".dev", "secrets", n), "utf8").trim();

/**
 * The message bus's server as compose.yaml runs it: its image, its user and its command, for a
 * stack that starts the server beside a control of its own (the cluster acceptance), so that both
 * run it one way. Read from compose.yaml, where it is kept.
 */
export function natsService() {
  const text = readFileSync("compose.yaml", "utf8");
  const service = text.slice(text.indexOf("\n  nats:\n"));
  const image = /\n {4}image: (\S+)/.exec(service)?.[1];
  const user = /\n {4}user: "([0-9:]+)"/.exec(service)?.[1];
  /** @type {string[]} */
  const lines = [];
  for (const line of service.slice(service.indexOf("      - |\n")).split("\n").slice(1)) {
    if (!line.startsWith("        ")) break;
    lines.push(line.slice(8));
  }
  if (!image || !user || !lines.length) throw new Error("compose.yaml has no nats service to read");
  // Compose writes a literal $ as $$; run as it is, the shell would read $$ as its own pid.
  return { image, user, command: ["sh", "-c", lines.join("\n").replaceAll("$$", "$")] };
}

/**
 * The engine's `run` of the bus's one-shot service as compose.yaml runs it (nats-init): it gives
 * the folders on these volumes (`source:/data` and `source:/etc/nats/thermite`) to their users
 * before the server starts, and ends. Read from compose.yaml, where it is kept.
 * @param {string[]} volumes
 */
export function natsInitRun(volumes) {
  const text = readFileSync("compose.yaml", "utf8");
  const service = text.slice(text.indexOf("\n  nats-init:\n"));
  const image = /\n {4}image: (\S+)/.exec(service)?.[1];
  const user = /\n {4}user: "([0-9:]+)"/.exec(service)?.[1];
  const caps = /\n {4}cap_add: \[([A-Z_, ]+)\]/.exec(service)?.[1]?.split(", ");
  const command = /\n {4}command: (\[.*\])\n/.exec(service)?.[1];
  if (!image || !user || !caps || !command)
    throw new Error("compose.yaml has no nats-init service to read");
  return [
    "run",
    "--rm",
    "--pull=never",
    "--user",
    user,
    "--cap-drop",
    "ALL",
    ...caps.flatMap((c) => ["--cap-add", c]),
    "--security-opt",
    "no-new-privileges:true",
    "--network",
    "none",
    ...volumes.flatMap((v) => ["-v", v]),
    image,
    ...JSON.parse(command),
  ];
}

/**
 * Asks `fn` every `everyMs` until it gives a truthy value, which it returns; a throw counts as no.
 * @template T
 * @param {string} what
 * @param {() => T | Promise<T>} fn
 * @param {number} [timeoutMs]
 * @param {number} [everyMs]
 * @returns {Promise<NonNullable<T>>}
 */
export async function until(what, fn, timeoutMs = 180_000, everyMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {}
    if (Date.now() > deadline) throw new Error(`timed out: ${what}`);
    await sleep(everyMs);
  }
}

/**
 * Where a dashboard form sent the owner back, as words: its address, or the page itself when the
 * message is a note the page shows (control keeps other programs' errors out of addresses).
 * `base`: the control the form went to, where it is not the compose stack's.
 * @param {Response} r
 * @param {string} cookie
 * @param {string} [base]
 */
export async function formAnswer(r, cookie, base = control) {
  const to = String(r.headers.get("location"));
  return /=note-[0-9a-f]{24}\b/.test(to)
    ? (await (await fetch(new URL(to, base), { headers: { cookie } })).text())
        .replaceAll("&quot;", '"')
        .replaceAll("&lt;", "<")
        .replaceAll("&gt;", ">")
        .replaceAll("&amp;", "&")
    : decodeURIComponent(to);
}

/**
 * @param {string} path
 * @param {RequestInit} [init]
 * @returns {Promise<ApiAnswer>}
 */
export async function api(path, init = {}) {
  const res = await fetch(`${control}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${secret("control-admin-token")}`,
      "content-type": "application/json",
    },
  });
  return { status: res.status, body: await res.json() };
}

/**
 * @param {string} cwd
 * @param {...string} args
 */
function git(cwd, ...args) {
  return sh(
    "git",
    [
      "-c",
      "user.name=demo",
      "-c",
      "user.email=demo@localhost",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd },
  ).trim();
}

/**
 * Copies a directory into a fresh git repository and bundles it into the inbox.
 * @param {string} from
 * @param {string} name
 * @param {string[]} [exclude]
 */
function bundle(from, name, exclude = []) {
  const repo = mkdtempSync(join(tmpdir(), `thermite-${name}-`));
  cpSync(from, repo, { recursive: true, filter: (src) => !exclude.some((e) => src.includes(e)) });
  git(repo, "init", "--quiet", "-b", "main");
  git(repo, "add", "-A");
  git(repo, "commit", "--quiet", "-m", `${name} seed`);
  const commit = git(repo, "rev-parse", "HEAD");
  const out = join(process.cwd(), ".dev", "inbox", "repos", `${name}.bundle`);
  git(repo, "bundle", "create", "--quiet", out, "--all");
  const sha256 = createHash("sha256").update(readFileSync(out)).digest("hex");
  return { repo, commit, path: `repos/${name}.bundle`, sha256 };
}

export function prepare() {
  devInit();
  execSync("npm run -s build", { stdio: "inherit" });
  const project = bundle("examples/smoke-project", "smoke-project");
  const kit = bundle("kits/smoke-cpu", "smoke-cpu-kit", ["/candidates"]);
  const contract = JSON.parse(readFileSync("examples/contracts/smoke-cpu.json", "utf8"));
  contract.project = {
    repo: "smoke-project",
    commit: project.commit,
    kit: { repo: "smoke-cpu-kit", commit: kit.commit },
  };
  const contractFile = join(mkdtempSync(join(tmpdir(), "thermite-contract-")), "smoke.json");
  writeFileSync(contractFile, JSON.stringify(contract));
  return { project, kit, contractFile };
}

/**
 * The planner's call while it runs in its own terminal (goal 169), as the rig's report lists it to
 * control (`work.terminals`): its id (planner-RUN-ROUND) and its run.
 * @param {string} [run]
 * @param {{ rig?: string, ms?: number }} [options]
 */
export async function plannerInTerminal(run = "smoke-1", { rig = "local-1", ms = 300_000 } = {}) {
  return await until(
    "the planner's call in its own terminal",
    async () =>
      ((await api(`/v1/rigs/${rig}/view`)).body.summary?.work?.terminals ?? []).find(
        (/** @type {{ role: string, run: string }} */ x) => x.role === "planner" && x.run === run,
      ),
    ms,
    1000,
  );
}

/**
 * Issues a signed command through control and waits until the supervisor delivered it.
 * @param {string} kind
 * @param {unknown} payload
 * @param {string} [rig]
 */
export async function command(kind, payload, rig = "local-1") {
  const issued = await api("/v1/commands", {
    method: "POST",
    body: JSON.stringify({ rig, kind, payload }),
  });
  if (issued.status !== 201) throw new Error(`issue failed: ${JSON.stringify(issued)}`);
  const done = await until(`${kind} delivered`, async () => {
    const c = await api(`/v1/commands/${issued.body.id}`);
    return c.body.status !== "pending" ? c.body : undefined;
  });
  if (done.status !== "delivered" || done.outcome?.accepted === false) {
    throw new Error(`${kind} not accepted: ${JSON.stringify(done)}`);
  }
  return done;
}

/**
 * Runs a rig check through control and returns its result from the rig's events. A busy rig
 * refuses the isolation and smoke checks ("not now"): it is asked again until it is idle.
 * @param {string} check
 * @param {{ rig?: string, timeoutMs?: number }} [options]
 */
export async function rigCheck(check, { rig = "local-1", timeoutMs = 300_000 } = {}) {
  /** @type {string | undefined} */
  let id;
  for (let i = 0; !id; i++) {
    const issued = await api("/v1/commands", {
      method: "POST",
      body: JSON.stringify({ rig, kind: "rig_check", payload: { check } }),
    });
    if (issued.status !== 201) throw new Error(`issue failed: ${JSON.stringify(issued)}`);
    const done = await until("rig_check delivered", async () => {
      const c = await api(`/v1/commands/${issued.body.id}`);
      return c.body.status !== "pending" ? c.body : undefined;
    });
    if (done.status === "delivered" && done.outcome?.accepted !== false) {
      id = done.outcome.result.id;
    } else if (i < 40 && /not now/.test(JSON.stringify(done.outcome))) {
      await new Promise((r) => setTimeout(r, 3000));
    } else {
      throw new Error(`rig_check ${check} refused: ${JSON.stringify(done)}`);
    }
  }
  const finished = await until(
    `the ${check} check`,
    async () => (await events()).find((e) => e.kind === "rig_check_finished" && e.body.id === id),
    timeoutMs,
    2000,
  );
  return finished.body;
}

/**
 * @param {SmokeEnv} env
 * @param {string} run
 * @param {string} [rig]
 */
export async function assign(env, run, rig = "local-1") {
  const payload = sh("node", [
    "dist/cli/thermite/main.js",
    "assign-payload",
    "--contract",
    env.contractFile,
    "--run",
    run,
    "--seed-repo",
    "smoke-project",
    "--seed-commit",
    env.project.commit,
    "--bundle",
    env.project.path,
    "--bundle-sha256",
    env.project.sha256,
    "--kit-bundle-sha256",
    env.kit.sha256,
    "--kit-repo",
    "smoke-cpu-kit",
    "--kit-commit",
    env.kit.commit,
    "--kit-bundle",
    env.kit.path,
  ]).trim();
  return command("assign_campaign", JSON.parse(payload), rig);
}

/**
 * A patch that replaces files in the seed project with a candidate's files. With `base`, the
 * patch applies on top of the seed plus the base candidate's files (for example a champion).
 * @param {SmokeEnv} env
 * @param {string} dir
 * @param {string} [base]
 */
export function candidatePatch(env, dir, base) {
  const wt = mkdtempSync(join(tmpdir(), "thermite-cand-"));
  sh("git", ["clone", "--quiet", env.project.repo, wt]);
  if (base) {
    cpSync(base, wt, { recursive: true });
    git(wt, "add", "-A");
    git(wt, "commit", "--quiet", "-m", "base");
  }
  cpSync(dir, wt, { recursive: true });
  sh("git", ["add", "-A"], { cwd: wt });
  const patch = sh("git", ["diff", "--cached", "--binary"], { cwd: wt });
  rmSync(wt, { recursive: true, force: true });
  return patch;
}

/**
 * Submits a patch as a proposer from inside the harness container (as workers will).
 * @param {ComposeEnv} composeEnv
 * @param {string} run
 * @param {string} patch
 * @param {string} hypothesis
 */
export function submit(composeEnv, run, patch, hypothesis) {
  const b64 = Buffer.from(patch).toString("base64");
  const out = dc(
    composeEnv,
    "exec",
    "-T",
    "harness",
    "sh",
    "-c",
    `echo ${b64} | base64 -d > /tmp/p.patch && thermite submit --harness http://127.0.0.1:8700 --token-file /run/secrets/harness-proposer-token --run ${run} --patch-file /tmp/p.patch --hypothesis "${hypothesis.replace(/"/g, "'")}"`,
  );
  return JSON.parse(/** @type {string} */ (out.trim().split("\n").pop()));
}

/**
 * Every event control has for the rig, in arrival order.
 * @returns {Promise<ControlEvent[]>}
 */
export async function events() {
  /** @type {ControlEvent[]} */
  const all = [];
  let after = 0;
  for (;;) {
    const page = await api(`/v1/rigs/local-1/events?after=${after}&limit=5000`);
    all.push(...page.body.events);
    if (page.body.events.length < 5000) return all;
    after = page.body.events.at(-1).seq;
  }
}

/** @param {ControlEvent[]} evs */
export function latestVerdicts(evs) {
  /** @type {Record<string, string>} */
  const v = {};
  // A verdict's and an attempt's events name their attempt.
  for (const e of evs)
    if (e.kind === "verdict") v[/** @type {string} */ (e.subject)] = e.body.verdict;
  return v;
}

/** @param {ControlEvent[]} evs */
export function lifecycles(evs) {
  /** @type {Record<string, string>} */
  const l = {};
  for (const e of evs) {
    const attempt = /** @type {string} */ (e.subject);
    if (e.kind === "attempt_recorded") l[attempt] = e.body.lifecycle;
    if (e.kind === "attempt_lifecycle") l[attempt] = e.body.lifecycle;
  }
  return l;
}
