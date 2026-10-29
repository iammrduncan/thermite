import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { hookArgv } from "../../../src/agents/programs/hooks/index.ts";
import type { TerminalProgram } from "../../../src/agents/programs/index.ts";
import { LocalRunner } from "../../../src/harness/broker/runner.ts";
import {
  startTerminal,
  TERMINAL_SOCKET,
  type Terminal,
} from "../../../src/harness/terminal/index.ts";
import { programStdio, SETSID } from "../../../src/harness/terminal/pty.ts";

/**
 * The terminal host on the fake TUI (tests/helpers/fake-tui.ts), through the local runner: the
 * host and the program run as the test's own user. The harness image's check
 * (tests/stand-ins/terminal/check.mjs) runs the same host under the broker, as a lane's user.
 */

const FAKE = join(import.meta.dirname, "..", "..", "helpers", "fake-tui.ts");
const node = process.execPath;
// util-linux's setsid starts the program on its terminal: Linux only, as the harness image is.
const skip = SETSID ? false : "needs util-linux's setsid (Linux), as the harness image has";
// Short: a socket's path is at most 104 bytes on some systems.
const scratch = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "tm-"));
const runner = new LocalRunner(scratch);
const pids: number[] = [];
after(() => {
  // The local runner ends the host's process group; a program has a session of its own.
  for (const pid of pids)
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // gone already
    }
});

let n = 0;
/** A run's area with the fake's home in it, and the fake on its terminal there. */
async function fake(o: {
  program?: TerminalProgram;
  session?: string;
  args?: string[];
  first?: string;
  token?: string;
  server?: number;
  area?: string;
}) {
  const area = o.area ?? join(scratch, `a${n++}`);
  const home = join(area, "home");
  const repo = join(area, "repo");
  mkdirSync(repo, { recursive: true });
  const session = o.session ?? `s${n}`;
  const signals = join(area, "signals.jsonl");
  const [command, ...hookArgs] = hookArgv("claude-code");
  const settings = JSON.stringify({
    hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command, args: hookArgs }] }] },
  });
  const t = await startTerminal(runner, {
    role: "lane-1",
    area,
    env: {
      HOME: home,
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      THERMITE_SIGNALS: signals,
      ...(o.token !== undefined ? { CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: "3" } : {}),
    },
    start: {
      trial: `t-${session}`,
      program: o.program ?? "claude-code",
      argv: [
        node,
        FAKE,
        ...(o.args ?? ["--session-id", session]),
        "--settings",
        settings,
        ...(o.first !== undefined ? ["--", o.first] : []),
      ],
      cwd: repo,
      cols: 100,
      rows: 30,
      seeds: [{ path: join(home, ".seed.json"), content: '{"trusted":true}', mode: 0o600 }],
      ...(o.token !== undefined ? { token: o.token } : {}),
      mirror: {
        dir: join(home, ".fake-tui"),
        depth: 0,
        name: `^${session}\\.jsonl$`,
        to: "session-copy.jsonl",
      },
      ...(o.server
        ? { server: { argv: [node, FAKE, "--serve", String(o.server)], port: o.server } }
        : {}),
    },
  });
  const pid = (await t.status()).pid;
  if (pid) pids.push(pid);
  const copy = join(area, "session-copy.jsonl");
  return { t, area, home, signals, copy, records: () => records(copy) };
}

/** The fake's log, as the host copied it. */
function records(copy: string): Record<string, unknown>[] {
  if (!existsSync(copy)) return [];
  return readFileSync(copy, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
}

/** Waits until `ok` gives something, at most `ms`. */
async function until<T>(what: string, ok: () => T | undefined | false, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = ok();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const seen = (
  f: Awaited<ReturnType<typeof fake>>,
  type: string,
  more: (r: Record<string, unknown>) => boolean = () => true,
) => until(`a ${type} record`, () => f.records().find((r) => r.type === type && more(r)));

async function ended(t: Terminal) {
  const e = await t.done;
  return e;
}

describe("the terminal host", { skip }, () => {
  test("a program starts on a terminal of its own, with its seeds, its size and its token on file descriptor 3", async () => {
    const f = await fake({ token: "made-up-sign-in", first: "the brief" });
    const start = await seen(f, "start");
    assert.deepEqual(start.tty, { stdin: true, stdout: true });
    assert.deepEqual(start.size, { cols: 100, rows: 30 });
    assert.equal(start.ctty, true, "the terminal is its controlling one");
    assert.equal(start.term, "xterm-256color");
    assert.deepEqual(start.token, {
      length: 15,
      sha256: createHash("sha256").update("made-up-sign-in").digest("hex").slice(0, 16),
    });
    assert.equal(readFileSync(join(f.home, ".seed.json"), "utf8"), '{"trusted":true}');
    assert.equal(statSync(join(f.home, ".seed.json")).mode & 0o777, 0o600);
    await seen(f, "user", (r) => r.text === "the brief" && r.how === "first");
    // The emulator answered its device-attributes query.
    await seen(f, "query", (r) => r.da1 === "answered");
    // Its log is its user's alone; the copy is for others to read.
    assert.equal(statSync(join(f.home, ".fake-tui", `s${n}.jsonl`)).mode & 0o777, 0o600);
    assert.equal(statSync(f.copy).mode & 0o777, 0o644);
    const screen = await until("its prompt on the screen", async () => undefined);
    void screen;
    const s = await f.t.screen();
    assert.match(s.lines[0] ?? "", /^fake-tui s\d+/);
    assert.equal(s.cols, 100);
    const snap = await f.t.snapshot();
    assert.match(snap.data, /fake-tui/);
    await f.t.end();
  });

  test("text is typed and then Enter, a paste comes whole, keys by name, and nothing in text is a key", async () => {
    const f = await fake({});
    await seen(f, "start");
    await f.t.type("hello there");
    await seen(f, "user", (r) => r.text === "hello there" && r.how === "typed");
    // Its hook ran (Thermite's hook program), and wrote the signal to the trial's signals file.
    const signal = await until("the hook's signal", () =>
      existsSync(f.signals) ? readFileSync(f.signals, "utf8").includes("UserPromptSubmit") : false,
    );
    assert.ok(signal);
    await f.t.type("line one\nline two");
    await seen(f, "user", (r) => r.text === "line one\nline two");
    await f.t.keys(["up", "page-down", "tab"]);
    await seen(f, "key", (r) => r.key === "tab");
    const keys = f
      .records()
      .filter((r) => r.type === "key")
      .map((r) => r.key);
    assert.deepEqual(keys, ["up", "page-down", "tab"]);
    await f.t.type("a\x03b\x1b[Ac");
    await seen(f, "user", (r) => r.text === "ab[Ac");
    assert.equal(f.records().filter((r) => r.type === "interrupt").length, 0);
    await f.t.end();
  });

  test("each program's interrupt is its own: Esc, Esc and /stop, Esc twice", async () => {
    const counts = { "claude-code": [1, 0], codex: [1, 1], opencode: [2, 0] } as const;
    for (const [program, [escs, stops]] of Object.entries(counts)) {
      const f = await fake({ program: program as TerminalProgram });
      await seen(f, "start");
      await f.t.interrupt();
      await new Promise((r) => setTimeout(r, 300));
      const got = f.records();
      assert.equal(got.filter((r) => r.type === "interrupt").length, escs, program);
      assert.equal(got.filter((r) => r.type === "stop").length, stops, program);
      await f.t.end();
    }
  });

  test("an end is the program's own /exit; then SIGTERM; then the broker's", async () => {
    const clean = await fake({});
    await seen(clean, "start");
    assert.deepEqual(await clean.t.end(), {
      how: "end steps",
      code: 0,
      signal: null,
      screen: (await clean.t.done).exit?.screen,
    });
    const e = await ended(clean.t);
    assert.equal(e.exit?.how, "end steps");
    assert.equal(e.outcome.exitCode, 0);
    assert.equal(existsSync(join(clean.area, TERMINAL_SOCKET)), false, "its socket is gone");

    const stubborn = await fake({
      args: ["--session-id", "s-stubborn", "--ignore-exit"],
      session: "s-stubborn",
    });
    await seen(stubborn, "start");
    const byTerm = await stubborn.t.end();
    assert.equal(byTerm.how, "sigterm");
    assert.equal(byTerm.code, 143);
    await seen(stubborn, "sigterm");
  });

  test("an end without its steps types nothing: SIGTERM at once", async () => {
    const f = await fake({});
    await seen(f, "start");
    const e = await f.t.end({ steps: false });
    assert.equal(e.how, "sigterm");
    assert.equal(e.code, 143);
    await seen(f, "sigterm");
    assert.equal(f.records().filter((r) => r.type === "exit").length, 0);
  });

  test("the program holds its terminal's own end, never the end the host types with", async () => {
    const f = await fake({});
    const start = await seen(f, "start");
    const fds = start.fds as string[];
    assert.ok(
      fds.some((l) => l.startsWith("/dev/pts/")),
      fds.join(", "),
    );
    assert.ok(!fds.some((l) => l.endsWith("ptmx")), fds.join(", "));
    await f.t.end();
  });

  test("a program that exits by itself ends the run, and a session resumed goes on in the same copy", async () => {
    const f = await fake({ session: "s-crash" });
    await seen(f, "start");
    await f.t.type("/exit");
    const e = await ended(f.t);
    assert.equal(e.exit?.how, "by itself");
    assert.equal(e.exit?.code, 0);
    const again = await fake({ session: "s-crash", args: ["--resume", "s-crash"], area: f.area });
    await seen(again, "start", (r) => r.resumed === true);
    await again.t.type("after the crash");
    await seen(again, "user", (r) => r.text === "after the crash");
    const starts = again.records().filter((r) => r.type === "start");
    assert.equal(starts.length, 2, "the copy holds each line once");
    await again.t.end();
  });

  test("the agent, as the host's own user, reaches its socket but is refused without the secret", async () => {
    const f = await fake({});
    await seen(f, "start");
    await f.t.type(`/probe ${join(f.area, TERMINAL_SOCKET)}`);
    const probe = await seen(f, "probe");
    const answers = (probe.answers as string[]).map((a) => JSON.parse(a) as { ok: boolean });
    assert.equal(answers.length, 2);
    assert.ok(
      answers.every((a) => a.ok === false),
      JSON.stringify(answers),
    );
    assert.equal(f.records().filter((r) => r.text === "from the agent").length, 0);
    await f.t.end();
  });

  test("a server starts first and ends with the program", async () => {
    const port = await new Promise<number>((resolve) => {
      const s = createServer();
      s.listen(0, "127.0.0.1", () => {
        const p = (s.address() as { port: number }).port;
        s.close(() => resolve(p));
      });
    });
    const f = await fake({ program: "opencode", server: port });
    await seen(f, "start");
    const server = join(f.home, ".fake-tui", "server.jsonl");
    assert.match(readFileSync(server, "utf8"), /"listening"/);
    await f.t.end();
    await until("the server's SIGTERM", () => readFileSync(server, "utf8").includes("sigterm"));
  });

  test("a program that cannot start says why, and the run ends", async () => {
    const area = join(scratch, "missing");
    mkdirSync(area);
    const t = await startTerminal(runner, {
      role: "lane-1",
      area,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      start: { program: "codex", argv: [join(area, "no-such-program")], cwd: area },
    });
    const e = await t.done;
    assert.equal(e.exit?.how, "by itself");
    assert.notEqual(e.exit?.code, 0);
    assert.match((e.exit?.screen ?? []).join("\n"), /no-such-program/);
  });

  test("a socket whose path would be too long is refused before anything starts", async () => {
    await assert.rejects(
      startTerminal(runner, {
        role: "lane-1",
        area: join(scratch, "x".repeat(120)),
        env: {},
        start: { program: "codex", argv: ["/bin/true"], cwd: scratch },
      }),
      /socket would be over/,
    );
  });
});

describe("the program's file descriptors on its terminal", () => {
  test("the terminal's end as 0, 1 and 2, the token's pipe as 3, and /dev/null in the host's end's place", () => {
    const fds = programStdio({ master: 9, slave: 8 }, true, 5);
    assert.deepEqual(fds, [8, 8, 8, "pipe", "ignore", "ignore", "ignore", "ignore", "ignore", 5]);
    assert.deepEqual(programStdio({ master: 6, slave: 7 }, false, 4), [
      7,
      7,
      7,
      "ignore",
      "ignore",
      "ignore",
      4,
    ]);
  });
});
