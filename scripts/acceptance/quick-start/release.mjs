import { spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { hostName, scriptedModel } from "../lib/scripted-model.mjs";
import { until } from "../lib/smoke-env.mjs";
import { COMPOSE, check, control, engine, plan, repo, section, tag, version } from "./context.mjs";
import { script } from "./model.mjs";
import { freePort, portInUse, quiet, rewrites, sh, work } from "./processes.mjs";

// ---------------------------------------------------------------- the release, from this checkout

const IMAGES = ["control", "harness", "supervisor"];
let registry = "";
export let registryBox = "";
export let registryImageWasHere = true;
export const builtTags = [];
export const REGISTRY_IMAGE =
  "docker.io/library/registry:3.0.0@sha256:6c5666b861f3505b116bb9aa9b25175e71210414bd010d92035ff64018f9457e";

/** Builds the images from this checkout, and finds the digest each one is pinned by. */
async function buildImages(commit) {
  if (engine === "podman") registry = "localhost/thermite-quick-start";
  else {
    // Docker takes a registry on 127.0.0.1 without TLS.
    const port = await freePort();
    registryBox = `thermite-quick-start-registry-${port}`;
    try {
      quiet("docker", ["image", "inspect", REGISTRY_IMAGE]);
    } catch {
      registryImageWasHere = false;
    }
    sh("docker", [
      "run",
      "-d",
      "--name",
      registryBox,
      "-p",
      `127.0.0.1:${port}:5000`,
      REGISTRY_IMAGE,
    ]);
    registry = `127.0.0.1:${port}/thermite-quick-start`;
  }
  const digests = {};
  for (const key of IMAGES) {
    const name = `${registry}/thermite-${key}`;
    const ref = `${name}:quick-start`;
    console.log(`build ${ref}`);
    const args = ["--build-arg", `THERMITE_COMMIT=${commit}`];
    if (key === "harness")
      args.push("--build-arg", `THERMITE_IMAGE_ID=${version}+${commit.slice(0, 12)}`);
    sh(engine, ["build", "-f", `containers/${key}/Containerfile`, ...args, "-t", ref, "."], {
      cwd: repo,
      stdio: "inherit",
    });
    builtTags.push(ref);
    if (engine === "podman")
      digests[key] = sh("podman", ["image", "inspect", "--format", "{{.Digest}}", ref]).trim();
    else {
      sh("docker", ["push", "--quiet", ref]);
      const pinned = JSON.parse(
        sh("docker", ["image", "inspect", "--format", "{{json .RepoDigests}}", ref]),
      );
      digests[key] = pinned.find((d) => d.startsWith(`${name}@`))?.split("@")[1];
    }
    check(
      `the ${key} image has a digest to pin`,
      /^sha256:[0-9a-f]{64}$/.test(digests[key] ?? ""),
      digests[key],
    );
  }
  // The bundle names a CUDA harness for rigs on GPU machines, and a rig image for RunPod. This
  // test starts neither: control passes the rig image's name to RunPod only at a launch.
  digests["harness-cuda"] = digests.harness;
  digests["harness-cuda13"] = digests.harness;
  digests["rig-cuda"] = digests.harness;
  return digests;
}

/** The release bundle, written by the release's own script. */
function writeBundle(digests) {
  const dir = join(work, "digests");
  mkdirSync(dir);
  for (const [key, digest] of Object.entries(digests)) writeFileSync(join(dir, key), `${digest}\n`);
  const out = join(work, "release");
  sh(
    process.execPath,
    [
      "--experimental-strip-types",
      "--disable-warning=ExperimentalWarning",
      "scripts/release/bundle.ts",
      "--version",
      version,
      "--registry",
      registry,
      "--repo-url",
      plan.repo,
      "--digests",
      dir,
      "--out",
      out,
    ],
    { cwd: repo, stdio: "inherit" },
  );
  return out;
}

/** This checkout's tracked files, committed and tagged as the release, as a bare repository. */
function sourceRepository() {
  const src = join(work, "source");
  for (const f of sh("git", ["ls-files", "-z"], { cwd: repo }).split("\0").filter(Boolean)) {
    const from = join(repo, f);
    const to = join(src, f);
    let link = false;
    try {
      link = lstatSync(from).isSymbolicLink();
    } catch {
      continue; // deleted in the working tree
    }
    mkdirSync(dirname(to), { recursive: true });
    // A link stays a link, as git keeps it; a file keeps its mode.
    if (link) symlinkSync(readlinkSync(from), to);
    else copyFileSync(from, to);
  }
  const git = (...args) =>
    quiet(
      "git",
      [
        "-c",
        "user.name=Thermite",
        "-c",
        "user.email=release@localhost",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "tag.gpgsign=false",
        ...args,
      ],
      { cwd: src },
    ).trim();
  git("init", "--quiet", "-b", "main");
  git("add", "-A", "-f");
  git("commit", "--quiet", "-m", `Thermite ${version}`);
  git("tag", tag);
  const dir = join(work, "git");
  mkdirSync(dir);
  quiet("git", ["clone", "--quiet", "--bare", src, join(dir, "thermite.git")]);
  writeFileSync(join(dir, "thermite.git", "git-daemon-export-ok"), "");
  return dir;
}

/** The address the stack's containers reach a server on this machine at. */
export function containersHost() {
  if (engine === "podman" || process.platform === "darwin") return hostName(COMPOSE);
  // Docker on Linux names this machine only where compose.yaml maps the name, and the supervisor
  // has no such mapping: the gateway of its rig's egress network is this machine.
  return sh("docker", [
    "network",
    "inspect",
    "thermite_rig-egress",
    "--format",
    "{{(index .IPAM.Config 0).Gateway}}",
  ]).trim();
}

// What the test serves, and the clean-up stops.
export let daemon;
export let releaseServer;
export let model;

/**
 * Before the tester: the images and the release bundle, from this checkout; the release's files
 * and its source served on this machine, and the scripted model; and the changes the test makes
 * to the pages' commands. Returns where the later steps reach the source and the model.
 */
export async function beforeTheTester() {
  section("before the tester: the images and the release bundle, from this checkout");
  const busy = await portInUse(Number(new URL(control).port));
  check(`port ${new URL(control).port} is free for this test's control`, !busy);
  const volumes = quiet(engine, ["volume", "ls", "--format", "{{.Name}}"])
    .split("\n")
    .filter((v) => v.startsWith("thermite_"));
  check(
    "no compose stack named thermite has volumes here (this test would use them)",
    !volumes.length,
    volumes,
  );
  const commit = quiet("git", ["rev-parse", "HEAD"], { cwd: repo }).trim();
  const digests = await buildImages(commit);
  const releaseDir = writeBundle(digests);

  // The release's files, as GitHub serves them.
  releaseServer = createServer((req, res) => {
    const m = /^\/releases\/(?:latest\/download|download\/v[^/]+)\/([A-Za-z0-9._-]+)$/.exec(
      req.url ?? "",
    );
    const file = m ? join(releaseDir, m[1]) : "";
    if (req.method !== "GET" || !file || !existsSync(file)) {
      res.writeHead(404).end("Not Found\n");
      return;
    }
    res.writeHead(200, { "content-type": "application/octet-stream" }).end(readFileSync(file));
  });
  await new Promise((r) => releaseServer.listen(0, "127.0.0.1", r));
  const httpPort = releaseServer.address().port;
  // The source, as the release's tag.
  const gitDir = sourceRepository();
  const gitPort = await freePort();
  daemon = spawn(
    "git",
    [
      "daemon",
      "--reuseaddr",
      `--base-path=${gitDir}`,
      `--port=${gitPort}`,
      "--listen=0.0.0.0",
      gitDir,
    ],
    { stdio: "ignore" },
  );
  const served = `git://127.0.0.1:${gitPort}/thermite.git`;
  await until("git daemon answers", () => quiet("git", ["ls-remote", served]), 30_000, 500);
  model = await scriptedModel(script);
  const modelUrl = `http://${hostName(COMPOSE)}:${model.port}/v1`;
  rewrites.push(
    {
      from: `${plan.repo}/releases/latest/download/`,
      to: `http://127.0.0.1:${httpPort}/releases/latest/download/`,
      why: "no release is published before the first tag: the bundle comes from this machine",
    },
    {
      from: `${plan.repo}.git`,
      to: served,
      why: "the source is this checkout, tagged as the release and served on this machine",
    },
  );
  // The page says to use the release that compose.yaml names, when it is not the page's.
  if (plan.agents.tag !== tag)
    rewrites.push({
      from: `--branch ${plan.agents.tag} `,
      to: `--branch ${tag} `,
      why: "the release",
    });
  return { served, gitDir, gitPort, modelUrl };
}
