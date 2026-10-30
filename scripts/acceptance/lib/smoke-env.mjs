// Shared setup for the compose smoke and the judge acceptance test: the smoke project and kit
// as git bundles in the inbox, the stack, signed commands through control, submissions from
// inside the harness, and verdicts read back from control's event stream.
import { execFileSync, execSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const compose = (process.env.COMPOSE ?? "podman compose").split(" ");
/**
 * The container engine under the compose command, for the engine's own commands (build, run, exec,
 * image prune): Docker for Docker's compose, Podman for the rest. Never the command's first word,
 * which may be a launcher, as in `uvx podman-compose`.
 */
export const engine = compose.some((w) => /^docker(-compose)?$/.test(w)) ? "docker" : "podman";
// THERMITE_PROJECT and THERMITE_CONTROL_PORT let a second stack (a long run) run beside the usual
// one, with THERMITE_NATS_PUBLISH for its message bus's port (such as 127.0.0.1:4223).
export const control = `http://127.0.0.1:${process.env.THERMITE_CONTROL_PORT ?? "8800"}`;
const project = process.env.THERMITE_PROJECT ? ["-p", process.env.THERMITE_PROJECT] : [];
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const sh = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], ...opts });

export function dc(env, ...args) {
  const out = sh(compose[0], [...compose.slice(1), ...project, ...args], {
    env: { ...process.env, ...env },
  });
  if (args.includes("down")) cleanEngine();
  return out;
}

/** A service's whole log, its output and its errors: larger than execFileSync's usual buffer. */
export function dcLogs(env, service) {
  const r = spawnSync(compose[0], [...compose.slice(1), ...project, "logs", service], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    maxBuffer: 256 * 1024 * 1024,
  });
  return `${r.stdout ?? ""}${r.stderr ?? ""}`;
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

export const secret = (n) => readFileSync(join(".dev", "secrets", n), "utf8").trim();

/**
 * The message bus's server as compose.yaml runs it: its image and its command, for a stack that
 * starts the server beside a control of its own (the cluster acceptance), so that both run it
 * one way. Read from compose.yaml, where it is kept.
 */
export function natsService() {
  const text = readFileSync("compose.yaml", "utf8");
  const service = text.slice(text.indexOf("\n  nats:\n"));
  const image = /\n {4}image: (\S+)/.exec(service)?.[1];
  const lines = [];
  for (const line of service.slice(service.indexOf("      - |\n")).split("\n").slice(1)) {
    if (!line.startsWith("        ")) break;
    lines.push(line.slice(8));
  }
  if (!image || !lines.length) throw new Error("compose.yaml has no nats service to read");
  // Compose writes a literal $ as $$; run as it is, the shell would read $$ as its own pid.
  return { image, command: ["sh", "-c", lines.join("\n").replaceAll("$$", "$")] };
}

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

/** Copies a directory into a fresh git repository and bundles it into the inbox. */
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
  sh("node", ["scripts/dev/init.mjs"]);
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

/** Issues a signed command through control and waits until the supervisor delivered it. */
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
 */
export async function rigCheck(check, { rig = "local-1", timeoutMs = 300_000 } = {}) {
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

/** Submits a patch as a proposer from inside the harness container (as workers will). */
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
  return JSON.parse(out.trim().split("\n").pop());
}

/** Every event control has for the rig, in arrival order. */
export async function events() {
  const all = [];
  let after = 0;
  for (;;) {
    const page = await api(`/v1/rigs/local-1/events?after=${after}&limit=5000`);
    all.push(...page.body.events);
    if (page.body.events.length < 5000) return all;
    after = page.body.events.at(-1).seq;
  }
}

export function latestVerdicts(evs) {
  const v = {};
  for (const e of evs) if (e.kind === "verdict") v[e.subject] = e.body.verdict;
  return v;
}

export function lifecycles(evs) {
  const l = {};
  for (const e of evs) {
    if (e.kind === "attempt_recorded") l[e.subject] = e.body.lifecycle;
    if (e.kind === "attempt_lifecycle") l[e.subject] = e.body.lifecycle;
  }
  return l;
}
