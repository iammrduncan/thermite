import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  COMMAND_KINDS,
  CommandPayloads,
  MCP_AGENT_KINDS,
  MCP_OPERATOR_KINDS,
  MCP_OWNER_KINDS,
  OWNER_ONLY_KINDS,
  RUN_KINDS,
} from "../../src/core/commands.ts";
import {
  advisorCallId,
  confirmFirst,
  plannerCallId,
  TERMINAL_KEYS,
  TERMINAL_KEYS_MAX,
  TERMINAL_TEXT_MAX,
  terminalSource,
  typesIntoTerminals,
} from "../../src/core/terminal-input.ts";

/**
 * The terminal_input command's contract (goal 169): text or named keys for one trial's terminal,
 * no control characters in text, a confirmation for a shell command or a sign-in change, and the
 * owner's alone.
 */

const parse = (p: Record<string, unknown>) =>
  CommandPayloads.terminal_input.safeParse({ run: "js-1", trial: "t-0123456789abcdef", ...p });
const why = (p: Record<string, unknown>) => {
  const r = parse(p);
  return r.success ? "" : r.error.issues.map((i) => i.message).join("; ");
};

describe("terminal_input's payload", () => {
  test("text, or named keys from the owner's list: one of the two, waiting for a usage window's reset by default", () => {
    const text = parse({ text: "/compact" });
    assert.ok(text.success);
    assert.equal(text.data.wait, "queue");
    assert.deepEqual(parse({ keys: ["down", "down", "enter"], wait: "now" }).data, {
      run: "js-1",
      trial: "t-0123456789abcdef",
      keys: ["down", "down", "enter"],
      wait: "now",
    });
    assert.match(why({}), /give text or keys/);
    assert.match(why({ text: "a", keys: ["enter"] }), /give text or keys/);
    assert.ok(!parse({ keys: ["ctrl-c"] }).success, "Ctrl+C is not a key it sends");
    assert.ok(!(TERMINAL_KEYS as readonly string[]).includes("ctrl-c"));
    assert.ok(!parse({ keys: [] }).success);
    assert.ok(!parse({ keys: Array(TERMINAL_KEYS_MAX + 1).fill("down") }).success);
    assert.ok(!parse({ text: "a", wait: "later" }).success);
    assert.ok(!parse({ text: "a", more: 1 }).success, "nothing but its fields");
  });

  test("it names a trial's terminal, a planner's call's or an advisor's call's, and nothing else", () => {
    const run = `r${"x".repeat(63)}`;
    assert.equal(plannerCallId(run, 12345), `planner-${run}-12345`);
    assert.ok(parse({ trial: plannerCallId(run, 12345), text: "a" }).success, "the longest run");
    // An advisor's name with other characters, or a long one, still makes an id that fits.
    assert.equal(advisorCallId("reviewer-2", "js-1", 3), "advisor-reviewer-2-js-1-3");
    const long = advisorCallId("my auditor: the one with a long name", run, 123456);
    assert.equal(long, `advisor-my-auditor--the-one--${run}-123456`);
    assert.ok(parse({ trial: long, text: "a" }).success, "the longest run and name");
    assert.equal(terminalSource(plannerCallId("js-1", 2)), "planner");
    assert.equal(terminalSource(advisorCallId("auditor", "js-1", 2)), "supervisor");
    assert.equal(terminalSource("t-0123456789abcdef"), "trial:t-0123456789abcdef");
    assert.match(why({ trial: "planner js-1", text: "a" }), /a trial's id, a planner's call's/);
    assert.ok(!parse({ trial: "x".repeat(101), text: "a" }).success);
  });

  test("text holds no control characters but line breaks and tabs, and a form's CR LF is kept as LF", () => {
    assert.match(why({ text: "go\x1b[A" }), /no control characters/);
    assert.match(why({ text: "go\x03" }), /no control characters/);
    assert.match(why({ text: "go\u009b" }), /no control characters/);
    assert.match(why({ text: "  \n " }), /type some text/);
    assert.equal(parse({ text: "one\r\ntwo\tthree" }).data?.text, "one\ntwo\tthree");
    assert.ok(parse({ text: "x".repeat(TERMINAL_TEXT_MAX) }).success);
    assert.ok(!parse({ text: "x".repeat(TERMINAL_TEXT_MAX + 1) }).success);
  });

  test("follow_up, for a worker in Pi's view, goes with text only (the owner, 2026-10-30)", () => {
    assert.equal(parse({ text: "then check the tests", follow_up: true }).data?.follow_up, true);
    assert.equal(parse({ text: "go on" }).data?.follow_up, undefined, "steers by default");
    assert.match(why({ keys: ["esc"], follow_up: true }), /follow_up goes with text, not keys/);
    assert.ok(!parse({ text: "a", follow_up: false }).success, "given, it is true");
  });

  test("a shell command or a change of sign-in or settings is confirmed first", () => {
    for (const t of [
      "!rm -rf build",
      "  !ls",
      "/login",
      "/logout now",
      "/config",
      "/permissions",
    ]) {
      assert.ok(confirmFirst(t), t);
      assert.match(why({ text: t }), /confirm this input first/, t);
      assert.ok(parse({ text: t, confirm: true }).success, t);
    }
    for (const t of ["/compact", "/loginx", "/config-dir", "say !hello", "/mcp reconnect"])
      assert.equal(confirmFirst(t), undefined, t);
    assert.match(String(confirmFirst("!ls")), /shell command/);
    assert.match(String(confirmFirst("/logout")), /sign-in or settings/);
  });
});

describe("who may issue terminal_input", () => {
  test("the owner alone: from the dashboard, REST, the command line or the owner's MCP token", () => {
    for (const by of ["owner", "owner:ui", "owner:api", "owner:mcp"])
      assert.ok(typesIntoTerminals(by), by);
    for (const by of [
      "owner:operator",
      "agent:mcp",
      "reader:mcp",
      "control",
      "rig:rig-a",
      "ownerx",
    ])
      assert.ok(!typesIntoTerminals(by), by);
  });

  test("an owner-only kind about one run: over MCP for the owner's token only", () => {
    assert.ok(COMMAND_KINDS.includes("terminal_input"));
    assert.ok(OWNER_ONLY_KINDS.has("terminal_input"));
    assert.ok(RUN_KINDS.has("terminal_input"));
    assert.ok((MCP_OWNER_KINDS as readonly string[]).includes("terminal_input"));
    assert.ok(!(MCP_OPERATOR_KINDS as readonly string[]).includes("terminal_input"));
    assert.ok(!(MCP_AGENT_KINDS as readonly string[]).includes("terminal_input"));
  });
});
