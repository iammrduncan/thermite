#!/usr/bin/env node
// The import-rule check (CONVENTIONS.md, "The parts and how they import"): no new import breaks
// the rule, and the list of today's exceptions, scripts/import-exceptions.json, only shrinks. It
// also holds the folder rule (CONVENTIONS.md, "Folders and names"): code outside a folder that is
// a module imports its index.ts, with no exceptions. The rules, the namespaces the folder rule
// leaves out, and their words are in scripts/checks/lib/imports.ts.
//
//   npm run check:imports               check; exits 1 on a finding
//   npm run check:imports -- --lower    drop the exceptions whose import is gone (never adds)
//   npm run check:imports -- --start    write the first list (only when there is none)
//
// It reads the files on disk that Git tracks or would add (untracked, not ignored).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  brokenText,
  compare,
  EXCEPTIONS_PATH,
  type Exceptions,
  exceptionsJson,
  LOWER_COMMAND,
  listOf,
  lower,
  scan,
} from "./lib/imports.ts";

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const args = new Set(process.argv.slice(2));
const listFile = join(root, EXCEPTIONS_PATH);

const files = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", "src"],
  { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
)
  .split("\0")
  .filter((f) => f && existsSync(join(root, f)));
const found = scan(files, (f) => readFileSync(join(root, f), "utf8"));
const write = (e: Exceptions) => writeFileSync(listFile, exceptionsJson(e));
const count = (e: Exceptions) => Object.values(e).reduce((n, ts) => n + ts.length, 0);

if (args.has("--start")) {
  if (existsSync(listFile)) {
    console.error(`check-imports: ${EXCEPTIONS_PATH} exists already; use --lower after a move.`);
    process.exit(1);
  }
  const e = listOf(found);
  write(e);
  console.log(`check-imports: wrote ${EXCEPTIONS_PATH} with ${count(e)} exceptions.`);
  process.exit(0);
}
if (!existsSync(listFile)) {
  console.error(`check-imports: ${EXCEPTIONS_PATH} is missing. Write the first one with --start.`);
  process.exit(1);
}
let exceptions = JSON.parse(readFileSync(listFile, "utf8")) as Exceptions;
if (args.has("--lower")) {
  const before = count(exceptions);
  exceptions = lower(found, exceptions);
  write(exceptions);
  console.log(`check-imports: lowered ${EXCEPTIONS_PATH}: ${count(exceptions)} (was ${before}).`);
}

const { added, gone } = compare(found, exceptions);
for (const b of added) console.error(`check-imports: ${brokenText(b)}`);
for (const g of gone)
  console.error(
    `check-imports: ${g.file} no longer imports ${g.target}. Drop the exception: ${LOWER_COMMAND}`,
  );
const summary = `${files.length} files; ${count(exceptions)} exceptions left`;
if (added.length || gone.length) {
  console.error(`check-imports: ${added.length + gone.length} findings (${summary}).`);
  process.exit(1);
}
console.log(`check-imports: ok (${summary}).`);
