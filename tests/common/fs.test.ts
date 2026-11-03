import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fileSha256, sweepTemp, writeAtomic } from "../../src/common/fs.ts";

const whole = (data: Buffer) => createHash("sha256").update(data).digest("hex");

describe("files", () => {
  test("a file's SHA-256, read a chunk at a time, is the hash of its whole bytes", () => {
    const dir = mkdtempSync(join(tmpdir(), "thermite-fs-"));
    for (const size of [0, 1, 1024 * 1024, 3 * 1024 * 1024 + 7]) {
      const data = randomBytes(size);
      const path = join(dir, `f-${size}`);
      writeFileSync(path, data);
      assert.equal(fileSha256(path), whole(data), `${size} bytes`);
    }
    assert.throws(() => fileSha256(join(dir, "none")), /ENOENT/);
  });

  test("a file written whole takes its name with its folder made", () => {
    const path = join(mkdtempSync(join(tmpdir(), "thermite-fs-")), "a", "b.txt");
    writeAtomic(path, "text", 0o600);
    assert.equal(readFileSync(path, "utf8"), "text");
  });

  test("what a crash left of writes, files and folders named .tmp-, is swept; nothing else", () => {
    const dir = mkdtempSync(join(tmpdir(), "thermite-fs-"));
    mkdirSync(join(dir, ".tmp-export", "attempts"), { recursive: true });
    writeFileSync(join(dir, ".tmp-export", "attempts", "a.patch"), "x");
    writeFileSync(join(dir, ".tmp-1234"), "x");
    mkdirSync(join(dir, "20261031T000000Z-0123abcd"));
    writeFileSync(join(dir, "keep.tmp-not-a-prefix"), "x");
    assert.deepEqual(sweepTemp(dir).sort(), [".tmp-1234", ".tmp-export"]);
    assert.deepEqual(readdirSync(dir).sort(), [
      "20261031T000000Z-0123abcd",
      "keep.tmp-not-a-prefix",
    ]);
    assert.deepEqual(sweepTemp(join(dir, "none")), []);
    assert.ok(!existsSync(join(dir, "none")));
  });
});
