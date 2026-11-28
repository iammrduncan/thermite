#!/usr/bin/env node
// @ts-check
// Runs `tsc --noEmit` across the root config and every workspace package tsconfig in parallel.
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const tscBin = join(
  process.cwd(),
  "node_modules",
  ".bin",
  process.platform === "win32" ? "tsc.cmd" : "tsc",
);

const configs = ["tsconfig.json"];
if (existsSync("packages")) {
  for (const entry of readdirSync("packages", { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (!entry.isDirectory()) continue;
    const cfg = `packages/${entry.name}/tsconfig.json`;
    if (existsSync(cfg)) configs.push(cfg);
  }
}

/**
 * @param {string} config
 * @returns {Promise<{ config: string; code: number; output: string }>}
 */
function runTsc(config) {
  return new Promise((resolve) => {
    const child = spawn(tscBin, ["--noEmit", "-p", config], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      output += String(chunk);
    });
    child.on("close", (code) => {
      resolve({ config, code: code ?? 1, output: output.trim() });
    });
  });
}

const started = performance.now();
const results = await Promise.all(configs.map(runTsc));
const failed = results.filter((r) => r.code !== 0);

for (const item of failed) {
  console.error(`\n[typecheck] ${item.config} failed:`);
  if (item.output) console.error(item.output);
}

const elapsed = ((performance.now() - started) / 1000).toFixed(2);
if (failed.length > 0) {
  console.error(`\ntypecheck: ${failed.length}/${configs.length} failed (${elapsed}s)`);
  process.exit(1);
}
console.log(`typecheck: ok (${configs.length} configs, ${elapsed}s)`);
