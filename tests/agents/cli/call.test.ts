// A call outside a trial in its program's own terminal (src/agents/cli/call.ts), on any system:
// the terminal host is a stand-in served on the host's own socket (serveTerminal), and the program
// a stand-in in Claude Code's place that writes its transcript as Claude Code does. The real host
// on the fake TUI is tests/harness/agents/cli/call.test.ts (Linux only).
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  type CallLink,
  claudeProgram,
  type TrialConsole,
  type TurnDelivery,
  terminalCall,
} from "../../../src/agents/cli/index.ts";
import type { ModelConfig } from "../../../src/agents/model/index.ts";
import { renderPlannerTurn } from "../../../src/agents/roles/index.ts";
import type { RoleRunner, RoleRunOutcome, RoleRunRequest } from "../../../src/agents/runner.ts";
import { TERMINAL_HOST, TERMINAL_SOCKET } from "../../../src/agents/terminal/index.ts";
import { serveTerminal } from "../../../src/agents/terminal/server.ts";

// Short: a socket's path is at most 104 bytes on some systems.
const scratch = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "ac-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
// Its entry needs Claude Code's binary found; the stand-in host never runs it.
process.env.THERMITE_CLAUDE_BIN = process.execPath;

const MODEL: ModelConfig = {
  api: "claude",
  harness: "claude-code",
  baseUrl: "https://api.anthropic.com",
  model: "claude-test",
  apiKey: "made-up-sign-in",
  contextWindow: 1_000_000,
  maxTokens: 0,
};

const plan = (note: string) => JSON.stringify({ assignments: [], notes: note });
const DRAFT = plan("a first plan");
const FINAL = plan("the owner's message came inside its turn");

/**
 * The stand-in program, as Claude Code meets an owner's message at the end of its turn: its draft,
 * then its Stop hook asked until a message comes (`polls` times at most), then the hook's block and
 * its final answer, then the turn's end; text typed meanwhile is its next turn, answered "done".
 */
class Program {
  private n = 0;
  private turns: Promise<void> = Promise.resolve();
  drafted = false;
  private readonly log: string;
  private readonly hook: () => TurnDelivery | undefined;
  private readonly polls: number;
  constructor(log: string, hook: () => TurnDelivery | undefined, polls: number) {
    this.log = log;
    this.hook = hook;
    this.polls = polls;
  }

  private record(e: Record<string, unknown>): void {
    appendFileSync(
      this.log,
      `${JSON.stringify({ sessionId: "s-1", timestamp: new Date().toISOString(), ...e })}\n`,
    );
  }

  private say(text: string): void {
    this.record({
      type: "assistant",
      message: {
        id: `msg_${++this.n}`,
        model: "claude-test",
        role: "assistant",
        content: [{ type: "text", text }],
        usage: { input_tokens: 10, output_tokens: 2 },
      },
    });
  }

  /** One message typed into it, after the turns before it. */
  typed(text: string): void {
    this.turns = this.turns.then(async () => {
      const first = this.n === 0;
      this.record({
        type: "user",
        origin: { kind: "human" },
        promptId: `p_${this.n + 1}`,
        message: { role: "user", content: text },
      });
      if (!first) this.say("done");
      else {
        this.say(DRAFT);
        this.drafted = true;
        for (let i = 0; i < this.polls; i++) {
          const d = this.hook();
          const o = d?.offer("turn-end");
          if (o) {
            d?.taken(o.offer);
            this.record({
              type: "attachment",
              attachment: {
                type: "hook_blocking_error",
                blockingError: { blockingError: o.text, command: "thermite" },
              },
            });
            this.say(FINAL);
            break;
          }
          await new Promise((r) => setTimeout(r, 50));
        }
      }
      this.record({ type: "system", subtype: "turn_duration", durationMs: 100 });
    });
  }
}

/** The runner: the host is the stand-in; the setup and the version check do nothing. */
function runner(program: (log: string) => Program): {
  r: RoleRunner;
  started: () => Program | undefined;
} {
  let p: Program | undefined;
  let end: ((o: RoleRunOutcome) => void) | undefined;
  const done = (): RoleRunOutcome => ({
    exitCode: 0,
    signal: null,
    killedFor: null,
    stdout: `${JSON.stringify({ msg: "the program ended", how: "end steps", code: 0, signal: null })}\n`,
    stderr: "",
  });
  const r: RoleRunner = {
    run: async (req: RoleRunRequest) => {
      if (req.argv[1] === TERMINAL_HOST) {
        const start = JSON.parse(req.stdin ?? "{}") as { secret: string };
        const prog = program(join(req.cwd, "claude-session.jsonl"));
        p = prog;
        let buffer = "";
        const screen = { cols: 120, rows: 40 };
        const host = {
          status: async () => ({ state: "running", ...screen, output: 1 }),
          type: async (text: string, enter: boolean) => {
            buffer += text;
            if (!enter) return;
            prog.typed(buffer);
            buffer = "";
          },
          sendKeys: async () => undefined,
          interrupt: async () => undefined,
          screenText: async () => ({
            ...screen,
            cursor: { x: 0, y: 0 },
            alternate: false,
            lines: [],
          }),
          screenSnapshot: async () => ({ ...screen, data: "" }),
          end: async () => {
            setTimeout(() => {
              server.close();
              end?.(done());
            }, 10);
            return { how: "end steps", code: 0, signal: null };
          },
        };
        const server = serveTerminal(
          host as unknown as Parameters<typeof serveTerminal>[0],
          join(req.cwd, TERMINAL_SOCKET),
          start.secret,
        );
        return new Promise<RoleRunOutcome>((resolve) => (end = resolve));
      }
      const version = req.argv.at(-1) === "--version";
      return { ...done(), stdout: version ? "2.1.308 (Claude Code)\n" : "" };
    },
    handOver: async () => undefined,
    remove: async (path) => rmSync(path, { recursive: true, force: true }),
    killRole: async () => 0,
  };
  return { r, started: () => p };
}

/** The call's link: an owner's inbox, its console and its in-turn delivery, as the harness's. */
function link() {
  const waiting: { id: number; text: string }[] = [];
  const given: { ids: number[]; how: string | undefined }[] = [];
  let console: TrialConsole | undefined;
  let inTurn: TurnDelivery | undefined;
  const l: CallLink = {
    id: "planner-r-1",
    auth: "call.made-up",
    title: "The planner",
    messages: {
      waiting: () => waiting,
      given: (ids, how) => {
        given.push({ ids, how });
        for (const id of ids) waiting.splice(waiting.findIndex((m) => m.id === id) >>> 0, 1);
      },
    },
    turn: (t, n) => renderPlannerTurn({ ...t, program: "claude-code", turn: n }),
    live: () => undefined,
    console: (c) => {
      console = c;
    },
    inTurn: (d) => {
      inTurn = d;
    },
    pollMs: 50,
  };
  return { l, waiting, given, console: () => console, inTurn: () => inTurn };
}

const until = async (what: string, ok: () => boolean) => {
  const end = Date.now() + 10_000;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};

test("an owner's message taken at its turn's end: the call answers with the turn it went on to, not its draft nor the owner's typed turn after it", async () => {
  const k = link();
  const { r, started } = runner((log) => new Program(log, k.inTurn, 200));
  const call = terminalCall(
    claudeProgram,
    MODEL,
    "plan",
    { runner: r, apiUrl: "http://127.0.0.1:1", scratchDir: scratch },
    { role: "planner", link: k.l, answer: (t) => t.trimStart().startsWith("{") },
  );
  await until("its draft", () => started()?.drafted === true);
  k.waiting.push({ id: 1, text: "Plan the tidy-up first." });
  // The owner types into it too, as the acceptance does: its next turn, which answers "done".
  await until("its console", () => k.console() !== undefined);
  const typed = await k
    .console()
    ?.input({ text: "Plan the tidy-up first.", wait: "now" }, () => {});
  assert.deepEqual(typed, { outcome: "typed" });
  const tally = await call;
  assert.equal(tally.lastText, FINAL);
  assert.deepEqual(k.given, [{ ids: [1], how: "turn-end" }]);
  assert.equal(k.console(), undefined, "its console closes with the call");
});

test("no message comes: the call answers with its first turn's text", async () => {
  const k = link();
  const { r } = runner((log) => new Program(log, k.inTurn, 3));
  const tally = await terminalCall(
    claudeProgram,
    MODEL,
    "plan",
    { runner: r, apiUrl: "http://127.0.0.1:1", scratchDir: scratch },
    { role: "planner", link: k.l, answer: (t) => t.trimStart().startsWith("{") },
  );
  assert.equal(tally.lastText, DRAFT);
  assert.deepEqual(k.given, []);
});
