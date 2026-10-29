import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { readNew } from "../../../../src/agents/programs/index.ts";
import { READ_NEW_MAX } from "../../../../src/agents/programs/opencode/events.ts";

/**
 * A program's events file, which its run appends to and the harness follows: whole lines only, from
 * where the last read ended, at most a set size at a time, and only from a plain file.
 */
describe("reading what a program's events file gained", () => {
  const dir = mkdtempSync(join(tmpdir(), "thermite-read-new-"));

  test("whole lines from where the last read ended, a cut last line left for the next", () => {
    const f = join(dir, "events.jsonl");
    writeFileSync(f, '{"a":1}\n{"b":"é"}\n{"c":');
    const first = readNew(f, 0);
    assert.deepEqual(first.lines, ['{"a":1}', '{"b":"é"}']);
    appendFileSync(f, "3}\n");
    const second = readNew(f, first.next);
    assert.deepEqual(second.lines, ['{"c":3}']);
    assert.deepEqual(readNew(f, second.next), { lines: [], next: second.next, more: false });
  });

  test("a file not there yet gives nothing", () => {
    assert.deepEqual(readNew(join(dir, "none.jsonl"), 0), { lines: [], next: 0, more: false });
  });

  test("a link in the file's place is not followed", () => {
    const other = join(dir, "other.txt");
    writeFileSync(other, "a line of another file\n");
    const link = join(dir, "linked.jsonl");
    symlinkSync(other, link);
    assert.deepEqual(readNew(link, 0), { lines: [], next: 0, more: false });
  });

  test("a folder in the file's place gives nothing", () => {
    assert.deepEqual(readNew(dir, 0), { lines: [], next: 0, more: false });
  });

  test("a file larger than one read is read in steps, each at most the read's size", () => {
    const f = join(dir, "big.jsonl");
    const line = `${"x".repeat(99)}\n`;
    writeFileSync(f, line.repeat(25));
    const seen: string[] = [];
    let at = 0;
    let steps = 0;
    for (let more = true; more; steps++) {
      const r = readNew(f, at, 1000);
      assert.ok(r.next - at <= 1000);
      seen.push(...r.lines);
      at = r.next;
      more = r.more;
    }
    assert.equal(steps, 3);
    assert.equal(seen.length, 25);
    assert.equal(at, line.length * 25);
  });

  test("by default one read takes at most 4 MiB", () => {
    const f = join(dir, "huge.jsonl");
    writeFileSync(f, `${"y".repeat(1023)}\n`.repeat(5 * 1024));
    const r = readNew(f, 0);
    assert.equal(READ_NEW_MAX, 4 * 1024 * 1024);
    assert.equal(r.next, READ_NEW_MAX);
    assert.equal(r.lines.length, 4 * 1024);
    assert.equal(r.more, true);
  });

  test("a line longer than one read is passed over, and the lines after it are read", () => {
    const f = join(dir, "long.jsonl");
    writeFileSync(f, `${"z".repeat(2500)}\n{"after":1}\n`);
    const first = readNew(f, 0, 1000);
    assert.deepEqual(first, { lines: [], next: 1000, more: true });
    const second = readNew(f, first.next, 1000);
    assert.deepEqual(second, { lines: [], next: 2000, more: true });
    const third = readNew(f, second.next, 1000);
    assert.deepEqual(third.lines, ["z".repeat(500), '{"after":1}']);
    assert.equal(third.more, false);
    // A line still being written, shorter than a read, waits for its end.
    appendFileSync(f, '{"cut":');
    assert.deepEqual(readNew(f, third.next, 1000), { lines: [], next: third.next, more: false });
  });
});
