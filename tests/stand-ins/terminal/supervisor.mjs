// Test only (scripts/acceptance/terminal.mjs): the terminal host in the supervisor image (goal 169),
// as an advisor's call in its program's own terminal runs it. Run as root, it serves the advisors'
// runner as the image's entry does (src/supervisor/advisor-runs/main.ts), then runs its own
// `--client` side as the supervisor's user, which starts the host through the runner, as an
// advisor user, in a folder among the runs' root's children, on the fake TUI
// (tests/helpers/fake-tui.ts). It prints one JSON line, { checks: [{ name, ok, detail }] }:
//   - the host runs as an advisor user, the fake TUI on a terminal of its own, its sign-in on file
//     descriptor 3, its seed written as that user, 0600;
//   - Thermite's hook program runs as that user and writes its signal, which the supervisor reads;
//   - typed text and keys reach it, and the supervisor reads the host's copy of its log;
//   - another advisor user can't list the runs' root, enter the call's folder or reach its socket;
//   - `/exit` ends it, nothing of the advisor user is left, and the folder is removed.
// THERMITE_SRC names the code it imports: the image's build (/opt/thermite/dist), or a mounted
// source tree (TypeScript, run as it is).
import { spawn } from "node:child_process";
import {
  chmodSync,
  chownSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = process.env.THERMITE_SRC ?? "/opt/thermite/dist";
const ext = SRC.endsWith("/dist") ? "js" : "ts";
const load = (path) => import(`${SRC}/${path}.${ext}`);

const FAKE = "/opt/fake-tui/fake-tui.ts";
/** A made-up sign-in: never a real one. */
const TOKEN = "madeupsignintokenforthestandin";
/** The supervisor's user and group, and the advisor users' (core/advisor-runs.ts). */
const SUPERVISOR = 10001;
const ADVISORS = { base: 10080, count: 8 };
/** The runner's socket and runs' root for this check, apart from the entry's own. */
const SOCKET_DIR = "/run/thermite-advisors-check";
const SOCKET = join(SOCKET_DIR, "runs.sock");
const ROOT = "/var/lib/thermite-advisors-check";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (process.argv.includes("--client")) await client();
else await serve();

/** As root: the runner, as the image's entry serves it, then the supervisor's side as its user. */
async function serve() {
  const { RunAsServer } = await load("common/run-as/index");
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });
  chownSync(ROOT, SUPERVISOR, SUPERVISOR);
  chmodSync(ROOT, 0o711);
  mkdirSync(SOCKET_DIR, { recursive: true });
  chownSync(SOCKET_DIR, 0, SUPERVISOR);
  chmodSync(SOCKET_DIR, 0o750);
  const server = new RunAsServer({ socketPath: SOCKET, root: ROOT, callerGid: SUPERVISOR });
  server.listen();
  await new Promise((r) => server.server.once("listening", r));
  // The socket as the image's entry and the broker leave it: root's, the supervisor's group may
  // connect (src/supervisor/advisor-runs/main.ts). Bound by root, it is root's alone until then.
  chownSync(SOCKET, 0, SUPERVISOR);
  chmodSync(SOCKET, 0o660);
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--client"], {
    uid: SUPERVISOR,
    gid: SUPERVISOR,
    env: { PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", THERMITE_SRC: SRC },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => {
    out += d;
  });
  child.stderr.on("data", (d) => {
    err += d;
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 300_000);
  await new Promise((r) => child.on("close", r));
  clearTimeout(timer);
  server.server.close();
  const line = out.trim().split("\n").at(-1) ?? "";
  try {
    process.stdout.write(`${JSON.stringify(JSON.parse(line))}\n`);
  } catch {
    process.stdout.write(
      `${JSON.stringify({ checks: [{ name: "the supervisor's side ran", ok: false, detail: `${out}${err}`.slice(-2000) }] })}\n`,
    );
  }
}

/** The uid a process runs as. */
function uidOf(pid) {
  return Number(/^Uid:\s+(\d+)/m.exec(readFileSync(`/proc/${pid}/status`, "utf8"))?.[1] ?? -1);
}

/** The processes of a user still alive. */
function processesOf(uid) {
  return readdirSync("/proc")
    .filter((p) => /^\d+$/.test(p))
    .filter((p) => {
      try {
        return uidOf(Number(p)) === uid;
      } catch {
        return false;
      }
    });
}

/** As the supervisor's user: an advisor's terminal through the runner. */
async function client() {
  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail });
  try {
    const { RunAsClient } = await load("common/run-as/index");
    const { AdvisorRoleRunner } = await load("supervisor/advisor-runs/index");
    const { startTerminal } = await load("agents/terminal/index");
    const { hookArgv } = await load("agents/programs/hooks/index");
    const runner = new AdvisorRoleRunner({ client: new RunAsClient(SOCKET), root: ROOT });
    const dir = mkdtempSync(join(ROOT, "thermite-advisor-"));
    const home = join(dir, "home");
    mkdirSync(home);
    const signals = join(dir, "signals.jsonl");
    const copy = join(dir, "copy.jsonl");
    const lines = () =>
      existsSync(copy)
        ? readFileSync(copy, "utf8")
            .split("\n")
            .filter((l) => l.trim())
            .flatMap((l) => {
              try {
                return [JSON.parse(l)];
              } catch {
                return [];
              }
            })
        : [];
    const until = async (what, fn, ms = 20_000) => {
      const end = Date.now() + ms;
      for (;;) {
        const v = fn();
        if (v) return v;
        if (Date.now() > end) throw new Error(`timed out: ${what}`);
        await sleep(100);
      }
    };
    const [command, ...args] = hookArgv("claude-code");
    const settings = JSON.stringify({
      hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command, args }] }] },
    });
    const t = await startTerminal(runner, {
      role: "advisor-check-1",
      area: dir,
      env: {
        HOME: home,
        PATH: "/usr/local/bin:/usr/bin:/bin",
        THERMITE_SIGNALS: signals,
        CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: "3",
      },
      start: {
        trial: "advisor-check-1",
        program: "claude-code",
        argv: [
          process.execPath,
          FAKE,
          "--session-id",
          "s-sup",
          "--settings",
          settings,
          "--",
          "the advisor's brief",
        ],
        cwd: dir,
        seeds: [{ path: join(home, ".seed.json"), content: "{}", mode: 0o600 }],
        token: TOKEN,
        mirror: {
          dir: join(home, ".fake-tui"),
          depth: 0,
          name: "^s-sup\\.jsonl$",
          to: "copy.jsonl",
        },
      },
    });
    const status = await t.status();
    const uid = uidOf(status.pid);
    check(
      "the host runs as an advisor user, through the advisors' runner",
      uid > ADVISORS.base && uid <= ADVISORS.base + ADVISORS.count,
      { pid: status.pid, uid },
    );
    const first = await until("its start", () => lines().find((r) => r.type === "start"));
    check(
      "the fake TUI is on a terminal of its own, its controlling one, with its sign-in on file descriptor 3",
      first.tty?.stdin && first.tty?.stdout && first.ctty && first.token?.length === TOKEN.length,
      first,
    );
    const seed = statSync(join(home, ".seed.json"));
    check(
      "its seed was written as that advisor user, 0600",
      seed.uid === uid && (seed.mode & 0o777) === 0o600,
      { uid: seed.uid, mode: (seed.mode & 0o777).toString(8) },
    );
    const sig = await until(
      "the hook's signal",
      () => existsSync(signals) && readFileSync(signals, "utf8").includes("UserPromptSubmit"),
    );
    check("Thermite's hook program ran as that user, and the supervisor reads its signal", sig);
    await t.type("hello from the supervisor");
    await t.keys(["up", "tab"]);
    await until("the keys", () => lines().filter((r) => r.type === "key").length >= 2);
    const got = lines();
    check(
      "typed text and keys came whole, and the supervisor reads the host's copy of its log",
      got.some((r) => r.text === "hello from the supervisor") &&
        got
          .filter((r) => r.type === "key")
          .map((r) => r.key)
          .join(",") === "up,tab" &&
        (statSync(copy).mode & 0o777) === 0o644,
      got.map((r) => r.type),
    );
    // Another advisor user, in a folder of its own: the runs' root may be passed, never listed;
    // the call's folder and its socket are its user's and the supervisor's group's alone.
    const probeDir = mkdtempSync(join(ROOT, "thermite-advisor-"));
    const probe = await runner.run({
      role: "advisor-check-probe",
      argv: [
        "sh",
        "-c",
        `ls "$1" >/dev/null 2>&1 && echo root-listed; cd "$2" 2>/dev/null && echo folder-entered; "$4" -e 'require("net").connect(process.argv[1]).on("connect",()=>{console.log("socket-reached");process.exit(0)}).on("error",(e)=>{console.log(e.code);process.exit(0)})' "$3"; id -u`,
        "sh",
        ROOT,
        dir,
        t.socket,
        process.execPath,
      ],
      cwd: probeDir,
      timeoutMs: 30_000,
    });
    const said = probe.stdout.trim().split("\n");
    const probeUid = Number(said.at(-1));
    check(
      "another advisor user can't list the runs' root, enter the call's folder or reach its socket",
      probeUid !== uid &&
        probeUid > ADVISORS.base &&
        !said.includes("root-listed") &&
        !said.includes("folder-entered") &&
        !said.includes("socket-reached") &&
        said.some((l) => /^E(ACCES|NOENT)$/.test(l)),
      { said, uid: probeUid, stderr: probe.stderr.slice(-300) },
    );
    await runner.remove(probeDir);
    const ended = await t.end();
    const done = await t.done;
    await sleep(500);
    check(
      "/exit ends it, the run with it, and nothing of the advisor user is left",
      ended.how === "end steps" &&
        ended.code === 0 &&
        done.outcome.exitCode === 0 &&
        processesOf(uid).length === 0,
      { ended, exit: done.outcome.exitCode, left: processesOf(uid) },
    );
    await runner.remove(dir);
    check("the call's folder is removed, with what its user left", !existsSync(dir), dir);
  } catch (err) {
    check("the supervisor's side ran", false, err instanceof Error ? err.stack : String(err));
  }
  process.stdout.write(`${JSON.stringify({ checks })}\n`);
}
