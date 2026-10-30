import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { promisify } from "node:util";
import { LOCAL_RIGS, LOCAL_TOKEN_FILES } from "../../src/cli/local-init.ts";
import { BUS_TLS_FILES, BUS_USERS_FILE } from "../../src/control/bus/index.ts";
import { BUS_SIGN_IN_SECONDS, BUS_TLS_SECONDS } from "../../src/core/link/leaf.ts";
import {
  type BundleInput,
  bundleFiles,
  COMPOSE_NEEDS,
  checkInput,
  IMAGE_KEYS,
  placeholders,
  render,
  templateDrift,
} from "../../src/release/bundle.ts";

const run = promisify(execFile);
const ROOT = join(import.meta.dirname, "..", "..");
const SCRIPT = join(ROOT, "scripts", "release", "bundle.ts");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
const COMPOSE = read("compose.yaml");
const TEMPLATE = read("containers/release/compose.template.yaml");
const README = read("containers/release/README.template.md");
const PACKAGE_VERSION: string = JSON.parse(read("package.json")).version;

const digest = (c: string) => `sha256:${c.repeat(64)}`;
const input = (over: Partial<BundleInput> = {}): BundleInput => ({
  version: PACKAGE_VERSION,
  registry: "ghcr.io/example",
  repoUrl: "https://github.com/example/thermite",
  digests: {
    control: digest("a"),
    harness: digest("b"),
    "harness-cuda": digest("c"),
    "harness-cuda13": digest("f"),
    supervisor: digest("d"),
    "rig-cuda": digest("e"),
  },
  ...over,
});

/** The value a service's key has in a rendered compose file (services are two spaces in). */
function serviceKey(compose: string, service: string, key: string): string | undefined {
  const lines = compose.split("\n");
  const start = lines.indexOf(`  ${service}:`);
  if (start < 0) return undefined;
  for (const line of lines.slice(start + 1)) {
    if (/^ {2}\S/.test(line) || /^\S/.test(line)) return undefined;
    const m = new RegExp(`^ {4}${key}: (.*)$`).exec(line);
    if (m) return m[1];
  }
  return undefined;
}

describe("the release bundle", () => {
  test("pins every service's image by digest", () => {
    const compose = render(TEMPLATE, placeholders(input()), COMPOSE_NEEDS);
    const images: Record<string, string> = {
      init: digest("a"),
      control: digest("a"),
      harness: digest("b"),
      "harness-2": digest("b"),
      supervisor: digest("d"),
      "supervisor-2": digest("d"),
    };
    for (const [service, d] of Object.entries(images)) {
      const image = serviceKey(compose, service, "image");
      assert.match(
        image ?? "",
        /^ghcr\.io\/example\/thermite-[a-z]+@sha256:[0-9a-f]{64}$/,
        service,
      );
      assert.ok(image?.endsWith(`@${d}`), `${service} runs ${image}`);
    }
    assert.ok(!/^\s*build:/m.test(compose), "nothing is built");
    // Control sets rigs up from this release's images unless .env names others.
    assert.match(
      compose,
      /THERMITE_RIG_HARNESS_CUDA_IMAGE: "\$\{THERMITE_RIG_HARNESS_CUDA_IMAGE:-ghcr\.io\/example\/thermite-harness@sha256:c{64}\}"/,
    );
    assert.match(compose, /THERMITE_RIG_SUPERVISOR_IMAGE: "\$\{[A-Z_]+:-[^}]+@sha256:d{64}\}"/);
    // Control launches rigs on RunPod from this release's rig image unless .env names another.
    assert.match(
      compose,
      /THERMITE_RUNPOD_RIG_IMAGE: "\$\{THERMITE_RUNPOD_RIG_IMAGE:-ghcr\.io\/example\/thermite-rig@sha256:e{64}\}"/,
    );
    assert.match(compose, /^# Thermite \d+\.\d+\.\d+/);
  });

  test("the init service makes .dev/ with no network", () => {
    const compose = render(TEMPLATE, placeholders(input()), COMPOSE_NEEDS);
    assert.equal(
      serviceKey(compose, "init", "command"),
      '["thermite", "local", "init", "/work/.dev"]',
    );
    assert.equal(serviceKey(compose, "init", "network_mode"), "none");
    assert.equal(serviceKey(compose, "init", "cap_drop"), "[ALL]");
    // Every secret the services read is a file the init service writes; each rig's token for
    // control is the one its enroll service writes in place, into the file init made empty.
    const made: string[] = [...LOCAL_TOKEN_FILES, ...Object.values(LOCAL_RIGS), "model-api-key"];
    const files = [...compose.matchAll(/\{ file: \.\/\.dev\/secrets\/([a-z0-9.-]+) \}/g)].map(
      (m) => m[1],
    );
    assert.equal(files.length, 9);
    for (const name of files) assert.ok(made.includes(name ?? ""), `${name} is made by init`);
    for (const [rig, file] of Object.entries(LOCAL_RIGS)) {
      const service = rig === "local-1" ? "enroll" : "enroll-2";
      assert.equal(
        serviceKey(compose, service, "command"),
        `["thermite", "local", "enroll", "${rig}", "--control", "http://control:8800", "--token-file", "/run/secrets/control-admin-token", "--out", "/enroll/${file}"]`,
      );
    }
    assert.ok(!compose.includes("RIG_TOKENS_FILE"), "control reads no rig tokens file");
  });

  test("the template matches compose.yaml but for images and the init service", () => {
    assert.deepEqual(templateDrift(COMPOSE, TEMPLATE), []);
    const changed = COMPOSE.replace(
      "THERMITE_TARGET: cpu\n      THERMITE_CONTROL_PUBKEY_FILE",
      'THERMITE_TARGET: cpu\n      THERMITE_NEW_SETTING: "1"\n      THERMITE_CONTROL_PUBKEY_FILE',
    );
    assert.notEqual(changed, COMPOSE);
    const drift = templateDrift(changed, TEMPLATE);
    assert.ok(drift.length > 0);
    assert.match(drift[0] ?? "", /THERMITE_NEW_SETTING/);
    assert.deepEqual(templateDrift(COMPOSE, TEMPLATE.replace("  init:", "  setup:")), [
      "the template has no init service",
    ]);
    // Control's RunPod rig image is in both files; only the release's pinned image may differ.
    const runpodLine = /^ {6}THERMITE_RUNPOD_RIG_IMAGE: .*\n/m;
    assert.match(TEMPLATE, runpodLine);
    assert.match(
      templateDrift(COMPOSE, TEMPLATE.replace(runpodLine, "")).join(),
      /THERMITE_RUNPOD_RIG_IMAGE/,
    );
    assert.match(
      templateDrift(
        COMPOSE,
        TEMPLATE.replace("@@RIG_CUDA_IMAGE@@", "ghcr.io/example/thermite-rig:latest"),
      ).join(),
      /thermite-rig:latest/,
    );
  });

  test("the message bus runs beside control, over TLS; control, its backup and both rigs are always on it", () => {
    for (const compose of [COMPOSE, render(TEMPLATE, placeholders(input()), COMPOSE_NEEDS)]) {
      assert.equal(
        serviceKey(compose, "nats", "profiles"),
        undefined,
        "no profile: it always runs",
      );
      assert.match(
        serviceKey(compose, "nats", "image") ?? "",
        /^docker\.io\/library\/nats:[\d.]+-alpine@sha256:[0-9a-f]{64}$/,
      );
      // NATS's own port, on this machine's loopback unless .env names another address.
      assert.match(
        serviceKey(compose, "nats", "ports") ?? "",
        /^\["\$\{THERMITE_NATS_PUBLISH:-127\.0\.0\.1:4222\}:4222"\]$/,
      );
      // A user of its own, not root, with no capability; it reads the certificate's key through
      // control's group. A one-shot service gives the folders to their users before it starts.
      assert.equal(serviceKey(compose, "nats", "user"), '"10002:10001"');
      assert.equal(serviceKey(compose, "nats", "cap_drop"), "[ALL]");
      assert.equal(serviceKey(compose, "nats", "cap_add"), undefined);
      assert.match(
        compose,
        /\n {4}depends_on:\n {6}control: \{ condition: service_started \}\n {6}nats-init: \{ condition: service_completed_successfully \}\n {4}networks: \[control\]\n/,
      );
      assert.equal(serviceKey(compose, "nats-init", "user"), '"0:0"');
      assert.equal(serviceKey(compose, "nats-init", "network_mode"), "none");
      assert.equal(serviceKey(compose, "nats-init", "cap_add"), "[CHOWN, DAC_READ_SEARCH]");
      assert.equal(serviceKey(compose, "nats-init", "image"), serviceKey(compose, "nats", "image"));
      assert.match(
        serviceKey(compose, "nats-init", "command") ?? "",
        /touch \.keep; } && chown 10001:10001 \. && .* && find \/data ! -user 10002 -exec chown 10002:10001/,
      );
      // Its limits: connections, and the time a connection has for TLS and to sign in.
      assert.match(compose, /\n {8}max_connections: 1024\n/);
      assert.ok(
        compose.includes(
          `\n          timeout: ${BUS_TLS_SECONDS}\n        }\n        authorization { timeout: ${BUS_SIGN_IN_SECONDS} }\n`,
        ),
      );
      // The files control writes for it, by the names control's code gives them, included from
      // its settings in /tmp.
      const dir = "/etc/nats/thermite";
      assert.ok(compose.includes(`cert_file: "${dir}/${BUS_TLS_FILES.cert}"`));
      assert.ok(compose.includes(`key_file: "${dir}/${BUS_TLS_FILES.key}"`));
      assert.ok(compose.includes("cat > /tmp/thermite.conf <<EOF"));
      assert.ok(compose.includes(`include ..${dir}/${BUS_USERS_FILE}`));
      assert.ok(compose.includes("exec nats-server -c /tmp/thermite.conf"));
      for (const name of [BUS_USERS_FILE, BUS_TLS_FILES.cert, BUS_TLS_FILES.key])
        assert.ok(compose.includes(`[ -s ${dir}/${name} ]`), `it waits for ${name}`);
      // Its health check: the server answers, with JetStream on.
      assert.match(compose, /healthz\?js-enabled-only=true/);
      // Control is always on it, and its backup service reaches it as control does; so are both
      // rigs' supervisors, which reach control only there: nothing in .env turns one off it.
      const fixed = "\n      THERMITE_NATS_URL: nats://nats:4222\n";
      assert.equal(compose.split(fixed).length - 1, 4);
      const at = compose.indexOf(fixed);
      assert.ok(compose.indexOf("\n  control:\n") < at && at < compose.indexOf("\n  nats:\n"));
      const backup = compose.indexOf(fixed, at + 1);
      assert.ok(
        compose.indexOf("\n  backup:\n") < backup && backup < compose.indexOf("\n  harness:\n"),
      );
      assert.doesNotMatch(compose, /\$\{THERMITE_NATS_URL/);
      assert.equal(compose.split("THERMITE_NATS_CA_FILE: /keys/bus-ca.pem").length - 1, 2);
      assert.match(compose, /THERMITE_NATS_CA_EXPORT: \/keys\/bus-ca\.pem/);
      assert.match(compose, /THERMITE_NATS_CONFIG_DIR: \/nats-config/);
    }
  });

  test("the readme names the version, the images and their tags", () => {
    const { readme } = bundleFiles(input(), { compose: TEMPLATE, readme: README });
    assert.match(readme, new RegExp(`^# Thermite ${PACKAGE_VERSION.replace(/\./g, "\\.")}\n`));
    assert.ok(
      readme.includes(
        `https://github.com/example/thermite/releases/download/v${PACKAGE_VERSION}/compose.yaml`,
      ),
    );
    assert.ok(readme.includes(`ghcr.io/example/thermite-harness:${PACKAGE_VERSION}-cuda\``));
    assert.ok(readme.includes(`ghcr.io/example/thermite-harness:${PACKAGE_VERSION}-cuda13\``));
    assert.ok(readme.includes(`ghcr.io/example/thermite-harness@${digest("f")}`));
    assert.ok(readme.includes(`ghcr.io/example/thermite-control@${digest("a")}`));
    assert.ok(readme.includes(`ghcr.io/example/thermite-rig:${PACKAGE_VERSION}-cuda`));
    assert.ok(readme.includes(`ghcr.io/example/thermite-rig@${digest("e")}`));
  });

  test("the readme gives the compose file's SHA-256, and the command that checks it", () => {
    const { compose, readme, composeSha256 } = bundleFiles(input(), {
      compose: TEMPLATE,
      readme: README,
    });
    assert.equal(composeSha256, createHash("sha256").update(compose).digest("hex"));
    assert.ok(readme.includes(`**SHA-256 of \`compose.yaml\`:** \`${composeSha256}\``));
    assert.ok(readme.includes(`echo "${composeSha256}  compose.yaml" | sha256sum -c -`));
    assert.ok(readme.includes("`shasum -a 256 -c -`"), "and on macOS");
    // Another image, another file, another SHA-256.
    const other = bundleFiles(input({ digests: { ...input().digests, control: digest("9") } }), {
      compose: TEMPLATE,
      readme: README,
    });
    assert.notEqual(other.composeSha256, composeSha256);
  });

  test("refuses bad input", () => {
    assert.deepEqual(checkInput(input(), PACKAGE_VERSION), []);
    assert.deepEqual(
      checkInput(input({ version: `${PACKAGE_VERSION}-rc.1` }), PACKAGE_VERSION),
      [],
    );
    const problems = (over: Partial<BundleInput>) => checkInput(input(over), PACKAGE_VERSION);
    assert.match(problems({ version: "9.9.9" }).join(), /does not match package\.json/);
    assert.match(problems({ version: "v1.0.0" }).join(), /expected 1\.2\.3/);
    assert.match(problems({ registry: "ghcr.io/Example" }).join(), /lowercase/);
    assert.match(problems({ repoUrl: "http://github.com/x" }).join(), /https/);
    const digests = { ...input().digests, harness: "sha256:abc" };
    assert.match(problems({ digests }).join(), /^harness: digest/);
    const { supervisor: _, ...missing } = input().digests;
    assert.match(
      problems({ digests: missing as BundleInput["digests"] }).join(),
      /supervisor: no digest/,
    );
    const { "rig-cuda": __, ...noRig } = input().digests;
    assert.match(
      problems({ digests: noRig as BundleInput["digests"] }).join(),
      /^rig-cuda: no digest$/,
    );
  });

  test("a placeholder without a value, or one never used, stops the render", () => {
    assert.throws(() => render("@@NOPE@@", {}), /@@NOPE@@, which has no value/);
    assert.throws(() => render("plain", { VERSION: "1" }, ["VERSION"]), /never uses @@VERSION@@/);
  });

  test("the script writes both files, and refuses a missing digest", async () => {
    const dir = mkdtempSync(join(tmpdir(), "thermite-bundle-"));
    const digests = join(dir, "digests");
    mkdirSync(digests);
    for (const [i, key] of IMAGE_KEYS.entries())
      writeFileSync(join(digests, key), `${digest(String(i + 1))}\n`);
    const out = join(dir, "bundle");
    const args = [
      "--experimental-strip-types",
      "--no-warnings",
      SCRIPT,
      "--version",
      PACKAGE_VERSION,
      "--registry",
      "ghcr.io/example",
      "--repo-url",
      "https://github.com/example/thermite",
      "--digests",
      digests,
      "--out",
      out,
    ];
    const done = await run(process.execPath, args);
    assert.match(done.stdout, /wrote .*compose\.yaml and .*README\.md/);
    const compose = readFileSync(join(out, "compose.yaml"), "utf8");
    // The readme, the release's notes, gives the SHA-256 of the file written beside it.
    const sha = createHash("sha256")
      .update(readFileSync(join(out, "compose.yaml")))
      .digest("hex");
    assert.match(done.stdout, new RegExp(`compose\\.yaml's SHA-256 is ${sha}\n$`));
    assert.ok(readFileSync(join(out, "README.md"), "utf8").includes(`echo "${sha}  compose.yaml"`));
    assert.equal(
      serviceKey(compose, "control", "image"),
      `ghcr.io/example/thermite-control@${digest("1")}`,
    );
    const nth = (key: (typeof IMAGE_KEYS)[number]) => digest(String(IMAGE_KEYS.indexOf(key) + 1));
    assert.ok(readFileSync(join(out, "README.md"), "utf8").includes(nth("supervisor")));
    assert.ok(readFileSync(join(out, "README.md"), "utf8").includes(nth("harness-cuda13")));
    // The rig image's file: control's default for rigs on RunPod.
    assert.ok(
      compose.includes(
        `THERMITE_RUNPOD_RIG_IMAGE: "\${THERMITE_RUNPOD_RIG_IMAGE:-ghcr.io/example/thermite-rig@${nth("rig-cuda")}}"`,
      ),
    );
    writeFileSync(join(digests, "harness-cuda"), "");
    await assert.rejects(run(process.execPath, args), (e: { code?: number; stderr?: string }) => {
      assert.equal(e.code, 1);
      assert.match(e.stderr ?? "", /harness-cuda: digest ""/);
      return true;
    });
  });
});
