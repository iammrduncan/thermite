// Test only: a stand-in for an agent program's terminal UI, which the terminal host's tests run
// (tests/agents/terminal/) and the harness image's check (tests/stand-ins/terminal/check.mjs). It
// imports nothing of Thermite's. It draws a screen and a prompt, reads typed text, pastes and keys
// in raw mode, writes a session log as Claude Code writes its transcript (0600, in a 0700 folder
// of its home), and runs the hook its settings name, as Claude Code does. Each thing it saw is one
// JSON line of its log:
//   start      its process, its terminal (both ends a terminal, the size, a controlling terminal
//              or not, TERM), its session and whether it was resumed, and the sign-in on file
//              descriptor 3, when CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR names it (its length
//              and a hash, never it), and what its open file descriptors are, where /proc shows
//              them (Linux)
//   query      whether its device-attributes query (ESC [ c) was answered
//   user       a message: the first one (after `--`), or one typed or pasted, then Enter
//   key        a named key: tab, up, down, left, right, page-up, page-down
//   interrupt  Esc by itself
//   stop       `/stop` typed
//   probe      `/probe <socket>` typed: what the terminal host's socket answered it, a process of
//              the lane's user without the host's secret
//   sigterm    SIGTERM, on which it exits 143 (unless --ignore-term)
//   exit       `/exit` typed, on which it exits 0 (unless --ignore-exit)
//   crash      a scripted exit, below
//
// With FAKE_TUI_SCRIPT naming a JSON file (the trial loop's tests, tests/harness/agents/cli/), it
// acts as an agent program: each message (the first, or one typed) runs the script's next turn,
// whose steps write lines to its session log (`log`, under its home, `{session}` replaced by its
// session's id, in strings too), run a hook its settings name with the given fields, wait, touch a
// file under its home, or exit with a code, as a crash would. A turn past the script's runs its
// `rest`. Which turn is next is kept in its home, so a session resumed after a crash goes on.
//
// Usage: node fake-tui.ts [--session-id ID | --resume ID] [--settings JSON] [--ignore-exit]
//                         [--ignore-term] [-- first message]
//        node fake-tui.ts --version         a version, as Claude Code prints its own
//        node fake-tui.ts --serve PORT      a server for it to attach to, until SIGTERM
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  readSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { connect } from "node:net";
import { dirname, join } from "node:path";

/** What this process's open file descriptors are (Linux), each as /proc names it. */
function openFiles(): string[] {
  return readdirSync("/proc/self/fd").flatMap((n) => {
    try {
      return [readlinkSync(`/proc/self/fd/${n}`)];
    } catch {
      return [];
    }
  });
}

const args = process.argv.slice(2);
const dash = args.indexOf("--");
const flags = dash >= 0 ? args.slice(0, dash) : args;
const first = dash >= 0 ? args.slice(dash + 1).join(" ") : undefined;
const value = (f: string) => (flags.includes(f) ? flags[flags.indexOf(f) + 1] : undefined);
const home = process.env.HOME ?? process.cwd();
const folder = join(home, ".fake-tui");
mkdirSync(folder, { recursive: true, mode: 0o700 });

const serve = value("--serve");
if (args[0] === "--version") {
  process.stdout.write("2.1.308 (fake)\n");
} else if (serve) {
  const server = createServer((_req, res) => res.end("fake server\n"));
  server.listen(Number(serve), "127.0.0.1", () =>
    appendFileSync(
      join(folder, "server.jsonl"),
      `${JSON.stringify({ t: Date.now(), type: "listening", port: Number(serve) })}\n`,
    ),
  );
  process.on("SIGTERM", () => {
    appendFileSync(
      join(folder, "server.jsonl"),
      `${JSON.stringify({ t: Date.now(), type: "sigterm" })}\n`,
    );
    process.exit(0);
  });
} else {
  runTui();
}

function runTui(): void {
  const resumed = value("--resume");
  const session = resumed ?? value("--session-id") ?? `fake-${process.pid}`;
  const log = join(folder, `${session}.jsonl`);
  const record = (o: Record<string, unknown>) => {
    appendFileSync(log, `${JSON.stringify({ t: Date.now(), ...o })}\n`, { mode: 0o600 });
    chmodSync(log, 0o600);
    shown.push(
      `${o.type}${o.text !== undefined ? `: ${o.text}` : o.key !== undefined ? `: ${o.key}` : ""}`,
    );
    draw();
  };
  const hooks = (() => {
    try {
      return (
        (JSON.parse(value("--settings") ?? "{}") as { hooks?: Record<string, unknown> }).hooks ?? {}
      );
    } catch {
      return {};
    }
  })();
  /** Runs its settings' hook for `event`, as Claude Code does: no shell, the input on stdin. */
  const hook = (event: string, fields: Record<string, unknown>) => {
    const h = (
      hooks[event] as { hooks?: { command: string; args?: string[] }[] }[] | undefined
    )?.[0]?.hooks?.[0];
    if (!h) return;
    spawnSync(h.command, h.args ?? [], {
      input: JSON.stringify({
        session_id: session,
        hook_event_name: event,
        cwd: process.cwd(),
        ...fields,
      }),
      timeout: 10_000,
      stdio: ["pipe", "ignore", "ignore"],
    });
  };

  const shown: string[] = [];
  let input = "";
  const draw = () => {
    const lines = [`fake-tui ${session}`, ...shown.slice(-12), `> ${input}`];
    process.stdout.write(`\x1b[H\x1b[2J${lines.join("\r\n")}`);
  };

  let ctty = false;
  try {
    closeSync(openSync("/dev/tty", "r+"));
    ctty = true;
  } catch {
    ctty = false;
  }
  let token: { length: number; sha256: string } | undefined;
  const fd = process.env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR;
  if (fd) {
    const chunks: Buffer[] = [];
    const buf = Buffer.alloc(4096);
    try {
      for (let n = readSync(Number(fd), buf); n > 0; n = readSync(Number(fd), buf))
        chunks.push(Buffer.from(buf.subarray(0, n)));
    } catch {
      // nothing on it
    }
    const t = Buffer.concat(chunks).toString("utf8");
    token = { length: t.length, sha256: createHash("sha256").update(t).digest("hex").slice(0, 16) };
  }
  record({
    type: "start",
    pid: process.pid,
    session,
    resumed: resumed !== undefined,
    tty: { stdin: process.stdin.isTTY === true, stdout: process.stdout.isTTY === true },
    size: { cols: process.stdout.columns, rows: process.stdout.rows },
    ctty,
    term: process.env.TERM,
    ...(token ? { token } : {}),
    ...(existsSync("/proc/self/fd") ? { fds: openFiles() } : {}),
  });
  /** One step of a scripted turn. */
  type Step =
    | { lines: unknown[] }
    | { hook: string; fields?: Record<string, unknown> }
    | { waitMs: number }
    | { touch: string }
    | { exit: number };
  const script = (() => {
    const file = process.env.FAKE_TUI_SCRIPT;
    if (!file) return undefined;
    return JSON.parse(readFileSync(file, "utf8")) as {
      log: string;
      turns: Step[][];
      rest?: Step[];
    };
  })();
  const turnFile = join(folder, "script-turn");
  /** Its session's id in what it writes, as the real programs write theirs. */
  const own = (v: unknown) => JSON.stringify(v).replaceAll("{session}", session);
  let turns: Promise<void> = Promise.resolve();
  /** The script's next turn, after the turns before it. */
  const scripted = () => {
    if (!script) return;
    turns = turns.then(async () => {
      const n = existsSync(turnFile) ? Number(readFileSync(turnFile, "utf8")) : 0;
      writeFileSync(turnFile, String(n + 1));
      const at = join(home, script.log.replaceAll("{session}", session));
      mkdirSync(dirname(at), { recursive: true, mode: 0o700 });
      for (const step of script.turns[n] ?? script.rest ?? []) {
        if ("lines" in step)
          appendFileSync(at, step.lines.map((l) => `${own(l)}\n`).join(""), { mode: 0o600 });
        else if ("hook" in step) hook(step.hook, JSON.parse(own(step.fields ?? {})));
        else if ("waitMs" in step) await new Promise((r) => setTimeout(r, step.waitMs));
        else if ("touch" in step) writeFileSync(join(home, step.touch), "");
        else {
          record({ type: "crash", code: step.exit });
          process.exit(step.exit);
        }
      }
    });
  };

  if (first !== undefined) {
    record({ type: "user", text: first, how: "first" });
    hook("UserPromptSubmit", { prompt: first });
    scripted();
  }

  // Bracketed paste on, as the real programs turn it on; then a device-attributes query.
  process.stdout.write("\x1b[?2004h\x1b[c");
  let answered = false;
  setTimeout(() => {
    if (!answered) record({ type: "query", da1: "none" });
  }, 3000);

  const probe = (socket: string) => {
    const out: string[] = [];
    const one = (body: string) =>
      new Promise<void>((resolve) => {
        const s = connect(socket, () => s.write(`${body}\n`));
        let got = "";
        s.on("data", (d) => {
          got += d;
        });
        s.on("error", (e) => {
          out.push(`error: ${e.message}`);
          resolve();
        });
        s.on("close", () => {
          if (got) out.push(got.trim());
          resolve();
        });
      });
    void one(JSON.stringify({ op: "status" }))
      .then(() =>
        one(JSON.stringify({ op: "type", secret: "x".repeat(43), text: "from the agent" })),
      )
      .then(() => record({ type: "probe", answers: out }));
  };

  const submit = () => {
    const text = input;
    input = "";
    if (text === "/exit") {
      record({ type: "exit" });
      if (!flags.includes("--ignore-exit")) {
        process.stdout.write("\x1b[?2004l");
        process.exit(0);
      }
      return;
    }
    if (text === "/stop") return record({ type: "stop" });
    if (text.startsWith("/probe ")) return probe(text.slice("/probe ".length));
    record({ type: "user", text, how: "typed" });
    hook("UserPromptSubmit", { prompt: text });
    scripted();
  };

  const KEYS: Record<string, string> = {
    "\x1b[A": "up",
    "\x1b[B": "down",
    "\x1b[C": "right",
    "\x1b[D": "left",
    "\x1bOA": "up",
    "\x1bOB": "down",
    "\x1bOC": "right",
    "\x1bOD": "left",
    "\x1b[5~": "page-up",
    "\x1b[6~": "page-down",
  };
  let pending = "";
  let escTimer: ReturnType<typeof setTimeout> | undefined;
  const take = () => {
    clearTimeout(escTimer);
    while (pending) {
      if (pending.startsWith("\x1b[200~")) {
        const end = pending.indexOf("\x1b[201~");
        if (end < 0) return;
        input += pending.slice(6, end);
        pending = pending.slice(end + 6);
        draw();
        continue;
      }
      // biome-ignore lint/suspicious/noControlCharactersInRegex: a terminal's reply starts with Esc.
      const da1 = /^\x1b\[\?[\d;]*c/.exec(pending);
      if (da1) {
        answered = true;
        record({ type: "query", da1: "answered" });
        pending = pending.slice(da1[0].length);
        continue;
      }
      // biome-ignore lint/suspicious/noControlCharactersInRegex: a key's sequence starts with Esc.
      const seq = /^\x1b(\[[\d;]*[A-Za-z~]|O[A-Za-z])/.exec(pending);
      if (seq) {
        const key = KEYS[seq[0]];
        if (key) record({ type: "key", key });
        pending = pending.slice(seq[0].length);
        continue;
      }
      if (pending === "\x1b") {
        // Esc by itself, unless more follows at once.
        escTimer = setTimeout(() => {
          pending = "";
          record({ type: "interrupt" });
        }, 50);
        return;
      }
      if (pending.startsWith("\x1b")) {
        record({ type: "interrupt" });
        pending = pending.slice(1);
        continue;
      }
      const ch = pending[0] as string;
      pending = pending.slice(1);
      if (ch === "\r") submit();
      else if (ch === "\t") record({ type: "key", key: "tab" });
      else if (ch === "\x7f") input = input.slice(0, -1);
      else if (ch >= " " || ch === "\n") input += ch;
      draw();
    }
  };
  process.stdin.setRawMode(true);
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d: string) => {
    pending += d;
    take();
  });
  process.on("SIGTERM", () => {
    record({ type: "sigterm" });
    if (!flags.includes("--ignore-term")) process.exit(143);
  });
  draw();
}
