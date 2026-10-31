import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { COMPOSE, engine, KEEP, repo, report, section, t0 } from "./context.mjs";
import { thermiteDir } from "./first-run.mjs";
import { home, testerEnv, work } from "./processes.mjs";
import {
  builtTags,
  daemon,
  model,
  REGISTRY_IMAGE,
  registryBox,
  registryImageWasHere,
  releaseServer,
} from "./release.mjs";

/**
 * Stops what the test started and, unless KEEP=1, removes its stack, volumes, images and folder;
 * then writes the report. The exit status says whether every check passed.
 */
export function cleanUp(failed) {
  section("clean up");
  report.minutes = Number(((Date.now() - t0) / 60_000).toFixed(1));
  report.ok = !failed && report.checks.every((c) => c.ok);
  daemon?.kill();
  releaseServer?.close();
  model?.close();
  if (KEEP) console.log(`KEEP=1: the stack runs on, and the tester's folders are in ${home}`);
  else {
    if (thermiteDir)
      spawnSync("sh", ["-c", `${COMPOSE} down -v`], {
        cwd: thermiteDir,
        env: testerEnv,
        stdio: "inherit",
      });
    if (builtTags.length) spawnSync(engine, ["rmi", "-f", ...builtTags], { stdio: "inherit" });
    if (registryBox) {
      spawnSync("docker", ["rm", "-f", registryBox], { stdio: "ignore" });
      if (!registryImageWasHere) spawnSync("docker", ["rmi", REGISTRY_IMAGE], { stdio: "ignore" });
    }
    // Dangling images only: tagged images may be other projects'.
    spawnSync(engine, ["image", "prune", "-f"], { stdio: "inherit" });
    if (engine === "podman" && process.platform === "darwin")
      spawnSync("podman", ["machine", "ssh", "sudo", "fstrim", "-a"], { stdio: "inherit" });
    try {
      rmSync(work, { recursive: true, force: true });
    } catch (err) {
      console.log(`could not remove all of ${work}: ${err?.message ?? err}`);
    }
  }
  mkdirSync(join(repo, ".dev", "acceptance"), { recursive: true });
  const file = join(
    repo,
    ".dev",
    "acceptance",
    `quick-start-${report.started_at.replace(/[:.]/g, "-")}.json`,
  );
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`report: ${file}`);
  console.log(`quick start acceptance: ${report.ok ? "OK" : "FAILED"} in ${report.minutes} min`);
  process.exitCode = report.ok ? 0 : 1;
}
