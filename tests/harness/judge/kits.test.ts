import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { exportKit } from "../../../src/harness/judge/kits.ts";

test("two judge cards that export the same kit at once share one copy, and never cut it (goal 163)", async () => {
  const root = mkdtempSync(join(tmpdir(), "thermite-kits-"));
  const repo = join(root, "kit");
  const git = (...a: string[]) => execFileSync("git", a, { cwd: repo, encoding: "utf8" }).trim();
  execFileSync("git", ["init", "--quiet", repo]);
  writeFileSync(join(repo, "kit.json"), '{"name":"k"}\n');
  git("add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--quiet", "-m", "kit");
  const commit = git("rev-parse", "HEAD");
  const state = join(root, "state");
  const [a, b] = await Promise.all([
    exportKit(state, join(repo, ".git"), commit),
    exportKit(state, join(repo, ".git"), commit),
  ]);
  assert.equal(a, b);
  assert.equal(readFileSync(join(a, "kit.json"), "utf8"), '{"name":"k"}\n');
  assert.deepEqual(readdirSync(join(state, "kits")), [commit], "no export folder left behind");
});
