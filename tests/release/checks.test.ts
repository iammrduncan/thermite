import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { imageProblems, probeValues } from "../../src/release/checks.ts";
import {
  BUILD_SCRIPTS,
  CONTAINERFILE,
  finalStage,
  instructions,
  RIG_CONTAINERFILE,
  ROOT,
  RUN_SCRIPT,
  repoFile,
  stage,
} from "../helpers/containerfile.ts";

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

const IMAGES = ["control", "harness", "supervisor", "rig"] as const;

test("every image clears set-id bits last, with one script, and fails its build if one is left", () => {
  const script = repoFile(`${BUILD_SCRIPTS}/no-set-id.sh`);
  assert.match(script, /\nset -eu\n/);
  assert.match(script, /\nfind \/ -xdev -type f -perm \/6000 -exec chmod ug-s \{\} \+\n/);
  assert.match(script, /\ntest -z "\$\(find \/ -xdev -type f -perm \/6000 -print -quit\)"\n/);
  for (const image of IMAGES) {
    const steps = instructions(finalStage(image));
    const sweep = steps.findIndex((step) => step.startsWith(RUN_SCRIPT("no-set-id.sh")));
    assert.ok(sweep > 0, image);
    // No package and no other image's files come after it.
    for (const later of steps.slice(sweep + 1))
      assert.doesNotMatch(later, /apt-get|npm |COPY --from|useradd|chmod [ug]?\+s/, image);
  }
  // Each image runs the scripts it needs, and only those, mounted from their stage.
  const runs: Record<(typeof IMAGES)[number], string[]> = {
    control: ["no-set-id.sh"],
    harness: ["no-set-id.sh"],
    supervisor: ["supervisor-users.sh", "no-set-id.sh"],
    rig: ["supervisor-users.sh", "no-set-id.sh"],
  };
  for (const image of IMAGES) {
    const mounted = [...finalStage(image).matchAll(/--mount=type=bind,[^\n]*build-scripts[^\n]*/g)];
    assert.deepEqual(
      mounted.map((m) => m[0].replace(/ \\$/, "")),
      runs[image].map((script) => RUN_SCRIPT(script).slice("RUN ".length)),
      image,
    );
  }
  // The scripts reach those steps from a stage of their own, which holds them alone and which no
  // image copies from: no image keeps them. Every bind mount is from a stage, never the build
  // context, which Podman's builder under compose can't open.
  for (const file of [CONTAINERFILE, RIG_CONTAINERFILE]) {
    const text = repoFile(file);
    assert.deepEqual(
      instructions(stage(text, "build-scripts")),
      ["FROM scratch AS build-scripts", `COPY ${BUILD_SCRIPTS}/ /`],
      file,
    );
    // No other step names the scripts' folder: none copies it into an image or mounts it.
    assert.deepEqual(
      instructions(text).filter((step) => step.includes(BUILD_SCRIPTS)),
      [`COPY ${BUILD_SCRIPTS}/ /`],
      file,
    );
    assert.doesNotMatch(text, /COPY --from=build-scripts/, file);
    const mounts = [...text.matchAll(/--mount=type=bind,(\S+)/g)];
    assert.ok(mounts.length > 0, file);
    for (const mount of mounts)
      assert.match(mount[1] as string, /(^|,)from=/, `${file}: ${mount[0]}`);
  }
});

test("the supervisor image builds node-pty in a stage of its own and keeps only the module: no compiler or make is in it (goal 169)", () => {
  const text = repoFile(CONTAINERFILE);
  const pty = stage(text, "pty");
  assert.match(pty, /^\nFROM \$\{NODE_IMAGE\} AS pty\n/);
  assert.match(pty, /apt-get install -y --no-install-recommends g\+\+ make python3/);
  assert.match(pty, /node-gyp\.js rebuild/);
  // node-pty and node-addon-api's headers come from the supervisor's packages, which leave them out.
  assert.match(pty, /\nCOPY --from=supervisor-modules \/pty\/ \.\/\n/);
  assert.match(
    stage(text, "supervisor-modules"),
    /\nRUN mkdir \/pty && mv node_modules\/node-pty node_modules\/node-addon-api \/pty\/\n/,
  );
  const final = finalStage("supervisor");
  const fromPty = [...final.matchAll(/COPY --from=pty (\S+)/g)].map((m) => m[1]);
  assert.deepEqual(fromPty, ["/src/node_modules/node-pty"]);
  assert.match(final, /\nCOPY --from=supervisor-modules \/src\/node_modules \.\/node_modules\n/);
  assert.doesNotMatch(final, /apt-get install[^\n]*(g\+\+|gcc|make|build-essential)/);
  assert.match(final, /require\('\/opt\/thermite\/node_modules\/node-pty'\)\.native\.open/);
  assert.match(
    final,
    /! command -v cc && ! command -v gcc && ! command -v g\+\+ && ! command -v make/,
  );
  // The shared build stage keeps node-pty: only control's packages leave it out.
  assert.doesNotMatch(stage(text, "build"), /--omit=optional/);
  assert.match(
    stage(text, "control-modules"),
    /\nRUN npm prune --omit=dev --omit=optional --no-fund --no-audit\n/,
  );
});

test("no image holds pi-tui's native helpers: the build deletes them, each image's build fails on them, and the release check refuses them (goal 169)", () => {
  const build = stage(repoFile(CONTAINERFILE), "build");
  const prune = build.slice(build.indexOf("npm prune"));
  assert.match(prune, /rm -rf [^\n]*(\\\n[^\n]*)*node_modules\/@earendil-works\/pi-tui\/native/);
  for (const image of ["control", "harness", "supervisor"] as const)
    assert.match(
      finalStage(image),
      /test -z "\$\(find \/ -xdev -type d -path '\*\/@earendil-works\/pi-tui\/native' -print -quit\)"/,
      image,
    );
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
  for (const image of IMAGES) {
    const final = finalStage(image);
    const upgrade = final.indexOf("apt-get upgrade -y");
    assert.ok(upgrade > 0, `${image} upgrades its packages`);
    assert.ok(upgrade < final.indexOf("apt-get install"), `${image} upgrades first`);
  }
});

/** The programs' pinned versions: each a build argument with one default, which stages take. */
const PINS = ["OPENCODE_VERSION", "CODEX_VERSION", "CLAUDE_CODE_VERSION", "KUBECTL_VERSION"];

test("each pinned version is written once, before the first stage, and every stage that uses it takes that default", () => {
  const text = repoFile(CONTAINERFILE);
  const global = text.slice(0, text.indexOf("\nFROM "));
  // The Node image too, which the FROM lines read from the global arguments themselves.
  for (const arg of ["NODE_IMAGE", ...PINS]) {
    const set = [...text.matchAll(new RegExp(`^ARG ${arg}=(.*)$`, "gm"))];
    assert.equal(set.length, 1, `${arg} has one default`);
    assert.ok(global.includes(set[0]?.[0] as string), `${arg}'s default is before the first FROM`);
    // The version itself is written nowhere else in the images' builds.
    const value = set[0]?.[1] as string;
    if (!value) continue;
    assert.equal(text.split(value).length, 2, `${arg}'s value is in the Containerfile once`);
    const scripts = readdirSync(join(ROOT, BUILD_SCRIPTS)).map((f) => `${BUILD_SCRIPTS}/${f}`);
    for (const file of [RIG_CONTAINERFILE, ...scripts])
      assert.ok(!repoFile(file).includes(value), `${file} repeats ${arg}`);
  }
  const stages = text.split(/\n(?=FROM )/).slice(1);
  for (const arg of PINS) {
    const users = stages.filter((s) => new RegExp(`\\$\\{?${arg}\\b`).test(s));
    assert.ok(users.length > 0, `a stage uses ${arg}`);
    // A stage takes the default with a bare ARG: it never sets one of its own.
    for (const used of users) assert.match(used, new RegExp(`\nARG ${arg}\n`), `${arg}: ${used}`);
  }
  // No other Containerfile in the repository pins one of them.
  for (const name of readdirSync(join(ROOT, "containers"))) {
    const path = join("containers", name, "Containerfile");
    if (!existsSync(join(ROOT, path))) continue;
    for (const arg of ["NODE_IMAGE", ...PINS])
      assert.doesNotMatch(repoFile(path), new RegExp(`ARG ${arg}=`), path);
  }
});

/** What each image copies from the stages it shares with the others, as it did from its own file. */
const COPIES: Record<"control" | "harness" | "supervisor", string[]> = {
  control: [
    "COPY --from=build /src/package.json ./",
    "COPY --from=control-modules /src/node_modules ./node_modules",
    "COPY --from=build /src/dist ./dist",
    "COPY --from=kubectl /kubectl /usr/local/bin/kubectl",
  ],
  harness: [
    "COPY --from=node /usr/local/bin/node /usr/local/bin/node",
    "COPY --from=build /src/package.json ./",
    "COPY --from=build /src/node_modules ./node_modules",
    "COPY --from=build /src/dist ./dist",
    "COPY --from=opencode /usr/local/bin/opencode /usr/local/bin/opencode",
    "COPY --from=opencode /usr/local/share/doc/opencode/ /usr/local/share/doc/opencode/",
    "COPY --from=claude /out/ /usr/local/bin/",
    "COPY --from=codex /out/opt/ /opt/",
  ],
  supervisor: [
    "COPY --from=build /src/package.json ./",
    "COPY --from=supervisor-modules /src/node_modules ./node_modules",
    "COPY --from=pty /src/node_modules/node-pty ./node_modules/node-pty",
    "COPY --from=build /src/dist ./dist",
    "COPY --from=claude /out/ /usr/local/bin/",
    "COPY --from=opencode /usr/local/bin/opencode /usr/local/bin/opencode",
    "COPY --from=opencode /usr/local/share/doc/opencode/ /usr/local/share/doc/opencode/",
    "COPY --from=codex /out/opt/ /opt/",
    "COPY --from=codex /out/doc/ /usr/local/share/doc/",
  ],
};

test("each image is a target of the one Containerfile, on its own base, and takes from the shared stages what it held", () => {
  const text = repoFile(CONTAINERFILE);
  assert.match(stage(text, "control"), /^\nFROM \$\{NODE_IMAGE\} AS control\n/);
  assert.match(stage(text, "supervisor"), /^\nFROM \$\{NODE_IMAGE\} AS supervisor\n/);
  assert.match(stage(text, "harness"), /^\nFROM \$\{BASE_IMAGE\} AS harness\n/);
  assert.match(text, /\nARG BASE_IMAGE=\$\{NODE_IMAGE\}\n/);
  // The harness is the last stage: a build that names no target builds it.
  assert.equal(
    text.lastIndexOf("\nFROM "),
    /\nFROM \$\{BASE_IMAGE\} AS harness\n/.exec(text)?.index,
  );
  for (const [image, copies] of Object.entries(COPIES)) {
    const final = instructions(stage(text, image));
    assert.deepEqual(
      final.filter((step) => step.startsWith("COPY --from=")),
      copies,
      image,
    );
  }
  // Every stage a target copies from starts from the pinned Node image, or from the build.
  for (const name of ["build", "node", "opencode", "codex", "claude", "kubectl", "pty"])
    assert.match(stage(text, name), new RegExp(`^\\nFROM \\$\\{NODE_IMAGE\\} AS ${name}\\n`), name);
  for (const name of ["control-modules", "supervisor-modules"])
    assert.match(stage(text, name), new RegExp(`^\\nFROM build AS ${name}\\n`), name);
  // The harness builds its own node-pty on its own base, with the Node stage's headers mounted.
  assert.match(
    stage(text, "harness"),
    /\nRUN --mount=type=bind,from=node,source=\/usr\/local,target=\/mnt\/node \\\n {4}cd node_modules\/node-pty \\\n/,
  );
  // The Codex stage writes both places the images take: the program with its licence for each,
  // and the licence's copy in the supervisor's documentation.
  const codex = stage(text, "codex");
  assert.match(codex, /\/tmp\/codex-legal\/NOTICE \/out\/opt\/codex\//);
  assert.match(codex, /\/tmp\/codex-legal\/NOTICE \/out\/doc\/codex\//);
  // The rig image is built on a harness image, given as its one build argument; its other stage
  // only holds the build scripts.
  const rig = repoFile(RIG_CONTAINERFILE);
  const froms = [...rig.matchAll(/^FROM .*$/gm)].map((m) => m[0]);
  assert.equal(froms.length, 2);
  assert.equal(froms[0], "FROM scratch AS build-scripts");
  assert.match(froms[1] as string, /^FROM \$\{HARNESS_IMAGE\}$/);
  assert.ok(rig.indexOf("\nARG HARNESS_IMAGE\n") < rig.indexOf("\nFROM "));
});

test("the probe's lines are read by name, each value trimmed", () => {
  assert.deepEqual(probeValues("claude=\nsetid=/a /b \nnoise\n"), { claude: "", setid: "/a /b" });
});
