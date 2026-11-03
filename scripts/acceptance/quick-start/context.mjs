// @ts-check
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { engineOf, quickStartPlan } from "../../../tests/helpers/quick-start.ts";
import { acceptanceChecks } from "../lib/checks.mjs";

// What the test runs with: the compose command, the pages' plan, the release's version and tag.

export const repo = join(import.meta.dirname, "..", "..", "..");
export const COMPOSE = (process.env.COMPOSE ?? "podman compose").trim();
export const engine = engineOf(COMPOSE);
export const KEEP = process.env.KEEP === "1";
const docs = join(repo, "docs", "_site", "src", "content", "docs");
export const plan = quickStartPlan((p) => readFileSync(join(docs, p), "utf8"));
export const version = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).version;
export const tag = `v${version}`;
export const rig = plan.firstRun.rig;
export const control = plan.firstRun.dashboard;
// The provider the test adds in place of OpenCode, and its one model.
export const PROVIDER = "scripted";
export const MODEL = "scripted";

// ---------------------------------------------------------------- reporting

/** One step of the test in its report, with the minutes it took once the next one starts. */
/** @typedef {{ name: string, minutes?: number }} ReportStep */
/**
 * The test's report: its steps and checks, and at the end its minutes, whether it passed and the
 * error that stopped it, if one did.
 * @typedef {{
 *   started_at: string,
 *   compose: string,
 *   steps: ReportStep[],
 *   checks: import("../lib/checks.mjs").CheckRecord[],
 *   error?: string,
 *   minutes?: number,
 *   ok?: boolean,
 * }} QuickStartReport
 */

/** @type {QuickStartReport} */
export const report = {
  started_at: new Date().toISOString(),
  compose: COMPOSE,
  steps: [],
  checks: [],
};
export const t0 = Date.now();
const minutes = (/** @type {number} */ ms) => `${(ms / 60_000).toFixed(1)} min`;
let stepAt = t0;
/** @param {string} name */
export function section(name) {
  const now = Date.now();
  if (report.steps.length)
    /** @type {ReportStep} */ (report.steps.at(-1)).minutes = Number(
      ((now - stepAt) / 60_000).toFixed(2),
    );
  stepAt = now;
  report.steps.push({ name });
  console.log(`\n== ${name} (at ${minutes(now - t0)})`);
}
/** A check: it is recorded, and a failure stops the test, since each step needs the last. */
export const { check } = acceptanceChecks({ max: 400, into: report.checks, stop: true });
