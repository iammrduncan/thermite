#!/usr/bin/env node
// Stages a smoke campaign for a rig that is not under local compose (for example a GPU rig
// in a cluster): git bundles of the smoke project and its kit, an assign_campaign payload that
// pins both by commit and sha256, and one patch per candidate with its expected outcome.
//
// usage: node scripts/acceptance/stage-smoke.mjs --kit smoke-cpu|smoke-cuda --out DIR [--run ID] [--version N]
//        [--target-class C]   (required for smoke-cuda: the GPU class the rig reports)
//
// The run is judge-only (--agents off): an acceptance measures the judge, and workers on a rig
// with a model route would otherwise start, use the device and add noise to the calibration.
//
// Copy DIR/repos/* into the rig's inbox under repos/, issue DIR/assign-payload.json through
// control as an assign_campaign command, then submit DIR/candidates/*.patch from inside the
// harness.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    kit: { type: "string", default: "smoke-cuda" },
    out: { type: "string" },
    run: { type: "string", default: "smoke-gpu-1" },
    "target-class": { type: "string" },
    // A rig's ledger keeps every contract version: restaging a changed smoke needs a new one.
    version: { type: "string", default: "1" },
  },
});
if (!values.out) throw new Error("--out DIR is required");
const kitName = values.kit;
const projectDir =
  kitName === "smoke-cuda" ? "examples/smoke-cuda-project" : "examples/smoke-project";
const out = resolve(values.out);
mkdirSync(join(out, "repos"), { recursive: true });
mkdirSync(join(out, "candidates"), { recursive: true });

const git = (cwd, ...args) =>
  execFileSync(
    "git",
    [
      "-c",
      "user.name=thermite",
      "-c",
      "user.email=thermite@localhost",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd, encoding: "utf8" },
  ).trim();

function bundle(from, name, exclude = []) {
  const repo = mkdtempSync(join(tmpdir(), `thermite-${name}-`));
  cpSync(from, repo, { recursive: true, filter: (src) => !exclude.some((e) => src.includes(e)) });
  git(repo, "init", "--quiet", "-b", "main");
  git(repo, "add", "-A");
  git(repo, "commit", "--quiet", "-m", `${name} seed`);
  const file = join(out, "repos", `${name}.bundle`);
  git(repo, "bundle", "create", "--quiet", file, "--all");
  const sha256 = createHash("sha256").update(readFileSync(file)).digest("hex");
  return { repo, commit: git(repo, "rev-parse", "HEAD"), path: `repos/${name}.bundle`, sha256 };
}

const projectName = `${kitName}-project`;
const project = bundle(projectDir, projectName);
const kit = bundle(`kits/${kitName}`, `${kitName}-kit`, ["/candidates"]);

const contract = JSON.parse(readFileSync("examples/contracts/smoke-cpu.json", "utf8"));
contract.campaign = kitName;
contract.version = Number(values.version);
contract.title = `Smoke campaign (${kitName})`;
contract.project = {
  repo: projectName,
  commit: project.commit,
  kit: { repo: `${kitName}-kit`, commit: kit.commit },
};
if (kitName === "smoke-cuda") {
  const targetClass = values["target-class"];
  if (!targetClass) {
    console.error("smoke-cuda needs --target-class (the GPU model's class, as the rig reports it)");
    process.exit(2);
  }
  contract.target = { type: "cuda-gpu", class: targetClass };
  contract.editable_paths = ["src/kernel/**"];
  contract.notes = "Smoke campaign for judge acceptance on a GPU rig.";
}
const contractFile = join(out, "contract.json");
writeFileSync(contractFile, `${JSON.stringify(contract, null, 2)}\n`);

const payload = execFileSync(
  "node",
  [
    "dist/cli/thermite/main.js",
    "assign-payload",
    "--contract",
    contractFile,
    "--run",
    values.run,
    "--seed-repo",
    projectName,
    "--seed-commit",
    project.commit,
    "--bundle",
    project.path,
    "--bundle-sha256",
    project.sha256,
    "--kit-repo",
    `${kitName}-kit`,
    "--kit-commit",
    kit.commit,
    "--kit-bundle",
    kit.path,
    "--kit-bundle-sha256",
    kit.sha256,
    "--agents",
    "off",
  ],
  { encoding: "utf8" },
);
writeFileSync(join(out, "assign-payload.json"), payload);

const candidates = JSON.parse(readFileSync(`kits/${kitName}/candidates/candidates.json`, "utf8"));
for (const name of Object.keys(candidates)) {
  const wt = mkdtempSync(join(tmpdir(), "thermite-cand-"));
  execFileSync("git", ["clone", "--quiet", project.repo, wt]);
  cpSync(`kits/${kitName}/candidates/${name}`, wt, { recursive: true });
  execFileSync("git", ["add", "-A"], { cwd: wt });
  writeFileSync(
    join(out, "candidates", `${name}.patch`),
    execFileSync("git", ["diff", "--cached", "--binary"], { cwd: wt }),
  );
  rmSync(wt, { recursive: true, force: true });
}
writeFileSync(
  join(out, "candidates", "candidates.json"),
  `${JSON.stringify(candidates, null, 2)}\n`,
);
writeFileSync(
  join(out, "manifest.json"),
  `${JSON.stringify({ kit: kitName, run: values.run, project, kit_bundle: kit }, null, 2)}\n`,
);
console.log(`staged ${kitName} in ${out}`);
