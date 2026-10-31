import assert from "node:assert/strict";
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
import { OUTPUT_MAX, READ_MAX, researchOutput } from "../../../../src/agents/tools/research.ts";
import {
  listFiles,
  readFile,
  removeFile,
  searchFiles,
  writeFile,
} from "../../../../src/harness/agents/tools/files.ts";

/** A folder with a record, a lane's working area, and a secret next to it (outside). */
function folder() {
  const base = mkdtempSync(join(tmpdir(), "thermite-rf-"));
  const root = join(base, "folder");
  const work = join(root, "work", "lane-1");
  mkdirSync(join(root, "claims"), { recursive: true });
  mkdirSync(work, { recursive: true });
  writeFileSync(join(root, "claims", "c-1.md"), "# Claim c-1: verified\n\nCaches help.\n");
  writeFileSync(join(base, "secret.txt"), "not for workers\n");
  return { base, f: { root, work } };
}

describe("a Pi research worker's file tools", () => {
  test("read and search the folder; a symlink out of it is refused, and search skips it", () => {
    const { base, f } = folder();
    symlinkSync(join(base, "secret.txt"), join(f.root, "claims", "peek.md"));
    assert.deepEqual(listFiles(f).entries, ["claims/", "work/"]);
    assert.match(readFile(f, "claims/c-1.md").text, /Caches help/);
    assert.match(readFile(f, "/claims/c-1.md", 2, 5).text, /^Claim$/);
    assert.throws(() => readFile(f, "claims/peek.md"), /outside the research folder/);
    assert.throws(() => readFile(f, "../secret.txt"), /outside the research folder/);
    assert.throws(() => listFiles(f, ".."), /outside the research folder/);
    assert.deepEqual(searchFiles(f, "CACHES").matches, ["claims/c-1.md:3: Caches help."]);
    assert.deepEqual(searchFiles(f, "^# Claim c-\\d+: verified", { regex: true }).matches, [
      "claims/c-1.md:1: # Claim c-1: verified",
    ]);
    assert.deepEqual(searchFiles(f, "not for workers").matches, [], "the symlink is not followed");
  });

  test("writes go only into the lane's working area, never through a symlink", () => {
    const { base, f } = folder();
    assert.deepEqual(writeFile(f, "work/lane-1/a/b.md", "one\n"), {
      path: join("work", "lane-1", "a", "b.md"),
      bytes: 4,
    });
    writeFile(f, "work/lane-1/a/b.md", "two\n", true);
    assert.equal(readFileSync(join(f.work, "a", "b.md"), "utf8"), "one\ntwo\n");
    assert.throws(() => writeFile(f, "claims/c-1.md", "forged"), /only in your working area/);
    assert.throws(() => writeFile(f, "work/lane-2/x.md", "x"), /only in your working area/);
    assert.throws(() => writeFile(f, "../secret.txt", "x"), /only in your working area/);
    // A link in the working area to a directory outside: nothing is written through it.
    symlinkSync(base, join(f.work, "out"));
    assert.throws(
      () => writeFile(f, "work/lane-1/out/secret.txt", "x"),
      /outside your working area/,
    );
    symlinkSync(join(base, "secret.txt"), join(f.work, "s.txt"));
    assert.throws(() => writeFile(f, "work/lane-1/s.txt", "x"), /is a symlink/);
    assert.equal(readFileSync(join(base, "secret.txt"), "utf8"), "not for workers\n");
    // Removing a link removes the link only; the area itself stays.
    removeFile(f, "work/lane-1/out");
    assert.ok(!existsSync(join(f.work, "out")) && existsSync(base));
    assert.throws(() => removeFile(f, "work/lane-1"), /the working area itself stays/);
    assert.throws(() => removeFile(f, "claims/c-1.md"), /only in your working area/);
  });
});

describe("every cut of a research tool's answer is said, with where to go on (goal 117)", () => {
  test("a read gives at most READ_MAX characters and says where the next part starts; the whole answer fits", () => {
    const { f } = folder();
    const long = Array.from({ length: 3000 }, (_, i) => `line ${i} "quoted"\n`).join("");
    writeFileSync(join(f.root, "claims", "long.md"), long);
    const first = readFile(f, "claims/long.md");
    assert.equal(first.text.length, READ_MAX);
    assert.equal(first.next_offset, READ_MAX);
    assert.match(
      String(first.more),
      new RegExp(`read_file claims/long.md with offset ${READ_MAX}`),
    );
    // As the tool returns it: whole, never cut, though its quotes and new lines are escaped.
    const out = researchOutput(first);
    assert.ok(out.length <= OUTPUT_MAX, `${out.length}`);
    assert.deepEqual(JSON.parse(out).next_offset, READ_MAX);
    const asked = readFile(f, "claims/long.md", READ_MAX, 50_000);
    assert.equal(asked.text, long.slice(READ_MAX, 2 * READ_MAX));
    assert.match(String(asked.note), /at most 10000 characters/);
    const last = readFile(f, "claims/long.md", long.length - 10);
    assert.equal(last.text.length, 10);
    assert.equal(last.next_offset, undefined, "nothing more to read");
  });

  test("a listing and a search give a page that fits, and next_skip gives the next", () => {
    const { f } = folder();
    for (let i = 0; i < 900; i++)
      writeFileSync(
        join(f.root, "claims", `c-${String(i).padStart(4, "0")}-a-long-file-name.md`),
        `Caches help ${i}.\n`,
      );
    const page = listFiles(f, "claims");
    assert.ok(page.entries.length < 901 && page.entries.length > 100);
    assert.ok(researchOutput(page).length <= OUTPUT_MAX);
    assert.equal(page.next_skip, page.entries.length);
    assert.match(String(page.more), new RegExp(`list_files claims with skip ${page.next_skip}`));
    const all: string[] = [...page.entries];
    for (let skip: number | undefined = page.next_skip; skip !== undefined; ) {
      const next = listFiles(f, "claims", skip);
      all.push(...next.entries);
      skip = next.next_skip;
    }
    assert.equal(all.length, 901, "every entry, page by page");
    assert.equal(new Set(all).size, 901, "none twice");
    const found = searchFiles(f, "caches help");
    assert.ok(found.matches.length >= 100 && found.matches.length <= 200);
    assert.ok(researchOutput(found).length <= OUTPUT_MAX);
    assert.equal(found.next_skip, found.matches.length);
    assert.match(String(found.more), /search_files again with skip/);
    const second = searchFiles(f, "caches help", { skip: found.next_skip });
    assert.notEqual(second.matches[0], found.matches[0]);
    assert.equal(second.skip, found.next_skip);
  });

  test("researchOutput: a text is cut to fit with where to read on; anything else is cut with a note; text as it is", () => {
    const text = "x".repeat(30_000);
    const out = researchOutput({
      source: "s-1",
      url: "https://example.com",
      chars: 90_000,
      offset: 1000,
      text,
    });
    assert.ok(out.length <= OUTPUT_MAX);
    const o = JSON.parse(out) as { text: string; next_offset: number; cut: string };
    assert.equal(o.next_offset, 1000 + o.text.length);
    assert.match(
      o.cut,
      new RegExp(
        `cut at character ${o.next_offset} of 90000 .*read_source s-1 with offset ${o.next_offset}`,
      ),
    );
    // Escapes count: a text of quotes is cut shorter, and still fits.
    const quoted = researchOutput({
      path: "a.md",
      chars: 20_000,
      offset: 0,
      text: '"'.repeat(20_000),
    });
    assert.ok(quoted.length <= OUTPUT_MAX);
    assert.match(JSON.parse(quoted).cut, /read_file a\.md with offset/);
    const list = researchOutput({ matches: Array.from({ length: 2000 }, (_, i) => `match ${i}`) });
    assert.ok(list.length <= OUTPUT_MAX);
    assert.match(
      list,
      /… \[cut: this answer has \d+ characters, and only its first 13800 are shown\]$/,
    );
    assert.equal(researchOutput("refused: no"), "refused: no");
    assert.equal(researchOutput({ a: 1 }), '{"a":1}');
  });
});
