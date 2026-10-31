import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import {
  copyTree,
  LANE_COPY_BYTES_MAX,
  LANE_COPY_FILES_MAX,
  LaneCopyRefused,
} from "../../../src/harness/research/copy.ts";

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

describe("a copy of a lane's working area", () => {
  test("copies each file a part at a time, with its hash and size; links are left out", () => {
    const from = mkdtempSync(join(tmpdir(), "thermite-lane-"));
    mkdirSync(join(from, "notes"));
    const big = Buffer.alloc(3 * 1024 * 1024 + 17, 7); // more than one part
    writeFileSync(join(from, "notes", "big.bin"), big);
    writeFileSync(join(from, "a.md"), "# a\n");
    symlinkSync("/etc/hostname", join(from, "link"));
    const to = join(mkdtempSync(join(tmpdir(), "thermite-saved-")), "saved");
    const seen = copyTree(from, to);
    assert.deepEqual([...seen.keys()].sort(), ["a.md", "notes/big.bin"]);
    assert.deepEqual(seen.get("notes/big.bin"), { sha256: sha(big), bytes: big.length });
    assert.deepEqual(readFileSync(join(to, "notes", "big.bin")), big);
    assert.ok(!existsSync(join(to, "link")));
  });

  test("an area over its limits is refused in words, before it is copied", () => {
    assert.equal(LANE_COPY_FILES_MAX, 20_000);
    assert.equal(LANE_COPY_BYTES_MAX, 4 * 2 ** 30);
    const from = mkdtempSync(join(tmpdir(), "thermite-lane-"));
    for (let i = 0; i < 4; i++) writeFileSync(join(from, `f${i}`), "x".repeat(1000));
    const to = () => join(mkdtempSync(join(tmpdir(), "thermite-saved-")), "saved");
    assert.throws(
      () => copyTree(from, to(), { files: 3, bytes: 1_000_000 }),
      (err: Error) => err instanceof LaneCopyRefused && err.message === "more than 3 files",
    );
    const bytes = to();
    assert.throws(
      () => copyTree(from, bytes, { files: 10, bytes: 3_000 }),
      (err: Error) =>
        err instanceof LaneCopyRefused && /^0\.0 GiB, more than 0 GiB$/.test(err.message),
    );
    assert.ok(!existsSync(bytes), "nothing is copied");
    assert.equal(copyTree(from, to(), { files: 4, bytes: 4_000 }).size, 4, "at the limits: copied");
  });
});
