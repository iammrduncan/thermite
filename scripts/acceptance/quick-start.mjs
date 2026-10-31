#!/usr/bin/env node
// The quick start, followed on this machine as a tester follows it: from the release bundle to
// the sample campaign's first verdict. The steps come from the pages themselves
// (tests/helpers/quick-start.ts reads them): each shell block runs as the page writes it, in a new
// folder, and the values typed, the buttons pressed and the words checked are the pages' own. So
// a change to a page that breaks the quick start fails this test.
//
// First it does what a release does, from this checkout: it builds the control, harness and
// supervisor images and writes the bundle with scripts/release/bundle.ts, pinned to those images
// by digest. With Podman the images stay in local storage, which knows their digests. With Docker
// they go to a registry container on 127.0.0.1, so that each one has a digest to pin.
//
// Where a tester's step cannot run before a release is published, the test changes it, and only
// these:
//   - the release's files come from a server on this machine, not from GitHub's releases;
//   - the source (`git clone`, and the campaign's repository) is this checkout's tracked files,
//     committed and tagged as the release, and served by git daemon;
//   - the bundle's CUDA harness names the CPU harness: no step here uses a GPU; and its rig image
//     for RunPod is pinned by the CPU harness's digest, which names no image: no step launches a
//     pod;
//   - the agents' model is the scripted model of the agents acceptance, added as an
//     OpenAI-compatible provider in place of OpenCode's free models, so no key and no network
//     model are needed; the worker harness is OpenCode v2, as the page says;
//   - Look it up reads only https:// addresses, so the test looks the tag up itself, and checks
//     the number of files the page says it finds;
//   - the doctor checks the scripted model's address in place of OpenCode's.
// Then: Your first run (the bundle, init, up, sign in, the rig checks); the command line and
// `thermite doctor` from Troubleshoot; Hand the work to agents, to the first verdict and a pause;
// and the first page's `down`. It removes its stack and volumes, its images, dangling images and
// its folder afterwards. KEEP=1 leaves the stack and the folder.
//
// Usage: COMPOSE="podman compose" node scripts/acceptance/quick-start.mjs
//        (or COMPOSE="docker compose", or COMPOSE="podman-compose")
//
// Its parts are in quick-start-acceptance/: what the test runs with and its report (context),
// processes and the tester's shell, the dashboard and the API, the scripted model, the release,
// the steps of Your first run and of Hand the work to agents, and the clean-up.
import { handToAgents } from "./quick-start/agents.mjs";
import { cleanUp } from "./quick-start/clean-up.mjs";
import { report } from "./quick-start/context.mjs";
import { firstRun, stopThermite } from "./quick-start/first-run.mjs";
import { beforeTheTester } from "./quick-start/release.mjs";

// ---------------------------------------------------------------- the test

let failed = false;
try {
  const served = await beforeTheTester();
  await firstRun();
  await handToAgents(served);
  await stopThermite();
} catch (err) {
  failed = true;
  console.log(`FAIL ${String(err?.stack ?? err)}`);
  report.error = String(err?.message ?? err);
} finally {
  cleanUp(failed);
}
