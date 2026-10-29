// Test only (scripts/acceptance/terminal.mjs): the terminal host in the harness image, run by the
// real broker as lane-1, under the lane's limits and the GPU fence, as a trial will run it. It runs
// as the controller's user (thermite) and prints one JSON line, { checks: [{ name, ok, detail }] }:
//   - the fake TUI (tests/helpers/fake-tui.ts): its terminal and its controlling terminal, its
//     size, its seeds and its sign-in on file descriptor 3, the emulator's answer to its query,
//     typed text, a paste, keys and an interrupt, its hook's signal, its session log (0600, which
//     the harness can't read) copied to a file the harness reads, the agent's own process refused
//     at the host's socket, a clean end, a session resumed after a crash in the same copy, and an
//     end that falls to the broker's kill with nothing of the lane's left;
//   - the real Codex CLI, when the image has it, in its own terminal against a stand-in model
//     (model.mjs): no screen waits once seeded, its rollout copied, a typed message taken in, and
//     `/exit`;
//   - the real OpenCode, its server started first with a password of its own and its terminal
//     attached, against the same stand-in: its first message and a typed one taken in, `/exit`,
//     and its server ended with it;
//   - the real Claude Code, when the image has it (built with CLAUDE_CODE_VERSION), against
//     containers/test-anthropic's stand-in, with a made-up sign-in on file descriptor 3: its
//     transcript, which only lane-1 may read, copied; its hooks' signals; `/exit`;
//   - one short trial through the trial loop's terminal mode for the fake TUI in Claude Code's
//     place, the real Codex and the real OpenCode, and the owner's input (terminal_input's) through
//     a trial's console into the fake and the real Codex (trials.mjs);
//   - for each real program, the peak memory of its run in its terminal, the host with it, as the
//     broker recorded it: the figure its limits note states.
// THERMITE_SRC names the code it imports: the image's build (/opt/thermite/dist), or a mounted
// source tree (TypeScript, run as it is).
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { startModel } from "./model.mjs";
import { loopTrials } from "./trials.mjs";

const SRC = process.env.THERMITE_SRC ?? "/opt/thermite/dist";
const ext = SRC.endsWith("/dist") ? "js" : "ts";
const load = (path) => import(`${SRC}/${path}.${ext}`);
const { BrokerClient } = await load("harness/broker/client");
const { startTerminal } = await load("harness/terminal/index");
const programs = await load("agents/programs/index");
const { hookArgv } = await load("agents/programs/hooks/index");

const FAKE = "/opt/fake-tui/fake-tui.ts";
/** A made-up sign-in: never a real one. */
const TOKEN = "madeupsignintokenforthestandin";
const LANE = "lane-1";
const LANE_UID = 10101;
const runner = new BrokerClient("/run/thermite/broker.sock");
const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(what, fn, ms = 20_000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await sleep(100);
  }
}

/**
 * A run's area as a trial's: a git workspace in it, handed to the lane, which the harness reads.
 * `files` writes more in it first, and what it returns is the area's `env`.
 */
async function area(name, files) {
  const dir = join("/scratch/thermite/lanes", LANE, `${name}-${randomUUID().slice(0, 8)}`);
  const repo = join(dir, "repo");
  mkdirSync(repo, { recursive: true });
  mkdirSync(join(dir, "home"));
  mkdirSync(join(dir, "tmp"));
  writeFileSync(join(repo, "notes.txt"), "a workspace\n");
  const git = (...a) =>
    execFileSync("git", ["-c", "user.name=thermite", "-c", "user.email=thermite@localhost", ...a], {
      cwd: repo,
      env: { PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", HOME: dir },
      stdio: "ignore",
    });
  git("init", "--quiet", "-b", "work");
  git("add", "-A");
  git("commit", "--quiet", "-m", "parent");
  const env = files?.(dir);
  await runner.handOver(dir, LANE, { harnessReads: true });
  return { dir, repo, home: join(dir, "home"), tmp: join(dir, "tmp"), env };
}

/** The lines of a copy the host made, as JSON. */
const lines = (file) =>
  existsSync(file)
    ? readFileSync(file, "utf8")
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

/** The uid a process runs as. */
const uidOf = (pid) =>
  Number(/^Uid:\s+(\d+)/m.exec(readFileSync(`/proc/${pid}/status`, "utf8"))?.[1] ?? -1);

/** The lane's processes still alive. */
const laneProcesses = () =>
  readdirSync("/proc")
    .filter((p) => /^\d+$/.test(p))
    .filter((p) => {
      try {
        return uidOf(Number(p)) === LANE_UID;
      } catch {
        return false;
      }
    });

/** The peak memory of a program's run in its terminal, the host and its commands with it. */
const peak = (name, done) =>
  check(
    `${name} in its terminal, with the terminal host, used this much memory at its peak`,
    true,
    `${Math.round((done.outcome.peakRssBytes ?? 0) / 2 ** 20)} MiB`,
  );

const limits = {
  timeoutMs: 600_000,
  rssLimitBytes: 1536 * 1024 * 1024,
  nproc: 256,
};

async function fakeTui() {
  const a = await area("fake");
  const signals = join(a.dir, "signals.jsonl");
  const [command, ...args] = hookArgv("claude-code");
  const settings = JSON.stringify({
    hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command, args }] }] },
  });
  const start = (session, extra = []) =>
    startTerminal(runner, {
      role: LANE,
      area: a.dir,
      env: {
        HOME: a.home,
        PATH: "/usr/local/bin:/usr/bin:/bin",
        THERMITE_SIGNALS: signals,
        CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: "3",
      },
      start: {
        trial: `check-${session}`,
        program: "claude-code",
        argv: [process.execPath, FAKE, ...extra, "--settings", settings, "--", "the brief"],
        cwd: a.repo,
        seeds: [{ path: join(a.home, ".seed.json"), content: "{}", mode: 0o600 }],
        token: TOKEN,
        mirror: {
          dir: join(a.home, ".fake-tui"),
          depth: 0,
          name: `^${session}\\.jsonl$`,
          to: "copy.jsonl",
        },
      },
      ...limits,
      disk: { path: a.dir, limitBytes: 2048 * 1024 * 1024 },
      spareExe: process.execPath,
    });
  const copy = join(a.dir, "copy.jsonl");
  const seen = (type, more = () => true) =>
    until(`a ${type} record`, () => lines(copy).find((r) => r.type === type && more(r)));

  const t = await start("s-check", ["--session-id", "s-check"]);
  const status = await t.status();
  check("the host runs as lane-1", uidOf(status.pid) === LANE_UID, { pid: status.pid });
  const first = await seen("start");
  check(
    "the fake TUI is on a terminal of its own, its controlling one, at 120x40, as an xterm",
    first.tty?.stdin &&
      first.tty?.stdout &&
      first.ctty &&
      first.size?.cols === 120 &&
      first.size?.rows === 40 &&
      first.term === "xterm-256color",
    first,
  );
  check(
    "its sign-in came on file descriptor 3, whole",
    first.token?.length === TOKEN.length,
    first.token,
  );
  const seed = statSync(join(a.home, ".seed.json"));
  check(
    "its seed was written as lane-1, 0600",
    seed.uid === LANE_UID && (seed.mode & 0o777) === 0o600,
    { uid: seed.uid, mode: (seed.mode & 0o777).toString(8) },
  );
  check("the emulator answered its query", await seen("query", (r) => r.da1 === "answered"), "da1");
  await t.type("hello from the harness");
  await t.type("a paste\nof two lines");
  await t.keys(["up", "tab"]);
  await t.interrupt();
  await seen("interrupt");
  const got = lines(copy);
  check(
    "typed text and a paste came whole, the keys by name, the interrupt as Esc",
    got.some((r) => r.text === "hello from the harness") &&
      got.some((r) => r.text === "a paste\nof two lines") &&
      got
        .filter((r) => r.type === "key")
        .map((r) => r.key)
        .join(",") === "up,tab",
    got.map((r) => r.type),
  );
  const log = join(a.home, ".fake-tui", "s-check.jsonl");
  let unreadable = false;
  try {
    readFileSync(log);
  } catch (err) {
    unreadable = err.code === "EACCES";
  }
  check(
    "its session log is lane-1's alone, and the harness reads the host's copy",
    unreadable && (statSync(copy).mode & 0o777) === 0o644,
    { unreadable },
  );
  const sig = await until(
    "the hook's signal",
    () => existsSync(signals) && readFileSync(signals, "utf8").includes("UserPromptSubmit"),
  );
  check("Thermite's hook program wrote its signal to the trial's signals file", sig, signals);
  await t.type(`/probe ${t.socket}`);
  const probe = await seen("probe");
  check(
    "the agent's own process reaches the host's socket, and is refused without the secret",
    probe.answers?.length === 2 && probe.answers.every((x) => JSON.parse(x).ok === false),
    probe.answers,
  );
  const screen = await t.screen();
  check(
    "the screen shows the program's prompt",
    screen.lines.some((l) => l.startsWith("> ")),
    screen.lines.slice(-3),
  );
  const ended = await t.end();
  const done = await t.done;
  check(
    "/exit ends it, and the run with it",
    ended.how === "end steps" && ended.code === 0 && done.outcome.exitCode === 0,
    { ended, exit: done.outcome.exitCode, killedFor: done.outcome.killedFor },
  );
  check(
    "the host and its program used this much memory at their peak",
    true,
    `${Math.round((done.outcome.peakRssBytes ?? 0) / 2 ** 20)} MiB`,
  );

  const again = await start("s-check", ["--resume", "s-check"]);
  await seen("start", (r) => r.resumed);
  check(
    "a session resumed after a crash goes on in the same copy",
    lines(copy).filter((r) => r.type === "start").length === 2,
    lines(copy).length,
  );
  await again.end();
  await again.done;

  const stubborn = await start("s-stubborn", [
    "--session-id",
    "s-stubborn",
    "--ignore-exit",
    "--ignore-term",
  ]);
  await until(
    "its start",
    () => lines(copy).length > 0 || existsSync(join(a.home, ".fake-tui", "s-stubborn.jsonl")),
  );
  const left = await stubborn.end();
  await stubborn.done;
  await sleep(500);
  check(
    "a program that ignores /exit and SIGTERM is left to the broker, which leaves nothing of the lane",
    left.how === "left to the broker" && laneProcesses().length === 0,
    { left, lane: laneProcesses() },
  );
}

async function codex() {
  if (!existsSync("/opt/codex/bin/codex")) {
    check(
      "the image has no Codex CLI (built with an empty CODEX_VERSION): its check was not run",
      true,
      "",
    );
    return;
  }
  const api = await startModel();
  try {
    const a = await area("codex");
    const codexHome = join(a.home, ".codex");
    const model = {
      api: "openai",
      harness: "codex",
      baseUrl: "",
      model: "scripted",
      apiKey: "",
      contextWindow: 0,
      maxTokens: 0,
    };
    const config = programs.codexTerminalConfig(
      programs.codexConfig(model, `http://127.0.0.1:${api.port}/v1`),
      a.repo,
    );
    const t = await startTerminal(runner, {
      role: LANE,
      area: a.dir,
      env: programs.codexEnv({
        home: a.home,
        apiUrl: "http://127.0.0.1:8700",
        auth: "",
        proxyAuth: "made-up",
        tmp: a.tmp,
      }),
      start: {
        trial: "check-codex",
        program: "codex",
        argv: [
          "/opt/codex/bin/codex",
          ...programs.codexTerminalArgs(model, { cwd: a.repo, first: "TERMINAL-CHECK-1: reply." }),
        ],
        cwd: a.repo,
        seeds: [{ path: join(codexHome, "config.toml"), content: config, mode: 0o600 }],
        mirror: { ...programs.codexTerminalLog(codexHome), to: "rollout.jsonl" },
      },
      ...limits,
      disk: { path: a.dir, limitBytes: 2048 * 1024 * 1024 },
      spareExe: "/opt/codex/bin/codex",
    });
    const copy = join(a.dir, "rollout.jsonl");
    const completes = () =>
      lines(copy).filter((r) => r.type === "event_msg" && r.payload?.type === "task_complete")
        .length;
    try {
      await until("its first turn's end", () => completes() >= 1, 60_000);
      check(
        "Codex took its first message with nothing to answer, and its rollout was copied",
        true,
        api.calls,
      );
      await t.type("TERMINAL-CHECK-2: reply again.");
      await until("its second turn's end", () => completes() >= 2, 60_000);
      check(
        "a message typed into Codex's terminal was taken in",
        api.calls["TERMINAL-CHECK-2"] >= 1,
        api.calls,
      );
    } catch (err) {
      check("Codex's turns ended", false, {
        error: String(err),
        screen: (await t.screen().catch(() => ({ lines: [] }))).lines.slice(-12),
      });
    }
    const ended = await t.end();
    check("/exit ends Codex", ended.how === "end steps" && ended.code === 0, ended);
    peak("Codex", await t.done);
  } finally {
    api.close();
  }
}

/** A port free on localhost now. */
const freePort = () =>
  new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

async function opencode() {
  if (!existsSync("/usr/local/bin/opencode")) {
    check("the image has no OpenCode: its check was not run", true, "");
    return;
  }
  const api = await startModel();
  try {
    const a = await area("opencode");
    const port = await freePort();
    const model = {
      api: "openai",
      harness: "opencode",
      baseUrl: "",
      model: "scripted",
      apiKey: "",
      contextWindow: 0,
      maxTokens: 0,
    };
    const config = {
      ...programs.opencodeConfig(model, `http://127.0.0.1:${api.port}/v1`),
      model: programs.opencodeModelId(model),
    };
    const exe = "/usr/local/bin/opencode";
    const t = await startTerminal(runner, {
      role: LANE,
      area: a.dir,
      env: {
        ...programs.runEnv(a.home, "http://127.0.0.1:8700", "trial.check", {}),
        TMPDIR: a.tmp,
        OPENCODE_DISABLE_AUTOUPDATE: "1",
        OPENCODE_SERVER_PASSWORD: randomUUID(),
      },
      start: {
        trial: "check-opencode",
        program: "opencode",
        argv: [exe, ...programs.opencodeTerminalArgs(port, a.repo, "TERMINAL-CHECK-1: reply.")],
        cwd: a.repo,
        seeds: [
          {
            path: join(a.home, ".config", "opencode", "opencode.jsonc"),
            content: JSON.stringify(config),
            mode: 0o600,
          },
        ],
        server: { argv: [exe, ...programs.opencodeServerArgs(port)], port },
      },
      ...limits,
      disk: { path: a.dir, limitBytes: 2048 * 1024 * 1024 },
      spareExe: exe,
    });
    try {
      await until("its first message's call", () => api.calls["TERMINAL-CHECK-1"] >= 1, 60_000);
      check(
        "OpenCode's terminal, attached to its own server, took its first message",
        true,
        api.calls,
      );
      await sleep(2000);
      await t.type("TERMINAL-CHECK-2: reply again.");
      await until("a typed message's call", () => api.calls["TERMINAL-CHECK-2"] >= 1, 60_000);
      check("a message typed into OpenCode's terminal was taken in", true, api.calls);
    } catch (err) {
      check("OpenCode's turns ran", false, {
        error: String(err),
        calls: api.calls,
        screen: (await t.screen().catch(() => ({ lines: [] }))).lines.slice(-12),
      });
    }
    await sleep(2000);
    const ended = await t.end();
    peak("OpenCode, its server and its terminal", await t.done);
    await sleep(500);
    check(
      "/exit ends OpenCode, and its server with it",
      ended.how === "end steps" && ended.code === 0 && laneProcesses().length === 0,
      { ended, lane: laneProcesses() },
    );
  } finally {
    api.close();
  }
}

async function claude() {
  if (!existsSync("/usr/local/bin/claude")) {
    check(
      "the image has no Claude Code (built without CLAUDE_CODE_VERSION): its check was not run",
      true,
      "",
    );
    return;
  }
  const { startAnthropicStandIn, PORT } = await import("/opt/test-anthropic/anthropic.mjs");
  const api = await startAnthropicStandIn({ token: TOKEN });
  try {
    const a = await area("claude");
    const version = execFileSync("/usr/local/bin/claude", ["--version"], { encoding: "utf8" })
      .trim()
      .split(/\s+/)[0];
    const session = randomUUID();
    const model = {
      api: "claude",
      harness: "claude-code",
      baseUrl: "https://api.anthropic.com",
      model: "claude-opus-5-5",
      apiKey: TOKEN,
      contextWindow: 1_000_000,
      maxTokens: 0,
    };
    const signals = join(a.dir, "signals.jsonl");
    const t = await startTerminal(runner, {
      role: LANE,
      area: a.dir,
      env: {
        ...programs.claudeEnv({
          home: a.home,
          apiUrl: "http://127.0.0.1:8700",
          auth: "",
          tmp: a.tmp,
        }),
        ...programs.CLAUDE_TERMINAL_ENV,
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${PORT}`,
        THERMITE_SIGNALS: signals,
      },
      start: {
        trial: "check-claude",
        program: "claude-code",
        argv: [
          "/usr/local/bin/claude",
          ...programs.claudeTerminalArgs(model, {
            session,
            first: "Say ok.",
            settings: programs.claudeTerminalSettings(programs.claudeTrialSettings()),
          }),
        ],
        cwd: a.repo,
        seeds: programs.claudeTerminalSeeds(a.home, a.repo, version),
        token: TOKEN,
        mirror: { ...programs.claudeTerminalLog(a.home, session), to: "transcript.jsonl" },
      },
      ...limits,
      disk: { path: a.dir, limitBytes: 2048 * 1024 * 1024 },
      spareExe: "/usr/local/bin/claude",
    });
    const copy = join(a.dir, "transcript.jsonl");
    const stops = () =>
      existsSync(signals)
        ? readFileSync(signals, "utf8")
            .split("\n")
            .filter((l) => l.includes('"event":"Stop"')).length
        : 0;
    try {
      await until("its first turn's end", () => stops() >= 1, 90_000);
      check(
        "Claude Code took its first message with nothing to answer, signed in from file descriptor 3",
        true,
        { version },
      );
      await t.type("Say ok again.");
      await until("its second turn's end", () => stops() >= 2, 60_000);
      // The transcript's records land after the Stop hook, and the host copies every 250 ms.
      const replies = () => lines(copy).filter((r) => r.type === "assistant").length;
      await until("both replies in the copy", () => replies() >= 2, 10_000).catch(() => false);
      check(
        "its transcript, lane-1's alone, was copied for the harness, with both turns",
        replies() >= 2,
        lines(copy)
          .map((r) => r.type)
          .slice(-12),
      );
    } catch (err) {
      check("Claude Code's turns ended", false, {
        error: String(err),
        screen: (await t.screen().catch(() => ({ lines: [] }))).lines.slice(-12),
      });
    }
    const ended = await t.end();
    check("/exit ends Claude Code", ended.how === "end steps" && ended.code === 0, ended);
    peak("Claude Code", await t.done);
  } finally {
    await api.close();
  }
}

for (const [name, part] of [
  ["the fake TUI", fakeTui],
  ["Codex", codex],
  ["OpenCode", opencode],
  ["Claude Code", claude],
  [
    "the loop's terminal mode",
    () =>
      loopTrials({ load, runner, check, area, lines, laneProcesses, sleep, until, LANE, TOKEN }),
  ],
]) {
  try {
    await part();
  } catch (err) {
    check(`${name}: the check ran`, false, err instanceof Error ? err.stack : String(err));
  }
}
runner.close();
console.log(JSON.stringify({ checks }));
process.exit(0);
