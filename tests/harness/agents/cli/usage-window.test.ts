/**
 * A full usage window in a program's own terminal (goal 169; src/harness/agents/cli/usage-window.ts),
 * on a stand-in for the trial's terminal: the wait recorded as the run's, the program that goes on
 * by itself followed with nothing typed, the harness's continuation after the reset for one that
 * does not, the reset from the model proxy where the log gives none, and each way the trial ends
 * instead. The loop's terminal mode runs the same on the fake TUI in terminal.test.ts (Linux only).
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { CliHarness } from "../../../../src/harness/agents/cli/program.ts";
import {
  TERMINAL_WAIT_MAX_MS,
  waitOutWindow,
} from "../../../../src/harness/agents/cli/usage-window.ts";

/** A stand-in for the trial's terminal: the limit its log shows, whether it runs, what was done. */
function fakeTerm(limit: { resetsAt?: string } | undefined) {
  const t = {
    limit,
    alive: true,
    stopped: 0,
    until: undefined as string | undefined,
    limitShown: () => t.limit,
    running: () => t.alive,
    waitsUntil: (at: string) => {
      t.until = at;
      if (t.limit && !t.limit.resetsAt) t.limit = { resetsAt: at };
    },
    stop: async () => {
      t.stopped++;
      t.alive = false;
    },
  };
  return t;
}

const program = (id: CliHarness, name: string, goesOnAfterLimit: boolean) => ({
  id,
  name,
  terminal: { goesOnAfterLimit },
});
const claude = program("claude-code", "Claude Code", true);
const codex = program("codex", "Codex", false);

/** The loop's deps the wait reads, with what it said and recorded. */
function deps(more: Record<string, unknown> = {}) {
  const waits: { until: string; kind: string; words: string }[] = [];
  const lines: string[] = [];
  return {
    waits,
    lines,
    live: (entries: { text: string }[]) => lines.push(...entries.map((e) => e.text)),
    waiting: (w: { until: string; kind: string; words: string }) => waits.push(w),
    pollMs: 10,
    ...more,
  };
}

const inMs = (ms: number) => new Date(Date.now() + ms).toISOString();
const WORDS = "You've hit your session limit · resets 5:45am (UTC)";

/** The run that met the limit; `pump` is called at each poll, as the loop's reads the log. */
const runOf = (pump: () => void = () => undefined, deadline = Number.POSITIVE_INFINITY) => ({
  id: "t-1",
  since: Date.now() - 1000,
  deadline,
  words: WORDS,
  pump,
});

describe("a full usage window in a program's terminal", () => {
  test("Claude Code goes on by itself after the reset: the wait is the run's, nothing is typed or ended, and its own turn is followed", async () => {
    const reset = inMs(150);
    const t = fakeTerm({ resetsAt: reset });
    const d = deps();
    let pumps = 0;
    const step = await waitOutWindow(
      t,
      claude,
      d,
      runOf(() => {
        pumps++;
        // Its auto-continuation, once the reset has come: the log shows a turn.
        if (Date.now() >= Date.parse(reset) + 30) t.limit = undefined;
      }),
    );
    assert.deepEqual(step, { followed: true });
    assert.deepEqual(d.waits, [{ until: reset, kind: "rate_limit", words: WORDS }]);
    assert.equal(t.stopped, 0);
    assert.equal(t.until, undefined, "the log gave the reset");
    assert.ok(pumps > 1, "the log is read through the wait");
  });

  test("Claude Code that has not gone on after the reset and its grace is ended (SIGTERM, nothing typed), and its session goes on with the harness's continuation", async () => {
    const t = fakeTerm({ resetsAt: inMs(50) });
    const d = deps({ pauseMs: (ms: number) => Math.min(ms, 100) });
    const step = await waitOutWindow(t, claude, d, runOf());
    assert.deepEqual(step, { goOn: WORDS });
    assert.equal(t.stopped, 1);
    assert.match(
      d.lines.join("\n"),
      /Claude Code did not go on by itself after its usage window reset/,
    );
  });

  test("a program that ended during the wait, or does not go on by itself (Codex), gets the harness's continuation once the reset has come", async () => {
    for (const [p, alive] of [
      [codex, true],
      [claude, false],
    ] as const) {
      const t = Object.assign(fakeTerm({ resetsAt: inMs(80) }), { alive });
      const started = Date.now();
      const step = await waitOutWindow(t, p, deps(), runOf());
      assert.deepEqual(step, { goOn: WORDS }, p.name);
      assert.ok(Date.now() - started >= 70, `${p.name}: not before the reset`);
      assert.equal(t.stopped, 0, p.name);
    }
  });

  test("Codex's rollout gives no reset: the model proxy's answer does (its Retry-After), and the console is told it", async () => {
    const t = fakeTerm({});
    const d = deps({
      providerAnswer: () => ({
        status: 429,
        headers: { "retry-after": "1" },
        body: '{"error":{"type":"usage_limit_reached"}}',
      }),
      pauseMs: () => 30,
    });
    const step = await waitOutWindow(t, codex, d, runOf());
    assert.deepEqual(step, { goOn: WORDS });
    assert.equal(d.waits.length, 1);
    assert.equal(t.until, d.waits[0]?.until);
    const ahead = Date.parse(String(t.until)) - Date.now();
    assert.ok(ahead > 0 && ahead <= 1000, `the reset about a second away: ${ahead} ms`);
    assert.deepEqual(t.limit, { resetsAt: t.until });
  });

  test("a turn begun during the wait (the owner's input sent now) is followed", async () => {
    const t = fakeTerm({ resetsAt: inMs(60_000) });
    let n = 0;
    const step = await waitOutWindow(
      t,
      codex,
      deps(),
      runOf(() => {
        if (++n === 3) t.limit = undefined;
      }),
    );
    assert.deepEqual(step, { followed: true });
  });

  test("the trial ends instead: no reset given, one more than a day away, one after the trial's end, or a rig that drains; nothing is waited for", async () => {
    const cases = [
      { limit: {}, more: {}, error: WORDS, retry: false },
      {
        limit: { resetsAt: inMs(TERMINAL_WAIT_MAX_MS + 60_000) },
        more: {},
        error: /usage window is full until .+, more than a day away \(You've hit/,
        retry: true,
      },
      {
        limit: { resetsAt: inMs(10_000) },
        more: {},
        deadline: Date.now() + 5_000,
        error: /after the trial's own end/,
        retry: true,
      },
      {
        limit: { resetsAt: inMs(10_000) },
        more: { draining: () => true },
        error: /and the rig drains/,
        retry: true,
      },
    ];
    for (const c of cases) {
      const t = fakeTerm(c.limit);
      const d = deps(c.more);
      const step = await waitOutWindow(t, claude, d, runOf(undefined, c.deadline));
      assert.ok("end" in step, JSON.stringify(step));
      assert.equal(step.end.stopped, "error");
      assert.equal(step.end.errorKind, "rate_limit");
      if (typeof c.error === "string") assert.equal(step.end.error, c.error);
      else assert.match(String(step.end.error), c.error);
      assert.equal(step.end.retryAfter, c.retry ? c.limit.resetsAt : undefined);
      assert.deepEqual(d.waits, [], "no wait recorded");
      assert.equal(t.stopped, 0, "the loop ends the program at the trial's end");
    }
  });

  test("during the wait: a stop interrupts the trial, its end ends it, and a drain ends it with the reset", async () => {
    const stop = new AbortController();
    let n = 0;
    const interrupted = await waitOutWindow(
      fakeTerm({ resetsAt: inMs(60_000) }),
      claude,
      deps({ signal: stop.signal }),
      runOf(() => {
        if (++n === 2) stop.abort();
      }),
    );
    assert.deepEqual(interrupted, { end: { stopped: "interrupted" } });
    // Claude Code, which would be given its grace after the reset, past the trial's end.
    const wall = await waitOutWindow(
      fakeTerm({ resetsAt: inMs(300) }),
      claude,
      deps(),
      runOf(undefined, Date.now() + 600),
    );
    assert.ok("end" in wall && wall.end.stopped === "wall", JSON.stringify(wall));
    let draining = false;
    const reset = inMs(60_000);
    const drained = await waitOutWindow(
      fakeTerm({ resetsAt: reset }),
      claude,
      deps({ draining: () => draining }),
      runOf(() => {
        draining = true;
      }),
    );
    assert.ok("end" in drained, JSON.stringify(drained));
    assert.equal(drained.end.retryAfter, reset);
    assert.match(String(drained.end.error), /and the rig drains/);
  });
});
