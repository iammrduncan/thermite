#!/usr/bin/env node
// @ts-check
// Runs workspace unit tests (`packages/*/tests/**/*.test.ts`) in parallel inside a short
// temporary directory that is cleaned up on exit.
//
// Usage: node scripts/test.mjs [files or globs...]
// THERMITE_TEST_JOBS overrides concurrency (default: availableParallelism()).
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";

/** @returns {string[]} */
function discoverTests() {
  if (!existsSync("packages")) return [];
  /** @type {string[]} */
  const found = [];
  for (const pkg of readdirSync("packages", { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue;
    const testsDir = `packages/${pkg.name}/tests`;
    if (!existsSync(testsDir)) continue;
    for (const entry of readdirSync(testsDir, { recursive: true })) {
      const rel = String(entry).split("\\").join("/");
      if (rel.endsWith(".test.ts")) found.push(`${testsDir}/${rel}`);
    }
  }
  return found.sort();
}

/** @param {string} pattern */
function globToRegex(pattern) {
  return new RegExp(
    `^${pattern
      .replace(/^\.\//, "")
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*\//g, "\0")
      .replace(/\*/g, "[^/]*")
      .replace(/\0/g, "(?:.*/)?")}$`,
  );
}

const args = process.argv.slice(2);
const every = discoverTests();
const files = args.length
  ? args.flatMap((arg) =>
      arg.includes("*") ? every.filter((f) => globToRegex(arg).test(f)) : [arg],
    )
  : every;

if (files.length === 0) {
  console.error("test.mjs: no test files matched");
  process.exit(1);
}

for (const file of files) {
  if (!existsSync(file)) {
    console.error(`test.mjs: no file ${file}`);
    process.exit(2);
  }
}

const jobs = Number(process.env.THERMITE_TEST_JOBS) || availableParallelism();
const tempRoot = mkdtempSync(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "tt-"));

const result = spawnSync(
  process.execPath,
  [
    "--experimental-strip-types",
    "--disable-warning=ExperimentalWarning",
    "--test",
    `--test-concurrency=${jobs}`,
    "--test-force-exit",
    ...files,
  ],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      THERMITE_TEST_TMP: tempRoot,
      TMPDIR: tempRoot,
      TMP: tempRoot,
      TEMP: tempRoot,
    },
  },
);

/** @param {string} dir */
function openReadOnly(dir) {
  try {
    chmodSync(dir, 0o700);
    for (const name of readdirSync(dir)) {
      const child = join(dir, name);
      if (lstatSync(child).isDirectory()) openReadOnly(child);
    }
  } catch {
    // Ignore cleanup races on temporary files.
  }
}

openReadOnly(tempRoot);
rmSync(tempRoot, { recursive: true, force: true });
process.exit(result.status ?? 1);
