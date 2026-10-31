import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { exportOnce } from "../../src/supervisor/git-export.ts";
import { makeHarnessEnv } from "../helpers/harness-env.ts";

const lsTree = (repo: string, branch: string) =>
  execFileSync("git", ["-C", repo, "ls-tree", "-r", "--name-only", branch], { encoding: "utf8" })
    .trim()
    .split("\n");

describe("supervisor git export", () => {
  test("verified exports become packed commits on the rig's branches and are pushed", async () => {
    const env = makeHarnessEnv("rig-a");
    await env.service.applyCommand(env.sign("assign_campaign", env.assignPayload()));
    const patch = env.patchFrom((d) =>
      appendFileSync(join(d, "src", "kernel", "k.c"), "/* a change */\n"),
    );
    const a = await env.service.submitAttempt(
      { run: "smoke-1", patch_base64: patch, hypothesis: "h", known_flaws: [] },
      "proposer",
    );
    await env.service.export("test");

    const root = mkdtempSync(join(tmpdir(), "thermite-results-"));
    const remote = join(root, "remote.git");
    mkdirSync(remote);
    execFileSync("git", ["-C", remote, "init", "--bare", "--quiet"]);
    const cfg = {
      rig: "rig-a",
      outboxDir: env.service.paths.outboxDir,
      workDir: join(root, "work"),
      remote: `file://${remote}`,
    };
    const s1 = await exportOnce(cfg, { done: [] });
    assert.equal(s1.lastError, undefined);
    assert.equal(s1.done.length, 1);
    const files = lsTree(remote, "thermite/rig-a/attempts");
    assert.ok(files.includes(`attempts/${a.attempt}.patch`), files.join(","));
    assert.ok(lsTree(remote, "thermite/rig-a/ledger").includes("ledger.sqlite"));

    // Nothing new: nothing committed. A later export adds a commit on top.
    const s2 = await exportOnce(cfg, s1);
    assert.deepEqual(s2.done, s1.done);
    await env.service.export("test");
    const s3 = await exportOnce(cfg, s2);
    assert.equal(s3.done.length, 2);
    const count = execFileSync(
      "git",
      ["-C", remote, "rev-list", "--count", "thermite/rig-a/attempts"],
      {
        encoding: "utf8",
      },
    ).trim();
    assert.equal(count, "2");
  });

  test("a tampered export is refused and never pushed", async () => {
    const env = makeHarnessEnv("rig-a");
    await env.service.applyCommand(env.sign("assign_campaign", env.assignPayload()));
    const exp = await env.service.export("test");
    appendFileSync(join(exp.dir, "events.jsonl"), '{"forged":true}\n');
    const root = mkdtempSync(join(tmpdir(), "thermite-results-"));
    const s = await exportOnce(
      { rig: "rig-a", outboxDir: env.service.paths.outboxDir, workDir: join(root, "work") },
      { done: [] },
    );
    assert.match(String(s.lastError), /hash mismatch events.jsonl/);
    assert.throws(() =>
      execFileSync(
        "git",
        ["-C", join(root, "work", "results.git"), "rev-parse", "thermite/rig-a/attempts"],
        {
          stdio: "ignore",
        },
      ),
    );
  });
});
