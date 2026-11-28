#!/usr/bin/env node
// @ts-check
// Fast local check pipeline (< 60s): typecheck, lint, public check, design-system check,
// unit tests, and conditional UI build (when packages/ui or packages/design-system changed,
// or when --all is passed).
import { execFileSync, spawnSync } from "node:child_process";

const forceAll = process.argv.includes("--all");
const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";

/** @returns {boolean} */
function uiTouched() {
  if (forceAll) return true;
  try {
    const out = execFileSync(
      "git",
      ["status", "--porcelain", "--", "packages/ui", "packages/design-system"],
      { encoding: "utf8" },
    );
    return out.trim().length > 0;
  } catch {
    return true;
  }
}

/** @type {Array<{ name: string; args: string[] }>} */
const steps = [
  { name: "typecheck", args: ["run", "typecheck"] },
  { name: "lint", args: ["run", "lint"] },
  { name: "check:public", args: ["run", "check:public"] },
  { name: "check:design", args: ["run", "check:design"] },
  { name: "test", args: ["test"] },
];

const runUiBuild = uiTouched();
if (runUiBuild) steps.push({ name: "build:ui", args: ["run", "build:ui"] });

const totalStart = performance.now();
/** @type {Array<{ name: string; seconds: string }>} */
const timings = [];

for (const step of steps) {
  console.log(`\n==> ${step.name}`);
  const start = performance.now();
  const res = spawnSync(npmCmd, step.args, { stdio: "inherit" });
  const seconds = ((performance.now() - start) / 1000).toFixed(2);
  if (res.status !== 0) {
    console.error(`\ncheck: ${step.name} failed after ${seconds}s`);
    process.exit(res.status ?? 1);
  }
  timings.push({ name: step.name, seconds });
}

if (!runUiBuild) {
  console.log(
    "\n==> build:ui (skipped: no changes in packages/ui or packages/design-system; pass --all to run)",
  );
}

const total = ((performance.now() - totalStart) / 1000).toFixed(2);
const breakdown = timings.map((t) => `${t.name}=${t.seconds}s`).join(", ");
console.log(`\ncheck: ok in ${total}s (${breakdown})`);
