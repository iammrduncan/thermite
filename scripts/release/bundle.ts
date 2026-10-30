#!/usr/bin/env node
// Writes the release bundle, compose.yaml and README.md, from the templates in containers/release/
// and the digests of the images the release workflow pushed (.github/workflows/release.yml). The
// readme, which the workflow also makes the release's notes, gives compose.yaml's SHA-256:
//
//   node --experimental-strip-types scripts/release/bundle.ts --version 0.1.0 \
//     --registry ghcr.io/owner --repo-url https://github.com/owner/thermite \
//     --digests DIR --out DIR
//
// The --digests folder holds one file per image, named control, harness, harness-cuda,
// harness-cuda13, supervisor and rig-cuda (the one-container rig image for RunPod), each with that image's digest
// (sha256:…). It refuses a version that does not match package.json's, and a template that has
// drifted from compose.yaml.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  type BundleInput,
  bundleFiles,
  checkInput,
  IMAGE_KEYS,
  type ImageKey,
  templateDrift,
} from "../../src/release/bundle.ts";

const root = join(import.meta.dirname, "..", "..");

function fail(problems: string[]): never {
  process.stderr.write(`release-bundle: ${problems.join("\nrelease-bundle: ")}\n`);
  process.exit(1);
}

const { values } = parseArgs({
  options: {
    version: { type: "string" },
    registry: { type: "string" },
    "repo-url": { type: "string" },
    digests: { type: "string" },
    out: { type: "string" },
  },
});
const { version, registry, digests, out } = values;
const repoUrl = values["repo-url"];
if (!version || !registry || !repoUrl || !digests || !out)
  fail([
    "usage: release-bundle.ts --version V --registry R --repo-url URL --digests DIR --out DIR",
  ]);

const read = (key: ImageKey) => {
  const file = join(digests, key);
  return existsSync(file) ? readFileSync(file, "utf8").trim() : undefined;
};
const found = Object.fromEntries(IMAGE_KEYS.map((key) => [key, read(key)]));
const input = { version, registry, repoUrl, digests: found } as BundleInput;
const packageVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const problems = checkInput(input, packageVersion);
const composeTemplate = readFileSync(
  join(root, "containers/release/compose.template.yaml"),
  "utf8",
);
problems.push(...templateDrift(readFileSync(join(root, "compose.yaml"), "utf8"), composeTemplate));
if (problems.length) fail(problems);

const { compose, readme, composeSha256 } = bundleFiles(input, {
  compose: composeTemplate,
  readme: readFileSync(join(root, "containers/release/README.template.md"), "utf8"),
});
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "compose.yaml"), compose);
writeFileSync(join(out, "README.md"), readme);
process.stdout.write(
  `release-bundle: wrote ${join(out, "compose.yaml")} and ${join(out, "README.md")} for ${version}; compose.yaml's SHA-256 is ${composeSha256}\n`,
);
