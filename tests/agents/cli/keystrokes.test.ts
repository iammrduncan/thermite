import assert from "node:assert/strict";
import { test } from "node:test";
import { TrialConsole } from "../../../src/agents/cli/console.ts";
import { Screens } from "../../../src/control/live/screens.ts";

/** A console over a terminal that records the keys it is given. */
function consoleOf(o: { pi?: boolean } = {}) {
  const wrote: string[] = [];
  const term = {
    ownerInput: async () => undefined,
    ...(o.pi ? {} : { ownerRaw: async (d: string) => void wrote.push(d) }),
    limitShown: () => undefined,
    screen: async () => undefined,
    lastScreen: () => undefined,
  };
  return { c: new TrialConsole(term), wrote };
}

test("keys pressed on Live go to the program as they came, and each line is told at its Enter (goal 187)", async () => {
  const { c, wrote } = consoleOf();
  const lines: string[] = [];
  const typed = (l: string) => lines.push(l);
  await c.keystrokes("chec", typed);
  await c.keystrokes("kx\x7f the timer\r", typed);
  // An arrow is a key, not text; a pasted block's line breaks are text.
  await c.keystrokes("\x1b[A\x1b[200~one\rtwo\x1b[201~\r", typed);
  assert.deepEqual(wrote, ["chec", "kx\x7f the timer\r", "\x1b[A\x1b[200~one\rtwo\x1b[201~\r"]);
  assert.deepEqual(lines, ["check the timer", "one\ntwo"]);
  assert.equal(c.held, undefined);
});

test("an Enter on a shell command or a sign-in's line is held once; the next Enter sends it (goal 187)", async () => {
  const { c, wrote } = consoleOf();
  const lines: string[] = [];
  await c.keystrokes("!rm -rf build\r", (l) => lines.push(l));
  assert.deepEqual(wrote, ["!rm -rf build"], "the Enter was held");
  assert.equal(c.held, "!rm -rf build");
  assert.equal(lines.length, 0, "no line yet");
  await c.keystrokes("\r", (l) => lines.push(l));
  assert.deepEqual(wrote, ["!rm -rf build", "\r"]);
  assert.deepEqual(lines, ["!rm -rf build"]);
  assert.equal(c.held, undefined);
  // A change to the line after the hold asks again.
  await c.keystrokes("/login\r", (l) => lines.push(l));
  assert.equal(c.held, "/login");
  await c.keystrokes(" now\r", (l) => lines.push(l));
  assert.equal(c.held, "/login now");
  // A command that only starts like one is not held.
  await c.keystrokes("\x15/loginx\r", (l) => lines.push(l));
  assert.equal(c.held, undefined);
  assert.equal(lines.at(-1), "/loginx");
});

test("a Pi view takes typed lines, not keys, and an ended trial takes nothing (goal 187)", async () => {
  const pi = consoleOf({ pi: true }).c;
  await assert.rejects(
    pi.keystrokes("hi", () => undefined),
    /Pi view, which takes typed lines/,
  );
  const { c } = consoleOf();
  c.close("over");
  await assert.rejects(
    c.keystrokes("hi", () => undefined),
    /the trial has ended/,
  );
});

test("control keeps the keys for a watched terminal until the rig's next ask, and says the owner types (goal 187)", () => {
  const s = new Screens();
  assert.equal(s.press("rig-a", "t-01", "x"), false, "not watched");
  const stop = s.watch("rig-a", "t-01");
  assert.ok(stop);
  assert.equal(s.press("rig-a", "t-01", "ab", 1_000), true);
  assert.equal(s.press("rig-a", "t-01", "c\r", 1_100), true);
  assert.equal(s.typing("rig-a", 2_000), true);
  assert.equal(s.typing("rig-a", 9_000), false);
  assert.deepEqual(s.takeKeys("rig-a"), [{ trial: "t-01", data: "abc\r" }]);
  assert.deepEqual(s.takeKeys("rig-a"), [], "handed over once");
});
