import { createHash } from "node:crypto";

/**
 * The release bundle: a compose file that pins the published images by digest, and a short
 * readme, which is also the release's notes and gives the compose file's SHA-256. The release
 * workflow (.github/workflows/release.yml) pushes the images, then scripts/release/bundle.ts
 * fills in the templates in containers/release/ with their digests. These functions do the
 * filling and the checks, with no files or network of their own.
 */

const BOTH = ["linux/amd64", "linux/arm64"] as const;
const AMD64 = ["linux/amd64"] as const;

/**
 * The published images: each one's repository under the registry, its tag's suffix and the
 * platforms it is published for (the release's checks hold it to them).
 */
export const IMAGES = {
  control: { repository: "thermite-control", suffix: "", platforms: BOTH },
  harness: { repository: "thermite-harness", suffix: "", platforms: BOTH },
  // The CUDA harnesses are the same package as the CPU harness (goal 132): CUDA 12 under tags
  // ending in -cuda (Pascal to Hopper), CUDA 13 under -cuda13 (Turing to Blackwell, DGX Spark).
  "harness-cuda": { repository: "thermite-harness", suffix: "-cuda", platforms: AMD64 },
  "harness-cuda13": { repository: "thermite-harness", suffix: "-cuda13", platforms: BOTH },
  supervisor: { repository: "thermite-supervisor", suffix: "", platforms: BOTH },
  // The one-container rig image RunPod pods run, built on the CUDA 12 harness. Control launches it.
  "rig-cuda": { repository: "thermite-rig", suffix: "-cuda", platforms: AMD64 },
} as const;

export type ImageKey = keyof typeof IMAGES;
export const IMAGE_KEYS = Object.keys(IMAGES) as ImageKey[];

export interface BundleInput {
  /** The release's version, without the tag's `v`: `0.1.0`, `0.1.0-rc.1`. */
  version: string;
  /** Where the images are, such as `ghcr.io/owner`. */
  registry: string;
  /** The repository's web address, such as `https://github.com/owner/thermite`. */
  repoUrl: string;
  /** Each image's manifest digest, `sha256:` and 64 hexadecimal characters. */
  digests: Record<ImageKey, string>;
}

const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
// A registry host (with an optional port) and a lowercase path: image names are lowercase.
const REGISTRY = /^[a-z0-9.-]+(?::\d+)?(?:\/[a-z0-9._-]+)+$/;
const REPO_URL = /^https:\/\/[^\s"'`]+[^/\s"'`]$/;

/** What is wrong with the input, one line each; empty when it can be used. */
export function checkInput(input: BundleInput, packageVersion: string): string[] {
  const problems: string[] = [];
  if (!VERSION.test(input.version))
    problems.push(`version ${JSON.stringify(input.version)}: expected 1.2.3 or 1.2.3-rc.1`);
  else if (input.version !== packageVersion && !input.version.startsWith(`${packageVersion}-`))
    problems.push(
      `version ${input.version} does not match package.json's ${packageVersion}: tag v${packageVersion}, or a pre-release of it such as v${packageVersion}-rc.1`,
    );
  if (!REGISTRY.test(input.registry))
    problems.push(
      `registry ${JSON.stringify(input.registry)}: expected a lowercase host and path, such as ghcr.io/owner`,
    );
  if (!REPO_URL.test(input.repoUrl))
    problems.push(`repository address ${JSON.stringify(input.repoUrl)}: expected https://…`);
  for (const key of IMAGE_KEYS) {
    const digest = input.digests[key];
    if (digest === undefined) problems.push(`${key}: no digest`);
    else if (!DIGEST.test(digest))
      problems.push(`${key}: digest ${JSON.stringify(digest)}: expected sha256: and 64 hex digits`);
  }
  return problems;
}

/** An image pinned by its digest alone, which Docker and Podman both pull. */
export function imageRef(registry: string, key: ImageKey, digest: string): string {
  return `${registry}/${IMAGES[key].repository}@${digest}`;
}

/** The image's tags for this release: the version, with the CUDA image's suffix. */
export function imageTag(registry: string, key: ImageKey, version: string): string {
  return `${registry}/${IMAGES[key].repository}:${version}${IMAGES[key].suffix}`;
}

/** The values the templates' @@NAME@@ placeholders take. */
export function placeholders(input: BundleInput): Record<string, string> {
  const ref = (key: ImageKey) => imageRef(input.registry, key, input.digests[key]);
  const tag = (key: ImageKey) => imageTag(input.registry, key, input.version);
  return {
    VERSION: input.version,
    TAG: `v${input.version}`,
    REPO_URL: input.repoUrl,
    CONTROL_IMAGE: ref("control"),
    HARNESS_IMAGE: ref("harness"),
    HARNESS_CUDA_IMAGE: ref("harness-cuda"),
    HARNESS_CUDA13_IMAGE: ref("harness-cuda13"),
    SUPERVISOR_IMAGE: ref("supervisor"),
    RIG_CUDA_IMAGE: ref("rig-cuda"),
    CONTROL_TAG: tag("control"),
    HARNESS_TAG: tag("harness"),
    HARNESS_CUDA_TAG: tag("harness-cuda"),
    HARNESS_CUDA13_TAG: tag("harness-cuda13"),
    SUPERVISOR_TAG: tag("supervisor"),
    RIG_CUDA_TAG: tag("rig-cuda"),
  };
}

/**
 * Fills a template's @@NAME@@ placeholders. A name the template uses that has no value, or a
 * value the template never uses, is an error: either one means the template and this code
 * disagree.
 */
export function render(template: string, values: Record<string, string>, only?: string[]) {
  const used = new Set<string>();
  const out = template.replace(/@@([A-Z0-9_]+)@@/g, (_, name: string) => {
    const value = values[name];
    if (value === undefined) throw new Error(`the template names @@${name}@@, which has no value`);
    used.add(name);
    return value;
  });
  for (const name of only ?? [])
    if (!used.has(name)) throw new Error(`the template never uses @@${name}@@`);
  if (out.includes("@@")) throw new Error("a placeholder is left in the output");
  return out;
}

/**
 * The placeholders each template must use: the compose file pins the images control and its rigs
 * run (the CUDA 12 harness and the rig image as control's defaults for the rigs it sets up and
 * launches); the readme lists every image, the CUDA 13 harness too.
 */
export const COMPOSE_NEEDS = [
  "VERSION",
  "REPO_URL",
  "CONTROL_IMAGE",
  "HARNESS_IMAGE",
  "HARNESS_CUDA_IMAGE",
  "SUPERVISOR_IMAGE",
  "RIG_CUDA_IMAGE",
];
export const README_NEEDS = [
  "VERSION",
  "TAG",
  "REPO_URL",
  "COMPOSE_SHA256",
  "CONTROL_IMAGE",
  "HARNESS_IMAGE",
  "HARNESS_CUDA_IMAGE",
  "HARNESS_CUDA13_IMAGE",
  "SUPERVISOR_IMAGE",
  "RIG_CUDA_IMAGE",
];

/**
 * The bundle's two files from their templates: the compose file, and the readme, which gives the
 * compose file's SHA-256 (hexadecimal), so whoever downloads it can check it is this release's.
 */
export function bundleFiles(
  input: BundleInput,
  templates: { compose: string; readme: string },
): { compose: string; readme: string; composeSha256: string } {
  const values = placeholders(input);
  const compose = render(templates.compose, values, COMPOSE_NEEDS);
  const composeSha256 = createHash("sha256").update(compose).digest("hex");
  const readme = render(
    templates.readme,
    { ...values, COMPOSE_SHA256: composeSha256 },
    README_NEEDS,
  );
  return { compose, readme, composeSha256 };
}

// --- Keeping the template in step with compose.yaml -------------------------------------------

/** The `image:` line that stands for each `build:` line of compose.yaml in the template. */
const BUILD_TO_IMAGE: Record<string, string> = {
  "containers/control/Containerfile": "@@CONTROL_IMAGE@@",
  "containers/harness/Containerfile": "@@HARNESS_IMAGE@@",
  "containers/supervisor/Containerfile": "@@SUPERVISOR_IMAGE@@",
};

/** A compose file's lines without comments and blank lines, and without trailing spaces. */
function meaningful(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .filter((line) => line !== "" && !/^\s*#/.test(line));
}

/**
 * Where the template differs from compose.yaml in anything but the ways it is meant to:
 * images in place of builds, this release's images as the defaults of control's rig image
 * settings, and its own `init` service. Empty when they agree.
 */
export function templateDrift(composeYaml: string, template: string): string[] {
  const expected = meaningful(composeYaml).map((line) => {
    // A build line, with or without its build arguments (the published images carry theirs).
    const build = /^(\s*)build: \{ context: \., dockerfile: ([^\s,]+)(?:, args: \{.*\})? \}$/.exec(
      line,
    );
    if (!build) return line;
    const image = BUILD_TO_IMAGE[build[2] ?? ""];
    return image ? `${build[1]}image: ${image}` : line;
  });
  const lines = meaningful(template);
  // Leave out the init service: from its name to the next service at the same depth.
  const start = lines.indexOf("  init:");
  if (start < 0) return ["the template has no init service"];
  let end = start + 1;
  while (end < lines.length && /^ {4}/.test(lines[end] ?? "")) end++;
  const actual = [...lines.slice(0, start), ...lines.slice(end)].map((line) =>
    line.replace(/:-@@[A-Z0-9_]+@@\}/, ":-}"),
  );
  const problems: string[] = [];
  const n = Math.max(expected.length, actual.length);
  for (let i = 0; i < n && problems.length < 5; i++)
    if (expected[i] !== actual[i])
      problems.push(
        `line ${i + 1} of the meaningful lines: compose.yaml has ${JSON.stringify(expected[i] ?? "(nothing)")}, the template ${JSON.stringify(actual[i] ?? "(nothing)")}`,
      );
  return problems;
}
