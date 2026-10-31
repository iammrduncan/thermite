import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Terminal } from "../../../../src/agents/terminal/index.ts";
import { PiConsole } from "../../../../src/harness/agents/pi-view/index.ts";

/**
 * The harness's side of a worker's Pi view (goal 169): an input waits until the worker asks for
 * it, is given once, and settles when the worker says what became of it; one it makes no call for
 * is refused at once; at the trial's end the screen is kept and nothing more goes in.
 */

/** A terminal host that shows `data` and counts its snapshots. */
function host(data = "the view") {
  const asked: number[] = [];
  return {
    asked,
    t: {
      snapshot: async (scrollback = 0) => {
        asked.push(scrollback);
        return { cols: 120, rows: 40, data };
      },
    } as unknown as Terminal,
  };
}

describe("a Pi view's console", () => {
  test("an input waits for the worker's ask, is given once, and settles with its outcome", async () => {
    const c = new PiConsole();
    const typed = c.ownerInput({ text: "look at the loop order" });
    const first = await c.next(1_000);
    assert.deepEqual(first, { id: "1", call: { kind: "steer", text: "look at the loop order" } });
    // Given once: the next ask waits, and ends empty.
    assert.equal(await c.next(20), null);
    assert.equal(c.done("1", "typed"), true);
    await typed;
    assert.equal(c.done("1", "typed"), false, "settled once");

    // An ask that waits is given the next input as it comes.
    const asking = c.next(1_000);
    const refused = c.ownerInput({ keys: ["esc"] });
    assert.deepEqual(await asking, { id: "2", call: { kind: "interrupt" } });
    c.done("2", "refused", "the agent has no reply under way to stop");
    await assert.rejects(refused, /the agent has no reply under way to stop/);
  });

  test("an input that makes no call is refused at once, and never reaches the worker", async () => {
    const c = new PiConsole();
    await assert.rejects(c.ownerInput({ text: "/model gpt" }), /not a command of the Pi view/);
    await assert.rejects(c.ownerInput({ keys: ["down"] }), /takes one key, Esc/);
    await assert.rejects(c.ownerInput({ text: "/skill:x" }), /carries no skills/);
    assert.equal(await c.next(0), null);
  });

  test("at the trial's end the screen is kept with its scrollback, and what waits is refused", async () => {
    const c = new PiConsole();
    const h = host("\x1b[1mThermite's view\x1b[0m");
    c.attach(h.t);
    assert.equal((await c.screen())?.data, "\x1b[1mThermite's view\x1b[0m");
    const waits = c.ownerInput({ text: "/status" });
    await c.end();
    await assert.rejects(waits, /the trial is ending/);
    assert.deepEqual(h.asked, [0, 500]);
    assert.equal(c.lastScreen()?.data, "\x1b[1mThermite's view\x1b[0m");
    assert.equal(await c.next(1_000), null, "no more inputs");
    await assert.rejects(c.ownerInput({ text: "more" }), /the trial is ending/);
    c.ended(["a last line"]);
    assert.equal(c.lastScreen()?.data, "\x1b[1mThermite's view\x1b[0m", "the kept screen stays");
    assert.equal(c.limitShown(), undefined, "a worker in Pi waits for its provider in its loop");
  });

  test("a worker that ended without keeping its screen leaves its last lines", () => {
    const c = new PiConsole();
    c.ended(["one", "two"]);
    assert.deepEqual(c.lastScreen(), { cols: 120, rows: 40, data: "one\r\ntwo" });
  });
});
