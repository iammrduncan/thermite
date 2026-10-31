import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

/**
 * The licence label each published image carries (.github/workflows/release.yml), as an SPDX
 * expression: Thermite is MIT, and the harness images, the rig image built on the CUDA one and
 * the supervisor image (for its advisors, goal 073) also carry the Codex CLI (Apache-2.0, with
 * its NOTICE) beside OpenCode (MIT).
 */
const workflow = readFileSync(
  join(import.meta.dirname, "..", "..", ".github", "workflows", "release.yml"),
  "utf8",
);

/** The matrix entry of one image, by its key, as its lines. */
const entry = (key: string) =>
  new RegExp(`- key: ${key}\\n((?: {12}[^\\n]*\\n)+)`).exec(workflow)?.[1] ?? "";

test("the published images' licence labels name every licence they carry", () => {
  assert.match(entry("control"), / {12}licenses: MIT\n/);
  assert.match(entry("supervisor"), / {12}licenses: "MIT AND Apache-2\.0"\n/);
  assert.match(entry("harness"), / {12}licenses: "MIT AND Apache-2\.0"\n/);
  assert.match(entry("harness-cuda"), / {12}licenses: "MIT AND Apache-2\.0"\n/);
  assert.match(entry("harness-cuda13"), / {12}licenses: "MIT AND Apache-2\.0"\n/);
  // Each image's labels and annotations take its entry's value. The rig image is built only in
  // the CUDA 12 harness's job, so it takes that entry's: it carries the same harness.
  const set = [...workflow.matchAll(/org\.opencontainers\.image\.licenses=([^\n]*)/g)].map(
    (m) => m[1],
  );
  // A GitHub Actions expression, not a template: written with its dollar sign apart.
  assert.deepEqual(set, Array(4).fill(`$${"{{ matrix.licenses }}"}`));
  assert.match(workflow, /- id: rig-meta\n {8}if: matrix\.rig\n/);
  const keys = ["control", "harness", "harness-cuda", "harness-cuda13", "supervisor"];
  const cuda = keys.filter((k) => / {12}cuda: true\n/.test(entry(k)));
  assert.deepEqual(cuda, ["harness-cuda", "harness-cuda13"]);
  // Only the CUDA 12 harness's job builds the rig image; each CUDA entry names its base.
  assert.deepEqual(
    keys.filter((k) => / {12}rig: true\n/.test(entry(k))),
    ["harness-cuda"],
  );
  assert.match(entry("harness-cuda"), / {12}cuda_base: CUDA_BASE_IMAGE\n/);
  assert.match(entry("harness-cuda13"), / {12}cuda_base: CUDA13_BASE_IMAGE\n/);
  assert.match(entry("harness-cuda13"), / {12}platforms: linux\/amd64,linux\/arm64\n/);
  assert.match(
    workflow,
    /CUDA13_BASE_IMAGE: docker\.io\/nvidia\/cuda:13\.0\.\d+-devel-ubuntu24\.04@sha256:[0-9a-f]{64}\n/,
  );
});

test("control's image carries kubectl's licence file, the Apache License 2.0, while its label stays MIT", () => {
  const root = join(import.meta.dirname, "..", "..");
  const containerfile = readFileSync(join(root, "containers", "control", "Containerfile"), "utf8");
  // The final stage, after the last FROM: what the published image holds.
  const final = containerfile.slice(containerfile.lastIndexOf("\nFROM "));
  assert.match(
    final,
    /\nCOPY containers\/control\/kubectl\/LICENSE \/usr\/local\/share\/doc\/kubectl\/LICENSE\n/,
  );
  assert.match(final, /\nCOPY --from=build \/kubectl \/usr\/local\/bin\/kubectl\n/);
  // The LICENSE of kubernetes/kubernetes at the pinned tag: the Apache License 2.0, whole.
  const license = readFileSync(join(root, "containers", "control", "kubectl", "LICENSE"), "utf8");
  assert.match(license, /^\n +Apache License\n +Version 2\.0, January 2004\n/);
  assert.match(license, /END OF TERMS AND CONDITIONS/);
  assert.equal(license.length, 11358);
  assert.match(entry("control"), / {12}licenses: MIT\n/);
});

test("the supervisor's image carries OpenCode and the Codex CLI at the harness image's versions, with their licences", () => {
  const root = join(import.meta.dirname, "..", "..");
  const read = (name: string) =>
    readFileSync(join(root, "containers", name, "Containerfile"), "utf8");
  const supervisor = read("supervisor");
  const harness = read("harness");
  // The same pinned releases as the harness image's.
  for (const arg of ["OPENCODE_VERSION", "CODEX_VERSION"]) {
    const pin = (cf: string) => new RegExp(`\\nARG ${arg}=([^\\n]+)\\n`).exec(cf)?.[1];
    assert.ok(pin(harness), arg);
    assert.equal(pin(supervisor), pin(harness), arg);
  }
  // The final stage, after the last FROM: what the published image holds.
  const final = supervisor.slice(supervisor.lastIndexOf("\nFROM "));
  assert.match(
    final,
    /\nCOPY --from=opencode \/usr\/local\/bin\/opencode \/usr\/local\/bin\/opencode\n/,
  );
  assert.match(
    final,
    /\nCOPY --from=opencode \/usr\/local\/share\/doc\/opencode\/ \/usr\/local\/share\/doc\/opencode\/\n/,
  );
  assert.match(final, /\nCOPY --from=codex \/out\/opt\/ \/opt\/\n/);
  assert.match(final, /\nCOPY --from=codex \/out\/doc\/ \/usr\/local\/share\/doc\/\n/);
  assert.match(final, /ln -s \/opt\/codex\/bin\/codex \/usr\/local\/bin\/codex/);
  // Codex's LICENSE and NOTICE go to /usr/local/share/doc/codex; OpenCode's LICENSE to its own.
  assert.match(
    supervisor,
    /install -m 0644 \/tmp\/codex-legal\/LICENSE \/tmp\/codex-legal\/NOTICE \/out\/doc\/codex\//,
  );
  assert.match(
    supervisor,
    /\nCOPY containers\/harness\/opencode\/LICENSE \/usr\/local\/share\/doc\/opencode\/LICENSE\n/,
  );
});
