import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import type { SignedCommand } from "../../src/core/commands.ts";
import {
  buildRunBranches,
  championBranch,
  pushRunBranches,
  type RunBranchesConfig,
  type RunBranchesState,
  runGitOf,
  sourceCache,
} from "../../src/supervisor/run-branches.ts";

const sh = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  }).trim();

/**
 * A project (`proj/kernel.c` in a folder, `README` beside it), its first commit, and a change to
 * the kernel as a patch: against the whole repository, or against the folder alone.
 */
function project(root: string, folder: boolean) {
  const work = join(root, "work");
  mkdirSync(join(work, "proj"), { recursive: true });
  sh(work, "init", "--quiet");
  writeFileSync(join(work, "README"), "the project\n");
  writeFileSync(join(work, "proj", "kernel.c"), "int k(void) { return 1; }\n");
  sh(work, "add", "-A");
  sh(work, "commit", "--quiet", "-m", "start");
  const commit = sh(work, "rev-parse", "HEAD");
  writeFileSync(join(work, "proj", "kernel.c"), "int k(void) { return 2; }\n");
  const patch = folder ? `${sh(work, "diff", "--relative=proj")}\n` : `${sh(work, "diff")}\n`;
  // The champion's tree, as the rig publishes it: the folder's, or the repository's.
  sh(work, "add", "-A");
  const top = sh(work, "write-tree");
  sh(work, "reset", "--quiet", "--hard");
  return { work, commit, patch, tree: folder ? sh(work, "rev-parse", `${top}:proj`) : top };
}

/** An export as the harness writes it: its files and a manifest of their hashes. */
function exportDir(outbox: string, name: string, files: Record<string, string>): void {
  const all = { "events.jsonl": "", ...files };
  for (const [rel, data] of Object.entries(all)) {
    mkdirSync(dirname(join(outbox, name, rel)), { recursive: true });
    writeFileSync(join(outbox, name, rel), data);
  }
  const sums = Object.fromEntries(
    Object.entries(all).map(([rel, data]) => [
      rel,
      createHash("sha256").update(data).digest("hex"),
    ]),
  );
  writeFileSync(
    join(outbox, name, "manifest.json"),
    JSON.stringify({ from_event: 0, through_event: 1, files: sums }),
  );
}

function setup(o: { folder: boolean; tree?: string }) {
  const root = mkdtempSync(join(tmpdir(), "thermite-run-branches-"));
  const p = project(root, o.folder);
  const url = "https://git.example/you/project.git";
  const sourcesDir = join(root, "sources");
  mkdirSync(sourcesDir);
  execFileSync("git", ["clone", "--quiet", "--bare", p.work, sourceCache(sourcesDir, url)]);
  const remote = join(root, "remote.git");
  mkdirSync(remote);
  sh(remote, "init", "--quiet", "--bare");
  const repo = join(root, "results.git");
  mkdirSync(repo);
  sh(repo, "init", "--quiet", "--bare");
  const outbox = join(root, "outbox");
  mkdirSync(outbox);
  const cmd = {
    envelope: {
      kind: "assign_campaign",
      payload: {
        run: "mm-2",
        seed: { repo: "project", commit: p.commit },
        imports: [{ kind: "repo_bundle", repo: "project", commit: p.commit, source: { git: url } }],
        results: { git: `file://${remote}`, ...(o.folder ? { folder: "proj" } : {}) },
      },
    },
  } as unknown as SignedCommand;
  const got = runGitOf(cmd);
  assert.ok(got);
  exportDir(outbox, "e1", {
    "champions/mm-2/2.patch": p.patch,
    "champions/mm-2/2.json": JSON.stringify({ seq: 2, tree: o.tree ?? p.tree, attempt: "a-1" }),
    "attempts/a-1.patch": p.patch,
    "attempts/a-1.json": JSON.stringify({
      attempt: { id: "a-1", run: "mm-2", lane: "lane-1", hypothesis: "Return two" },
      verdict: { verdict: "win_confirmed", delta: 0.1 },
    }),
  });
  const cfg: RunBranchesConfig = {
    repo,
    outboxDir: outbox,
    sourcesDir,
    gitAccess: async () => {
      throw new Error("no access in this test");
    },
    localRemotes: true,
  };
  const state: RunBranchesState = { runs: { [got.run]: got.git } };
  return { p, remote, cfg, state };
}

describe("a run's work in git (goal 185)", () => {
  test("the champion branch starts at the run's commit and has a commit for each champion; each lane has its patches", async () => {
    const { p, remote, cfg, state } = setup({ folder: false });
    const built = await buildRunBranches(cfg, state, ["e1"]);
    const g = built.runs["mm-2"];
    assert.equal(g?.error, undefined);
    assert.equal(g?.pending, true);
    const pushed = await pushRunBranches(cfg, built);
    assert.equal(pushed.runs["mm-2"]?.error, undefined);
    assert.equal(pushed.runs["mm-2"]?.pending, false);
    const tip = sh(remote, "rev-parse", championBranch("mm-2"));
    assert.equal(tip, g?.champions["2"]);
    assert.equal(sh(remote, "rev-parse", `${tip}^`), p.commit);
    assert.equal(sh(remote, "show", `${tip}:proj/kernel.c`), "int k(void) { return 2; }");
    assert.match(sh(remote, "log", "-1", "--format=%s", tip), /^Champion #2 of mm-2: Return two$/);
    const lane = sh(remote, "ls-tree", "-r", "--name-only", "thermite/mm-2/lane-1").split("\n");
    assert.deepEqual(lane, ["README.md", "attempts/001-a-1.json", "attempts/001-a-1.patch"]);
    // The same export again adds nothing.
    const again = await buildRunBranches(cfg, pushed, ["e1"]);
    assert.equal(again.runs["mm-2"]?.pending, false);
  });

  test("a project in a folder: the champion's folder is put back in the project's commit", async () => {
    const { remote, cfg, state } = setup({ folder: true });
    const pushed = await pushRunBranches(cfg, await buildRunBranches(cfg, state, ["e1"]));
    assert.equal(pushed.runs["mm-2"]?.error, undefined);
    const tip = sh(remote, "rev-parse", championBranch("mm-2"));
    assert.equal(sh(remote, "show", `${tip}:proj/kernel.c`), "int k(void) { return 2; }");
    assert.equal(sh(remote, "show", `${tip}:README`), "the project");
  });

  test("a patch that does not give the tree the rig published, and a remote branch with other history, are refused in words", async () => {
    const bad = setup({ folder: false, tree: "0".repeat(40) });
    const built = await buildRunBranches(bad.cfg, bad.state, ["e1"]);
    assert.match(
      built.runs["mm-2"]?.error ?? "",
      /champion #2's patch on the run's start gives tree/,
    );
    assert.equal(built.runs["mm-2"]?.champions["2"], undefined);

    const { remote, cfg, state } = setup({ folder: false });
    // Someone else's history on the branch: never overwritten.
    const other = mkdtempSync(join(tmpdir(), "thermite-other-"));
    sh(other, "init", "--quiet");
    writeFileSync(join(other, "x"), "x\n");
    sh(other, "add", "-A");
    sh(other, "commit", "--quiet", "-m", "other");
    sh(other, "push", "--quiet", remote, `HEAD:refs/heads/${championBranch("mm-2")}`);
    const pushed = await pushRunBranches(cfg, await buildRunBranches(cfg, state, ["e1"]));
    assert.match(pushed.runs["mm-2"]?.error ?? "", /^push failed/);
    assert.equal(pushed.runs["mm-2"]?.pending, true);
    assert.equal(readFileSync(join(remote, "HEAD"), "utf8").length > 0, true);
  });

  test("a run whose assignment names no results, or no source, has no branches", () => {
    const cmd = (payload: unknown) =>
      ({ envelope: { kind: "assign_campaign", payload } }) as unknown as SignedCommand;
    assert.equal(
      runGitOf(cmd({ run: "r", seed: { repo: "p", commit: "a".repeat(40) } })),
      undefined,
    );
    assert.equal(
      runGitOf(
        cmd({
          run: "r",
          seed: { repo: "p", commit: "a".repeat(40) },
          imports: [],
          results: { git: "https://h/x.git" },
        }),
      ),
      undefined,
    );
  });
});
