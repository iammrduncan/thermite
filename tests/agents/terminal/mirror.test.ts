import assert from "node:assert/strict";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { Mirror } from "../../../src/agents/terminal/mirror.ts";

/** A home with a session log in a private folder, as Claude Code keeps its transcript. */
function place() {
  const root = mkdtempSync(join(tmpdir(), "thermite-mirror-"));
  const dir = join(root, "home", "projects");
  const project = join(dir, "-workspace");
  mkdirSync(project, { recursive: true, mode: 0o700 });
  return { root, dir, log: join(project, "s1.jsonl"), to: join(root, "copy.jsonl") };
}

const mirror = (p: ReturnType<typeof place>, max?: number) =>
  new Mirror({ dir: p.dir, depth: 1, name: "^s1\\.jsonl$", to: p.to, ...(max ? { max } : {}) });

describe("the terminal host's copy of the session log", () => {
  test("a log only its user may read is copied, as it grows, into a file others may read", () => {
    const p = place();
    const m = mirror(p);
    m.step();
    assert.equal(m.state().from, undefined, "no log yet: nothing copied");
    writeFileSync(p.log, '{"n":1}\n', { mode: 0o600 });
    m.step();
    assert.equal(readFileSync(p.to, "utf8"), '{"n":1}\n');
    assert.equal(statSync(p.to).mode & 0o777, 0o644);
    appendFileSync(p.log, '{"n":2}\n{"n":3');
    m.step();
    assert.equal(readFileSync(p.to, "utf8"), readFileSync(p.log, "utf8"));
    assert.deepEqual(m.state(), { from: p.log, bytes: 22, stopped: undefined });
  });

  test("a log found only through a link, or deeper than asked, is not copied", () => {
    const p = place();
    writeFileSync(join(p.root, "secret.txt"), "not the log\n");
    symlinkSync(join(p.root, "secret.txt"), p.log);
    const m = mirror(p);
    m.step();
    assert.equal(m.state().from, undefined);
    const deep = place();
    mkdirSync(join(deep.dir, "a", "b"), { recursive: true });
    writeFileSync(join(deep.dir, "a", "b", "s1.jsonl"), "too deep\n");
    const d = mirror(deep);
    d.step();
    assert.equal(d.state().from, undefined);
  });

  test("a link in the copy's place is removed, and what it points to left alone", () => {
    const p = place();
    const target = join(p.root, "other.txt");
    writeFileSync(target, "keep me\n");
    symlinkSync(target, p.to);
    writeFileSync(p.log, "line\n", { mode: 0o600 });
    const m = mirror(p);
    m.step();
    assert.equal(readFileSync(target, "utf8"), "keep me\n");
    assert.equal(readFileSync(p.to, "utf8"), "line\n");
  });

  test("a host started again goes on from the copy's size; a log made shorter is copied again", () => {
    const p = place();
    writeFileSync(p.log, "one\n", { mode: 0o600 });
    mirror(p).step();
    appendFileSync(p.log, "two\n");
    const again = mirror(p);
    again.step();
    assert.equal(readFileSync(p.to, "utf8"), "one\ntwo\n");
    writeFileSync(p.log, "new\n");
    again.step();
    assert.equal(readFileSync(p.to, "utf8"), "new\n");
  });

  test("the copy stops at its most, and says why", () => {
    const p = place();
    writeFileSync(p.log, "0123456789\n", { mode: 0o600 });
    const m = mirror(p, 8);
    m.step();
    assert.equal(readFileSync(p.to, "utf8"), "01234567");
    m.step();
    assert.match(m.state().stopped ?? "", /passed 8 bytes/);
    appendFileSync(p.log, "more\n");
    m.step();
    assert.equal(readFileSync(p.to, "utf8"), "01234567");
  });
});
