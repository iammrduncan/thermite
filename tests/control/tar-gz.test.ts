import assert from "node:assert/strict";
import { buffer } from "node:stream/consumers";
import { describe, test } from "node:test";
import { gunzipSync } from "node:zlib";
import { paxRecord, tarGz } from "../../src/control/tar-gz.ts";

/**
 * The export archive's tar writer (goal 103). tests/control/exports.test.ts unpacks its archives
 * with the system's tar; these check the parts a reader relies on.
 */
describe("the tar writer", () => {
  test("a pax record's length counts its own digits, across the change from one digit to two", () => {
    for (const value of ["", "a", "ab", "abc", "x".repeat(80), "y".repeat(95)]) {
      const r = paxRecord("path", value);
      const len = Number(r.split(" ")[0]);
      assert.equal(Buffer.byteLength(r), len, JSON.stringify(r));
      assert.ok(r.endsWith(`path=${value}\n`));
    }
  });

  test("whole 512-byte blocks: each header, each file padded, and two empty blocks at the end", async () => {
    const tar = gunzipSync(
      await buffer(
        tarGz([
          { path: "a/one.txt", data: Buffer.from("hello\n") },
          { path: `a/${"n".repeat(120)}.md`, data: Buffer.alloc(513, 1) },
        ]),
      ),
    );
    assert.equal(tar.length % 512, 0);
    // one.txt: a header and one block. The long name: a pax header, its record and a header,
    // then 513 bytes in two blocks. Then the two empty blocks.
    assert.equal(tar.length, 512 * (2 + 5 + 2));
    assert.ok(tar.subarray(-1024).every((b) => b === 0));
    assert.equal(tar.subarray(0, 9).toString(), "a/one.txt");
    assert.equal(tar.subarray(257, 262).toString(), "ustar");
    // The header's checksum: the sum of its bytes with the checksum field as spaces.
    const h = Buffer.from(tar.subarray(0, 512));
    const said = Number.parseInt(h.subarray(148, 154).toString(), 8);
    h.fill(0x20, 148, 156);
    assert.equal(
      h.reduce((n, b) => n + b, 0),
      said,
    );
    assert.equal(tar.subarray(512 * 2 + 156, 512 * 2 + 157).toString(), "x", "a pax header");
    assert.match(
      tar.subarray(512 * 3, 512 * 4).toString(),
      new RegExp(`path=a/${"n".repeat(120)}\\.md\\n`),
    );
  });

  test("a file that can't be read ends the stream with an error, never a short archive", async () => {
    await assert.rejects(
      buffer(
        tarGz([{ path: "gone.bin", data: { file: "/nonexistent/thermite-tar-test", size: 4 } }]),
      ),
    );
  });
});
