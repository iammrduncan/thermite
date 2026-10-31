#!/usr/bin/env node
// Checks each image the release workflow pushed (.github/workflows/release.yml), before it gets
// its version's tag (goal 010): it pulls each one by digest with no sign-in, reads its
// environment and the platforms it is published for, and runs a probe in it, then holds it to
// src/release/checks.ts:
//
//   node --experimental-strip-types scripts/release/check-images.ts --registry ghcr.io/owner \
//     --commit SHA --digests DIR [--summary FILE]
//
// The --digests folder is the release bundle's: one file per image (control, harness,
// harness-cuda, harness-cuda13, supervisor, rig-cuda), each with its digest. --summary appends a Markdown table of
// each image, its digest and its result (the workflow's step summary). Docker only: pulls go
// through an empty Docker configuration, so no stored sign-in is used. Exits 1 when any image
// fails a check.
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { IMAGE_KEYS, type ImageKey, imageRef } from "../../src/release/bundle.ts";
import { type ImageFacts, imageProblems, PROBE } from "../../src/release/checks.ts";

function fail(line: string): never {
  process.stderr.write(`check-images: ${line}\n`);
  process.exit(1);
}

const { values } = parseArgs({
  options: {
    registry: { type: "string" },
    commit: { type: "string" },
    digests: { type: "string" },
    summary: { type: "string" },
  },
});
const { registry, commit, digests, summary } = values;
if (!registry || !commit || !digests)
  fail("usage: check-images.ts --registry R --commit SHA --digests DIR [--summary FILE]");

// An empty configuration: no credentials, so a pull that works is one anyone can make.
const config = mkdtempSync(join(tmpdir(), "check-images-"));
const docker = (args: string[]) =>
  spawnSync("docker", args, {
    encoding: "utf8",
    env: { ...process.env, DOCKER_CONFIG: config },
    maxBuffer: 16 * 1024 * 1024,
  });

/**
 * The platforms an image is published for: its index's, leaving out attestations (platform
 * unknown); a single manifest's own, from the image pulled for linux/amd64.
 */
function platformsOf(ref: string): string[] {
  const raw = docker(["buildx", "imagetools", "inspect", "--raw", ref]);
  const index =
    raw.status === 0
      ? (JSON.parse(raw.stdout) as {
          manifests?: { platform?: { os?: string; architecture?: string } }[];
        })
      : {};
  if (index.manifests)
    return index.manifests.flatMap((m) =>
      m.platform?.os && m.platform.os !== "unknown"
        ? [`${m.platform.os}/${m.platform.architecture}`]
        : [],
    );
  const own = docker(["image", "inspect", "--format", "{{.Os}}/{{.Architecture}}", ref]);
  return own.status === 0 ? [own.stdout.trim()] : [];
}

const rows: string[] = [];
let failed = 0;
for (const key of IMAGE_KEYS) {
  const file = join(digests, key);
  if (!existsSync(file)) fail(`no digest for ${key} in ${digests}`);
  const ref = imageRef(registry, key as ImageKey, readFileSync(file, "utf8").trim());
  const pull = docker(["pull", "--quiet", "--platform", "linux/amd64", ref]);
  const facts: ImageFacts = { anonymous: pull.status === 0, env: [], probe: "", platforms: [] };
  if (facts.anonymous) {
    const env = docker(["image", "inspect", "--format", "{{json .Config.Env}}", ref]);
    facts.env = env.status === 0 ? (JSON.parse(env.stdout.trim() || "[]") as string[]) : [];
    facts.platforms = platformsOf(ref);
    const probe = docker([
      "run",
      "--rm",
      "--platform",
      "linux/amd64",
      "--user",
      "0",
      "--network",
      "none",
      "--entrypoint",
      "sh",
      ref,
      "-c",
      PROBE,
    ]);
    if (probe.status !== 0) fail(`${key}: the probe did not run: ${probe.stderr.trim()}`);
    facts.probe = probe.stdout;
    // The CUDA images are large: make room for the next one.
    docker(["image", "rm", "--force", ref]);
  } else process.stderr.write(`check-images: ${key}: ${pull.stderr.trim()}\n`);
  const problems = imageProblems(key as ImageKey, commit, facts);
  if (problems.length) failed++;
  process.stdout.write(
    `${key}: ${ref}\n${problems.length ? problems.map((p) => `  - ${p}`).join("\n") : "  ok"}\n`,
  );
  rows.push(
    `| ${key} | \`${ref}\` | ${problems.length ? problems.join("; ").replace(/\|/g, "\\|") : "ok"} |`,
  );
}
rmSync(config, { recursive: true, force: true });
if (summary)
  appendFileSync(
    summary,
    [
      "### The published images' checks",
      "",
      "| Image | Pinned by digest | Result |",
      "| --- | --- | --- |",
      ...rows,
      "",
    ].join("\n"),
  );
if (failed) fail(`${failed} of ${IMAGE_KEYS.length} images failed a check`);
process.stdout.write(`check-images: all ${IMAGE_KEYS.length} images hold\n`);
