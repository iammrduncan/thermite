import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ENTER, keyBytes, typedText } from "../../../src/agents/terminal/keys.ts";

describe("what the terminal host types", () => {
  test("a named key is the bytes an xterm sends, the arrows by the cursor keys' mode", () => {
    assert.equal(keyBytes("enter", false), ENTER);
    assert.equal(keyBytes("esc", false), "\x1b");
    assert.equal(keyBytes("tab", false), "\t");
    assert.equal(keyBytes("up", false), "\x1b[A");
    assert.equal(keyBytes("up", true), "\x1bOA");
    assert.equal(keyBytes("left", true), "\x1bOD");
    assert.equal(keyBytes("page-up", true), "\x1b[5~");
    assert.equal(keyBytes("page-down", false), "\x1b[6~");
    assert.equal(keyBytes("7", false), "7");
  });

  test("text sends no key: its control characters are taken out, Esc and Ctrl+C among them", () => {
    assert.equal(typedText("a\x1b[31mb\x03c\x9bd\x7f", false), "a[31mbcd");
    assert.equal(typedText("one\r\ntwo\rthree", false), "one\ntwo\nthree");
    assert.equal(typedText("plain words", true), "plain words");
  });

  test("text with a line break or a tab, or a long text, is a bracketed paste, once the program asks for one", () => {
    assert.equal(typedText("one\ntwo", true), "\x1b[200~one\ntwo\x1b[201~");
    assert.equal(typedText("a\tb", true), "\x1b[200~a\tb\x1b[201~");
    assert.equal(typedText("one\ntwo", false), "one\ntwo");
    // A long text with no line break is a paste too: a program reads it in at once (goal 188).
    const line = `{"brief":"${"x".repeat(300)}"}`;
    assert.equal(typedText(line, true), `\x1b[200~${line}\x1b[201~`);
    assert.equal(typedText(line, false), line);
    // Text can't end the paste early: its Esc is gone.
    assert.equal(typedText("x\n\x1b[201~y", true), "\x1b[200~x\n[201~y\x1b[201~");
  });
});
