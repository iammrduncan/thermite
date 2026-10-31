import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { PI_VIEW_COMMANDS, piViewCall } from "../../../src/agents/pi-view/index.ts";
import { Refusal } from "../../../src/common/errors.ts";
import { PiViewCall } from "../../../src/core/api/harness/console.ts";

/**
 * The calls of a worker's Pi view (goal 169; the owner's decisions of 2026-10-27 and 2026-10-30):
 * words steer, or follow up with follow_up; Esc interrupts; /status, /compact, /mcp, /mcp
 * reconnect and /skill:NAME are its commands. Anything else is refused in words before it reaches
 * the worker, and every call it gives is one the worker's contract takes.
 */

/** The refusal's words for an input, or "" when it makes a call. */
function refusal(i: Parameters<typeof piViewCall>[0]): string {
  try {
    piViewCall(i);
    return "";
  } catch (err) {
    assert.ok(err instanceof Refusal, String(err));
    return err.message;
  }
}

describe("the Pi view's calls", () => {
  test("words steer the agent, or wait until it would stop with follow_up; Esc alone interrupts", () => {
    assert.deepEqual(piViewCall({ text: "look at the loop order first" }), {
      kind: "steer",
      text: "look at the loop order first",
    });
    assert.deepEqual(piViewCall({ text: "then run the tests", follow_up: true }), {
      kind: "follow_up",
      text: "then run the tests",
    });
    // A line that does not start with a slash is words, whatever it holds.
    assert.equal(piViewCall({ text: "use a/b paths" }).kind, "steer");
    assert.deepEqual(piViewCall({ keys: ["esc"] }), { kind: "interrupt" });
    assert.match(refusal({ keys: ["enter"] }), /takes one key, Esc/);
    assert.match(refusal({ keys: ["esc", "esc"] }), /takes one key, Esc/);
  });

  test("each command is one call; extra words and follow_up are refused", () => {
    assert.deepEqual(piViewCall({ text: "/status" }), { kind: "status" });
    assert.deepEqual(piViewCall({ text: "  /compact  " }), { kind: "compact" });
    assert.deepEqual(piViewCall({ text: "/mcp" }), { kind: "mcp" });
    assert.deepEqual(piViewCall({ text: "/mcp reconnect" }), { kind: "mcp_reconnect" });
    assert.deepEqual(piViewCall({ text: "/mcp reconnect docs" }), {
      kind: "mcp_reconnect",
      server: "docs",
    });
    assert.match(refusal({ text: "/status now" }), /\/status takes nothing after it/);
    assert.match(refusal({ text: "/compact keep the numbers" }), /\/compact takes nothing/);
    assert.match(refusal({ text: "/mcp list" }), /reconnect and at most one server's name/);
    assert.match(refusal({ text: "/mcp reconnect a b" }), /at most one server's name/);
    assert.match(refusal({ text: `/mcp reconnect ${"s".repeat(65)}` }), /at most 64 characters/);
    assert.match(refusal({ text: "/status", follow_up: true }), /not with a command \(\/status\)/);
  });

  test("/skill:NAME says that the run's kit carries no skills; another command is not the view's", () => {
    assert.equal(
      refusal({ text: "/skill:profile the kernel" }),
      "this run's kit carries no skills, so /skill:profile has nothing to load",
    );
    for (const t of ["/model gpt", "/login", "/new", "/share", "/exit"])
      assert.equal(
        refusal({ text: t }),
        `${t.split(" ")[0]} is not a command of the Pi view: it takes ${PI_VIEW_COMMANDS}, and words that do not start with / steer the agent`,
        t,
      );
  });

  test("every call it gives is one the worker's contract takes", () => {
    for (const i of [
      { text: "words" },
      { text: "words", follow_up: true as const },
      { keys: ["esc" as const] },
      { text: "/status" },
      { text: "/compact" },
      { text: "/mcp" },
      { text: "/mcp reconnect" },
      { text: "/mcp reconnect docs" },
    ])
      assert.ok(PiViewCall.safeParse(piViewCall(i)).success, JSON.stringify(i));
  });
});
