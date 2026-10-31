#!/usr/bin/env node
// The size check (goal 125): no file in scope over 800 lines grows, and no file newly passes 800
// lines, unless scripts/size-baseline.json records a reason for it. The rule and its words are in
// scripts/checks/lib/sizes.ts.
//
//   npm run check:sizes                 check; exits 1 on a finding
//   npm run check:sizes -- --list       also list every file over 500 lines
//   npm run check:sizes -- --lower      lower the baseline after a split (never raises it)
//   npm run check:sizes -- --start      write the first baseline (only when there is none)
//
// It reads the files on disk that Git tracks or would add (untracked, not ignored), so a new
// file is checked before it is staged.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  BASELINE_PATH,
  type Baseline,
  compare,
  findingText,
  inScope,
  lineCount,
  lower,
  REVIEW_LINES,
  SPLIT_LINES,
  start,
} from "./lib/sizes.ts";

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const args = new Set(process.argv.slice(2));
const baselineFile = join(root, BASELINE_PATH);

const listed = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
)
  .split("\0")
  .filter(Boolean);

const sizes = new Map<string, number>();
for (const file of listed) {
  const path = join(root, file);
  if (!existsSync(path)) continue; // deleted on disk, not yet staged
  const text = (): string => readFileSync(path, "utf8");
  if (!inScope(file, () => text().slice(0, 2))) continue;
  sizes.set(file, lineCount(text()));
}

const write = (b: Baseline) => writeFileSync(baselineFile, `${JSON.stringify(b, null, 2)}\n`);

if (args.has("--start")) {
  if (existsSync(baselineFile)) {
    console.error(`check-sizes: ${BASELINE_PATH} exists already; use --lower after a split.`);
    process.exit(1);
  }
  const b = start(sizes);
  write(b);
  console.log(`check-sizes: wrote ${BASELINE_PATH} with ${Object.keys(b.files).length} files.`);
  process.exit(0);
}

if (!existsSync(baselineFile)) {
  console.error(`check-sizes: ${BASELINE_PATH} is missing. Write the first one with --start.`);
  process.exit(1);
}
const baseline = JSON.parse(readFileSync(baselineFile, "utf8")) as Baseline;

if (args.has("--lower")) {
  const before = Object.keys(baseline.files).length;
  const b = lower(sizes, baseline);
  write(b);
  console.log(
    `check-sizes: lowered ${BASELINE_PATH}: ${Object.keys(b.files).length} files (was ${before}).`,
  );
}

const current = args.has("--lower") ? lower(sizes, baseline) : baseline;
const findings = compare(sizes, current);
const over = (n: number) => [...sizes].filter(([, lines]) => lines > n);

if (args.has("--list")) {
  for (const [file, lines] of over(REVIEW_LINES).sort((a, b) => b[1] - a[1]))
    console.log(
      `${String(lines).padStart(6)}  ${lines > SPLIT_LINES ? "split " : "review"}  ${file}`,
    );
}
for (const f of findings) console.error(`check-sizes: ${findingText(f)}`);
const summary = `${sizes.size} files; ${over(REVIEW_LINES).length} over ${REVIEW_LINES} lines, ${over(SPLIT_LINES).length} over ${SPLIT_LINES}`;
if (findings.length) {
  console.error(
    `check-sizes: ${findings.length} finding${findings.length === 1 ? "" : "s"} (${summary}).`,
  );
  process.exit(1);
}
console.log(`check-sizes: ok (${summary}).`);
