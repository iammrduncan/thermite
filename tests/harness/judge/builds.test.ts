import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { KitSchema } from "../../../src/core/kit.ts";
import { LocalRunner } from "../../../src/harness/broker/runner.ts";
import { BuildStore, toolchainOf } from "../../../src/harness/judge/builds.ts";
import { outputProblems } from "../../../src/harness/judge/measure.ts";
import { Ledger } from "../../../src/harness/ledger/index.ts";

function setup(buildScript: string, outputs: string[], timeoutS = 30) {
  const root = mkdtempSync(join(tmpdir(), "thermite-builds-"));
  const repo = join(root, "repo");
  mkdirSync(repo);
  writeFileSync(join(repo, "build.sh"), buildScript);
  const git = (...a: string[]) =>
    execFileSync(
      "git",
      ["-c", "user.name=t", "-c", "user.email=t@l", "-c", "commit.gpgsign=false", ...a],
      {
        cwd: repo,
        encoding: "utf8",
      },
    ).trim();
  git("init", "--quiet", "-b", "main");
  git("add", "-A");
  git("commit", "--quiet", "-m", "x");
  const commit = git("rev-parse", "HEAD");
  const mirror = join(root, "mirror.git");
  execFileSync("git", ["clone", "--quiet", "--bare", repo, mirror]);
  const scratch = join(root, "scratch");
  mkdirSync(scratch);
  const ledger = Ledger.open(join(root, "ledger.db"));
  const store = new BuildStore(join(root, "state"), scratch, new LocalRunner(scratch), ledger);
  const kit = KitSchema.parse({
    schema_version: 1,
    name: "t",
    target: "cpu",
    build: { command: ["sh", "build.sh"], outputs, timeout_s: timeoutS },
    cells: { c: { work: 1 } },
    run: { command: ["true"] },
    metrics: {},
    check: { command: ["true"] },
  });
  const ensure = () =>
    store.ensure({
      repo: "r",
      mirror,
      commit,
      kit,
      kitDir: root,
      kitCommit: "k".repeat(40),
      actor: "t",
      role: "builder",
    });
  return { root, store, ensure };
}

describe("build store", () => {
  test("a build's toolchain is the image's packages and compilers, not its name (goal 135)", () => {
    const a = toolchainOf({ THERMITE_IMAGE_ID: "0.1.0-cuda+1a2b3c4d5e6f" });
    // A new image with the same packages and compilers keeps its builds.
    assert.equal(toolchainOf({ THERMITE_IMAGE_ID: "0.1.1-cuda+0f0e0d0c0b0a" }), a);
    // A tool installed another way, named, builds afresh; empty counts as not set.
    assert.notEqual(toolchainOf({ THERMITE_TOOLCHAIN_ID: "fortran-14" }), a);
    assert.equal(toolchainOf({ THERMITE_TOOLCHAIN_ID: "" }), a);
  });

  test("one key is built once: an executor that needs a build under way waits for it (goal 135)", async () => {
    const count = join(mkdtempSync(join(tmpdir(), "thermite-builds-count-")), "builds");
    const s = setup(`echo built >> ${count}\nsleep 1\nmkdir -p out && echo a > out/x\n`, ["out/x"]);
    const [a, b] = await Promise.all([s.ensure(), s.ensure()]);
    assert.ok(a.ok && b.ok);
    assert.equal(readFileSync(count, "utf8"), "built\n");
    // Afterwards it is served from the store.
    const c = await s.ensure();
    assert.ok(c.ok && c.cached);
  });

  test("a symlinked output is refused, never followed", async () => {
    const s = setup("mkdir -p out && ln -s /etc/hosts out/bench\n", ["out/bench"]);
    const r = await s.ensure();
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.reason, /not a regular file/);
  });

  test("every file of a directory output is hashed and read-only", async () => {
    const s = setup("mkdir -p out/lib && echo a > out/lib/a && echo b > out/b\n", ["out"]);
    const r = await s.ensure();
    assert.ok(r.ok);
    if (r.ok) {
      assert.deepEqual(Object.keys(r.manifest.files).sort(), ["out/b", "out/lib/a"]);
      assert.deepEqual(s.store.verify(r.dir, r.manifest), []);
    }
  });

  test("a build killed for time is not cached; a plain failure is", async () => {
    const slow = setup("sleep 30\n", ["out/x"], 1);
    const first = await slow.ensure();
    assert.ok(!first.ok && first.transient);
    const again = await slow.ensure();
    assert.ok(!again.ok && again.transient, "rebuilt, not served from a cached failure");
    const fails = setup("exit 3\n", ["out/x"]);
    const f1 = await fails.ensure();
    assert.ok(!f1.ok && !f1.transient);
  });
});

describe("run outputs", () => {
  test("links and special files in outputs are refused", () => {
    const dir = mkdtempSync(join(tmpdir(), "thermite-out-"));
    writeFileSync(join(dir, "ok.bin"), "x");
    assert.deepEqual(outputProblems(dir), []);
    symlinkSync("/etc/hosts", join(dir, "ref"));
    assert.match(outputProblems(dir).join(), /not a regular file: ref/);
    const dir2 = mkdtempSync(join(tmpdir(), "thermite-out-"));
    writeFileSync(join(dir2, "a"), "x");
    linkSync(join(dir2, "a"), join(dir2, "b"));
    assert.match(outputProblems(dir2).join(), /hard link/);
  });
});
