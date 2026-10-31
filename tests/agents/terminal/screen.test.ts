import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Screen } from "../../../src/agents/terminal/screen.ts";

/** A screen whose replies to the program are kept. */
function screen(o: { cols?: number; rows?: number; scrollback?: number } = {}) {
  const replies: string[] = [];
  const s = new Screen({
    cols: o.cols ?? 40,
    rows: o.rows ?? 10,
    scrollback: o.scrollback ?? 100,
    reply: (d) => replies.push(d),
  });
  return { s, replies };
}

describe("the terminal host's screen", () => {
  test("it answers a program's device-attributes and cursor queries, as a terminal does", async () => {
    const { s, replies } = screen();
    s.write("ab\x1b[c\x1b[6n");
    await s.settled();
    assert.ok(
      replies.some((r) => r.startsWith("\x1b[?") && r.endsWith("c")),
      JSON.stringify(replies),
    );
    assert.ok(replies.includes("\x1b[1;3R"), JSON.stringify(replies));
  });

  test("it gives the screen as plain lines, with the cursor and which screen is up", async () => {
    const { s } = screen();
    s.write("hello\r\nworld");
    const t = await s.text();
    assert.deepEqual(t.lines, ["hello", "world"]);
    assert.deepEqual(t.cursor, { x: 5, y: 1 });
    assert.equal(t.alternate, false);
    assert.equal(t.cols, 40);
    s.write("\x1b[?1049h\x1b[Hfull screen");
    const full = await s.text();
    assert.equal(full.alternate, true);
    assert.deepEqual(full.lines, ["full screen"]);
  });

  test("it knows the modes a program turns on: bracketed paste and its cursor keys", async () => {
    const { s } = screen();
    await s.settled();
    assert.equal(s.bracketedPaste, false);
    assert.equal(s.applicationCursor, false);
    s.write("\x1b[?2004h\x1b[?1h");
    await s.settled();
    assert.equal(s.bracketedPaste, true);
    assert.equal(s.applicationCursor, true);
  });

  test("a snapshot restores the screen in a terminal of its size", async () => {
    const { s } = screen();
    s.write("\x1b[1;31mred\x1b[0m and plain\r\n> typed");
    const snap = await s.snapshot(0);
    const { s: other } = screen();
    other.write(snap.data);
    assert.deepEqual((await other.text()).lines, (await s.text()).lines);
    // Its colours too: red, as the program set it.
    assert.match(snap.data, /\[[\d;]*31[\d;]*mred/);
  });

  test("its scrollback is bounded, and a snapshot gives no more of it than asked", async () => {
    const { s } = screen({ rows: 5, scrollback: 10 });
    for (let i = 0; i < 50; i++) s.write(`line ${i}\r\n`);
    const all = (await s.snapshot(1000)).data.split("\r\n").filter((l) => l.includes("line"));
    assert.ok(all.length <= 15, `${all.length} lines`);
    assert.ok(all.some((l) => l.includes("line 49")));
    const two = (await s.snapshot(2)).data.split("\r\n").filter((l) => l.includes("line"));
    assert.ok(two.length < all.length);
  });
});
