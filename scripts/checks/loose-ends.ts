#!/usr/bin/env node
// The loose-ends check (CONVENTIONS.md, "Dead code and loose ends"): no export of production code
// that no other file names, and no path in a comment or a page that names no file, apart from
// today's, listed in scripts/loose-ends.json, which only shrinks. What it reads and its words are
// in scripts/checks/lib/loose-ends.ts.
//
//   npm run check:loose-ends               check; exits 1 on a finding
//   npm run check:loose-ends -- --lower    drop the exceptions that are gone (never adds)
//   npm run check:loose-ends -- --start    write the first list (only when there is none)
//
// It reads the files on disk that Git tracks or would add (untracked, not ignored).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  compare,
  EXCEPTIONS_PATH,
  type Exceptions,
  exceptionsText,
  findingText,
  LOWER_COMMAND,
  listOf,
  lower,
  missingPaths,
  unusedExports,
} from "./lib/loose-ends.ts";

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const args = new Set(process.argv.slice(2));
const listFile = join(root, EXCEPTIONS_PATH);

const files = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  },
)
  .split("\0")
  .filter((f) => f && existsSync(join(root, f)));
const texts = new Map<string, string>();
const read = (f: string) => {
  const known = texts.get(f);
  if (known !== undefined) return known;
  const text = readFileSync(join(root, f), "utf8");
  texts.set(f, text);
  return text;
};
const found = [
  ...unusedExports(files, read),
  ...missingPaths(files, read, (p) => existsSync(join(root, p))),
];
const write = (e: Exceptions) => writeFileSync(listFile, exceptionsText(e));
const count = (e: Exceptions) =>
  [...Object.values(e.exports), ...Object.values(e.paths)].reduce((n, l) => n + l.length, 0);

if (args.has("--start")) {
  if (existsSync(listFile)) {
    console.error(`check-loose-ends: ${EXCEPTIONS_PATH} exists already; use --lower.`);
    process.exit(1);
  }
  const e = listOf(found);
  write(e);
  console.log(`check-loose-ends: wrote ${EXCEPTIONS_PATH} with ${count(e)} exceptions.`);
  process.exit(0);
}
if (!existsSync(listFile)) {
  console.error(
    `check-loose-ends: ${EXCEPTIONS_PATH} is missing. Write the first one with --start.`,
  );
  process.exit(1);
}
let exceptions = JSON.parse(readFileSync(listFile, "utf8")) as Exceptions;
if (args.has("--lower")) {
  const before = count(exceptions);
  exceptions = lower(found, exceptions);
  write(exceptions);
  console.log(
    `check-loose-ends: lowered ${EXCEPTIONS_PATH}: ${count(exceptions)} (was ${before}).`,
  );
}

const { added, gone } = compare(found, exceptions);
for (const f of added) console.error(`check-loose-ends: ${findingText(f)}`);
for (const g of gone)
  console.error(
    `check-loose-ends: ${g.file} no longer has the ${g.kind} ${g.name}. Drop the exception: ${LOWER_COMMAND}`,
  );
const summary = `${files.length} files; ${count(exceptions)} exceptions left`;
if (added.length || gone.length) {
  console.error(`check-loose-ends: ${added.length + gone.length} findings (${summary}).`);
  process.exit(1);
}
console.log(`check-loose-ends: ok (${summary}).`);
