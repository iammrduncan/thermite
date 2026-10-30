import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { imageProblems, probeValues } from "../../src/release/checks.ts";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const clean = (env: string[] = []) => ({
  anonymous: true,
  env: [`THERMITE_COMMIT=${COMMIT}`, "THERMITE_IMAGE_ID=0.1.0-cuda+0123456789ab", ...env],
  probe: "claude=\nsocat=\nbwrap=\nsetid=\n",
  platforms: ["linux/amd64", "linux/arm64"],
});

test("an image that holds has no problem", () => {
  for (const key of [
    "control",
    "harness",
    "harness-cuda",
    "harness-cuda13",
    "supervisor",
    "rig-cuda",
  ] as const)
    assert.deepEqual(imageProblems(key, COMMIT, clean()), [], key);
});

test("each image is published for its platforms: the CUDA 13 harness for arm64 too (goal 132)", () => {
  const amd64 = { ...clean(), platforms: ["linux/amd64"] };
  assert.deepEqual(imageProblems("harness-cuda", COMMIT, amd64), []);
  assert.deepEqual(imageProblems("rig-cuda", COMMIT, amd64), []);
  assert.deepEqual(imageProblems("harness-cuda13", COMMIT, amd64), [
    "it is not published for linux/arm64",
  ]);
  assert.deepEqual(imageProblems("control", COMMIT, { ...clean(), platforms: [] }), [
    "it is not published for linux/amd64 or linux/arm64",
  ]);
});

test("one that does not pull without signing in says what to do, and nothing else", () => {
  assert.deepEqual(imageProblems("rig-cuda", COMMIT, { ...clean(), anonymous: false }), [
    "it does not pull without signing in: make its package public on GitHub (the package's settings, once), then run the checks again",
  ]);
});

test("the rig image is held to the lab's rules: no Claude Code, socat, bubblewrap, set-id file, key or STE checker", () => {
  const facts = {
    anonymous: true,
    env: [
      "THERMITE_COMMIT=feedface",
      "THERMITE_SNAPSHOT_KEY=abc",
      "THERMITE_STE_CHECKER=/opt/ste/check",
      "THERMITE_SNAPSHOT_DIR=/workspace/thermite",
      // A setting that names a file is a path, not a secret.
      "THERMITE_SUPERVISOR_TOKEN_FILE=/run/secrets/supervisor-token",
      "THERMITE_CONTROL_PUBKEY_FILE=/keys/control-signing.pub",
    ],
    probe:
      "claude=/usr/local/bin/claude \nsocat=/usr/bin/socat\nbwrap=/usr/bin/bwrap\nsetid=/usr/bin/su /usr/bin/passwd \n",
    platforms: ["linux/amd64"],
  };
  assert.deepEqual(imageProblems("rig-cuda", COMMIT, facts), [
    `it reports THERMITE_COMMIT "feedface", not the release's commit ${COMMIT}`,
    "it carries Claude Code (/usr/local/bin/claude): a published image never does",
    "it sets THERMITE_SNAPSHOT_KEY in its environment: no key, token or password goes in an image",
    "it does not report THERMITE_IMAGE_ID, which the harness reports as its image",
    "it carries socat (/usr/bin/socat)",
    "it carries bubblewrap (/usr/bin/bwrap)",
    "it has set-id files: /usr/bin/su /usr/bin/passwd",
    "it names an STE checker (THERMITE_STE_CHECKER): the checker is a deployment's own",
  ]);
});

test("set-id files are every image's rule; socat and the image ID are the harnesses' and the rig's", () => {
  const facts = {
    ...clean(),
    env: [`THERMITE_COMMIT=${COMMIT}`],
    probe: "claude=\nsocat=/usr/bin/socat\nbwrap=\nsetid=/usr/bin/su\n",
  };
  assert.deepEqual(imageProblems("control", COMMIT, facts), ["it has set-id files: /usr/bin/su"]);
  assert.deepEqual(imageProblems("harness", COMMIT, facts), [
    "it does not report THERMITE_IMAGE_ID, which the harness reports as its image",
    "it carries socat (/usr/bin/socat)",
    "it has set-id files: /usr/bin/su",
  ]);
});

test("every image's Containerfile clears set-id bits last, and fails its build if one is left", () => {
  for (const image of ["control", "harness", "supervisor", "rig"]) {
    const text = readFileSync(
      join(import.meta.dirname, "..", "..", "containers", image, "Containerfile"),
      "utf8",
    );
    const final = text.slice(text.lastIndexOf("\nFROM "));
    assert.match(final, /find \/ -xdev -type f -perm \/6000 -exec chmod ug-s \{\} \+/, image);
    assert.match(final, /test -z "\$\(find \/ -xdev -type f -perm \/6000 -print -quit\)"/, image);
  }
});

test("no image holds pi-tui's native helpers: each deletes them, its build fails on them, and the release check refuses them (goal 169)", () => {
  for (const image of ["control", "harness", "supervisor"]) {
    const text = readFileSync(
      join(import.meta.dirname, "..", "..", "containers", image, "Containerfile"),
      "utf8",
    );
    const prune = text.slice(
      text.indexOf("npm prune"),
      text.indexOf("\nFROM ", text.indexOf("npm prune")),
    );
    assert.match(
      prune,
      /rm -rf [^\n]*(\\\n[^\n]*)*node_modules\/@earendil-works\/pi-tui\/native/,
      image,
    );
    const final = text.slice(text.lastIndexOf("\nFROM "));
    assert.match(
      final,
      /test -z "\$\(find \/ -xdev -type d -path '\*\/@earendil-works\/pi-tui\/native' -print -quit\)"/,
      image,
    );
  }
  const facts = {
    ...clean(),
    probe:
      "claude=\nsocat=\nbwrap=\nsetid=\npitui=/opt/thermite/node_modules/@earendil-works/pi-tui/native \n",
  };
  for (const key of ["control", "harness", "supervisor", "rig-cuda"] as const)
    assert.deepEqual(imageProblems(key, COMMIT, facts), [
      "it holds pi-tui's prebuilt native helpers (/opt/thermite/node_modules/@earendil-works/pi-tui/native): every image deletes them",
    ]);
});

test("every image upgrades its base's system packages before it installs its own (goal 125)", () => {
  for (const image of ["control", "harness", "supervisor", "rig"]) {
    const text = readFileSync(
      join(import.meta.dirname, "..", "..", "containers", image, "Containerfile"),
      "utf8",
    );
    const final = text.slice(text.lastIndexOf("\nFROM "));
    const upgrade = final.indexOf("apt-get upgrade -y");
    assert.ok(upgrade > 0, `${image} upgrades its packages`);
    assert.ok(upgrade < final.indexOf("apt-get install"), `${image} upgrades first`);
  }
});

test("the probe's lines are read by name, each value trimmed", () => {
  assert.deepEqual(probeValues("claude=\nsetid=/a /b \nnoise\n"), { claude: "", setid: "/a /b" });
});
