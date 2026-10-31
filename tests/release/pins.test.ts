import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import {
  findPins,
  pinnedFiles,
  pinProblems,
  registryOf,
  tagDigest,
} from "../../src/release/pins.ts";

/**
 * The images Thermite pins by digest and does not build (src/release/pins.ts): every copy of one
 * image is pinned the same way, so a maintainer who moves one moves them all, and the registry's
 * digest for a tag is read as a registry gives it.
 */

const ROOT = join(import.meta.dirname, "..", "..");
const DIGEST = (c: string) => `sha256:${c.repeat(64)}`;

test("every image's tag pinned in the repository has one digest in all its copies", () => {
  const pins = findPins(pinnedFiles(ROOT));
  assert.deepEqual(pinProblems(pins), []);
  const images = new Set(pins.map((p) => p.image));
  // The bases, the bus's server, and the registry the release workflow runs in a job.
  for (const image of [
    "docker.io/library/node",
    "docker.io/library/nats",
    "docker.io/nvidia/cuda",
    "docker.io/library/registry",
  ])
    assert.ok(images.has(image), image);
  const nats = pins.filter((p) => p.image === "docker.io/library/nats").map((p) => p.file);
  assert.deepEqual(
    new Set(nats),
    new Set([
      "compose.yaml",
      "containers/release/compose.template.yaml",
      "containers/rig/Containerfile",
    ]),
  );
});

test("a pin is found where a file writes it, and an image pinned two ways is named", () => {
  const files = [
    {
      path: "a/Containerfile",
      text: `ARG NODE_IMAGE=docker.io/library/node:22-slim@${DIGEST("a")}\nFROM \${NODE_IMAGE}`,
    },
    { path: "b.yaml", text: `    image: example.com:5000/team/bus:1.2@${DIGEST("b")} # one` },
    { path: "c.ts", text: `const X = "docker.io/library/node:22-slim@${DIGEST("c")}";` },
    { path: "d.md", text: "node:22-slim, with no digest, is not a pin" },
  ];
  const pins = findPins(files);
  assert.deepEqual(
    pins.map((p) => [p.file, p.line, p.image, p.tag]),
    [
      ["a/Containerfile", 1, "docker.io/library/node", "22-slim"],
      ["b.yaml", 1, "example.com:5000/team/bus", "1.2"],
      ["c.ts", 1, "docker.io/library/node", "22-slim"],
    ],
  );
  const [problem, ...rest] = pinProblems(pins);
  assert.equal(rest.length, 0);
  assert.match(
    problem ?? "",
    /^docker\.io\/library\/node:22-slim is pinned at 2 digests: a\/Containerfile:1 has sha256:aaaa.*; c\.ts:1 has sha256:cccc/,
  );
  assert.deepEqual(pinProblems(pins.slice(0, 2)), []);
  // Two tags of one image are two pins: the CUDA 12 and CUDA 13 bases.
  const two = findPins([
    {
      path: "w.yml",
      text: `docker.io/nvidia/cuda:12@${DIGEST("1")} docker.io/nvidia/cuda:13@${DIGEST("2")}`,
    },
  ]);
  assert.equal(two.length, 2);
  assert.deepEqual(pinProblems(two), []);
});

test("an image's registry: Docker Hub's for a name without a host, with library/ for one alone", () => {
  assert.deepEqual(registryOf("docker.io/library/nats"), {
    host: "registry-1.docker.io",
    repository: "library/nats",
  });
  assert.deepEqual(registryOf("nats"), {
    host: "registry-1.docker.io",
    repository: "library/nats",
  });
  assert.deepEqual(registryOf("nvidia/cuda"), {
    host: "registry-1.docker.io",
    repository: "nvidia/cuda",
  });
  assert.deepEqual(registryOf("ghcr.io/owner/thermite-rig"), {
    host: "ghcr.io",
    repository: "owner/thermite-rig",
  });
});

test("a tag's digest: a pull token from the address the registry names, then the manifest's digest", async () => {
  const asked: string[] = [];
  const fake = async (url: string, init: RequestInit) => {
    asked.push(`${init.method ?? "GET"} ${url}`);
    const auth = new Headers(init.headers).get("authorization");
    if (url.startsWith("https://auth.example.com/")) return Response.json({ token: "pull-token" });
    if (!auth)
      return new Response(null, {
        status: 401,
        headers: {
          "www-authenticate":
            'Bearer realm="https://auth.example.com/token",service="registry.example.com",scope="repository:library/nats:pull"',
        },
      });
    assert.equal(auth, "Bearer pull-token");
    return new Response(null, { status: 200, headers: { "docker-content-digest": DIGEST("e") } });
  };
  assert.equal(await tagDigest("docker.io/library/nats", "2.15.1-alpine", fake), DIGEST("e"));
  assert.deepEqual(asked, [
    "HEAD https://registry-1.docker.io/v2/library/nats/manifests/2.15.1-alpine",
    "GET https://auth.example.com/token?service=registry.example.com&scope=repository%3Alibrary%2Fnats%3Apull",
    "HEAD https://registry-1.docker.io/v2/library/nats/manifests/2.15.1-alpine",
  ]);
  // No such tag, or a sign-in this check does not make: said in words.
  const missing = async () => new Response(null, { status: 404 });
  await assert.rejects(
    tagDigest("nats", "0.0.0", missing),
    /gave no digest for nats:0\.0\.0 \(HTTP 404\)/,
  );
  const basic = async () =>
    new Response(null, { status: 401, headers: { "www-authenticate": 'Basic realm="x"' } });
  await assert.rejects(
    tagDigest("nats", "1", basic),
    /asks for a sign-in this check does not make/,
  );
});
