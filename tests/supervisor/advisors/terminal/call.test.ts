// An advisor's call in its program's own terminal (src/supervisor/advisors/terminal/call.ts), on
// any system: the terminal host is a stand-in served on the host's own socket (serveTerminal), and
// the program a stand-in in Claude Code's place that writes its transcript as Claude Code does and
// asks the call's turn routes as Thermite's Stop hook does, with what the program's environment
// gives it. The real host runs in the images' acceptance checks (terminal.mjs, claude.mjs).
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { z } from "zod";
import { OFFER_PATH, TAKEN_PATH } from "../../../../src/agents/programs/hooks/main.ts";
import type { Prompt } from "../../../../src/agents/prompt.ts";
import { renderAuditor } from "../../../../src/agents/roles/index.ts";
import type { RoleRunner, RoleRunOutcome, RoleRunRequest } from "../../../../src/agents/runner.ts";
import { TERMINAL_HOST, TERMINAL_SOCKET } from "../../../../src/agents/terminal/index.ts";
import { serveTerminal } from "../../../../src/agents/terminal/server.ts";
import { runAdvisor } from "../../../../src/supervisor/advisors/index.ts";
import {
  AdvisorConsoles,
  type AdvisorTerminals,
} from "../../../../src/supervisor/advisors/terminal/index.ts";

// Short: a socket's path is at most 104 bytes on some systems.
const root = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "at-"));
after(() => rmSync(root, { recursive: true, force: true }));
// Its entry needs Claude Code's binary found; the stand-in host never runs it.
process.env.THERMITE_CLAUDE_BIN = process.execPath;

const Answer = z.object({
  decision: z.enum(["clear", "block", "needs_owner"]),
  reasons: z.string(),
  answers: z.array(z.object({ message: z.number(), text: z.string() })),
});
const DRAFT = JSON.stringify({ decision: "clear", reasons: "a first look", answers: [] });
const FINAL = JSON.stringify({
  decision: "needs_owner",
  reasons: "the owner asked about the timer",
  answers: [{ message: 5, text: "The timer is the judge's own." }],
});

/**
 * The stand-in program, as Claude Code meets an owner's message at the end of its turn: its draft,
 * then its Stop hook asks the call's turn routes until a message comes, then the hook's block and
 * its final answer, then the turn's end. Text typed into it later is its next turn, answered "done".
 */
class Program {
  private n = 0;
  private turns: Promise<void> = Promise.resolve();
  private readonly log: string;
  private readonly env: Record<string, string>;
  constructor(log: string, env: Record<string, string>) {
    this.log = log;
    this.env = env;
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

  /** Thermite's hook program's call, as main.ts makes it, with the program's environment. */
  private async ask(path: string, body: object): Promise<Record<string, unknown>> {
    const r = await fetch(`${this.env.THERMITE_HARNESS_URL}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.env.THERMITE_TRIAL_AUTH}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    return (await r.json()) as Record<string, unknown>;
  }

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
        for (let i = 0; i < 200; i++) {
          const o = await this.ask(OFFER_PATH, { at: "turn-end" });
          if (typeof o.offer === "string") {
            await this.ask(TAKEN_PATH, { offer: o.offer });
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
          await new Promise((r) => setTimeout(r, 25));
        }
      }
      this.record({ type: "system", subtype: "turn_duration", durationMs: 100 });
    });
  }
}

/** The advisors' runner's stand-in: the host is the stand-in; the setup and version check do nothing. */
function runner() {
  const seen = {
    env: {} as Record<string, string>,
    typed: [] as string[],
    folders: [] as string[],
  };
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
      if (!seen.folders.includes(req.cwd)) seen.folders.push(req.cwd);
      if (req.argv[1] === TERMINAL_HOST) {
        seen.env = req.env ?? {};
        const start = JSON.parse(req.stdin ?? "{}") as { secret: string };
        const prog = new Program(join(req.cwd, "claude-session.jsonl"), seen.env);
        let buffer = "";
        const screen = { cols: 120, rows: 40 };
        const host = {
          status: async () => ({ state: "running", ...screen, output: 1 }),
          type: async (text: string, enter: boolean) => {
            buffer += text;
            if (!enter) return;
            seen.typed.push(buffer);
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
          screenSnapshot: async () => ({ ...screen, data: "the auditor's screen" }),
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
  return { r, seen };
}

test("an advisor in its terminal: its prompt typed in, an owner's message inside its turn, the owner's input typed, its answer", async () => {
  const { r, seen } = runner();
  const consoles = new AdvisorConsoles();
  const lines: { kind: string; text: string; run: string }[] = [];
  // Message 3 is in its prompt already; message 5 comes once the owner has typed into it.
  const waiting = [{ id: 3, text: "Is this real?" }];
  const terminals: AdvisorTerminals = {
    runner: r,
    root,
    consoles,
    // A fresh list at each read, as the harness gives one.
    waiting: async (run, role) => (run === "js-1" && role === "auditor" ? [...waiting] : []),
    live: (l) => lines.push(l),
    pollMs: 25,
  };
  const sent: Prompt[] = [];
  const running = runAdvisor({
    runtime: { name: "auditor", runtime: "claude-code", model: "claude-test", token: "made-up" },
    prompt: (f) => renderAuditor({ pkg: { attempt: "a-1" } }, f),
    schema: Answer,
    answerSchema: {} as never,
    terminal: { terminals, run: "js-1", role: "auditor", given: [3] },
  });
  // Its console, once its terminal runs: the owner's input goes in.
  for (let i = 0; i < 400 && !consoles.calls().length; i++)
    await new Promise((res) => setTimeout(res, 10));
  const [call] = consoles.calls();
  assert.ok(call, "its console is set while its terminal runs");
  // Typed as soon as its program runs, while it gets ready: it goes in after the prompt.
  for (let i = 0; i < 400 && (await consoles.frames([call.id]))[0]?.state !== "running"; i++)
    await new Promise((res) => setTimeout(res, 10));
  assert.match(call.id, /^advisor-auditor-js-1-\d+$/);
  assert.deepEqual([call.run, call.role], ["js-1", "auditor"]);
  const later: string[] = [];
  const now = await consoles.input(
    { id: "i-1", call: call.id, text: "Look at the timer.", wait: "queue" },
    (o) => later.push(o),
  );
  assert.deepEqual(now, { outcome: "typed" });
  waiting.push({ id: 5, text: "Check the timer code." });
  const res = await running;
  assert.equal(res.error, undefined);
  assert.deepEqual(res.output, JSON.parse(FINAL));
  assert.deepEqual(res.given, [5]);
  for (const p of res.sent ?? []) sent.push(p);
  // Its first message, then the owner's message as its role put it, a later turn of the auditor.
  assert.equal(sent.length, 2);
  assert.equal(sent[1]?.role, "auditor");
  assert.equal(sent[1]?.turn, 1);
  // What the program got: its prompt, typed, then the owner's input.
  assert.match(seen.typed[0] ?? "", /You audit a candidate change/);
  assert.ok(seen.typed.includes("Look at the timer."));
  // Its hooks reach the call's own turn routes on localhost, with the call's credential.
  assert.match(seen.env.THERMITE_HARNESS_URL ?? "", /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.match(seen.env.THERMITE_TRIAL_AUTH ?? "", /^call\.[0-9a-f]{48}$/);
  // Its lines in the run's live view, named for it; its console gone, its last screen kept.
  assert.ok(lines.every((l) => l.run === "js-1" && l.text.startsWith("auditor: ")));
  assert.ok(
    lines.some((l) => /the owner's message #5 went in at the end of its turn/.test(l.text)),
  );
  assert.deepEqual(consoles.calls(), []);
  const [frame] = await consoles.frames([call.id]);
  assert.deepEqual([frame?.state, frame?.data], ["ended", "the auditor's screen"]);
  await assert.rejects(
    consoles.input({ id: "i-2", call: call.id, text: "late", wait: "queue" }, () => undefined),
    /not running in its terminal now/,
  );
  // Its folder was one of the runs' root's children, and is gone.
  assert.equal(seen.folders.length, 1);
  assert.match(seen.folders[0] ?? "", new RegExp(`^${root}/thermite-advisor-`));
  assert.equal(existsSync(seen.folders[0] ?? ""), false);
  assert.deepEqual(readdirSync(root), []);
});

test("headless when no terminal is given, or in a runtime that does not run in one", async () => {
  const consoles = new AdvisorConsoles();
  const res = await runAdvisor({
    runtime: {
      name: "auditor",
      runtime: "cli",
      argv: ["sh", "-c", `echo '${DRAFT}'`],
      restricted: true,
    },
    prompt: (f) => renderAuditor({ pkg: { attempt: "a-1" } }, f),
    schema: Answer,
    answerSchema: {} as never,
    terminal: {
      terminals: {
        runner: runner().r,
        root,
        consoles,
        waiting: async () => [],
        live: () => undefined,
      },
      run: "js-1",
      role: "auditor",
      given: [],
    },
  });
  assert.deepEqual(res.output, JSON.parse(DRAFT));
  assert.deepEqual(consoles.calls(), []);
});
