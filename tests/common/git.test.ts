import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { GitError, git, gitSync, gitText } from "../../src/common/git.ts";

test("one git runner: git's own words on a failure, input, a time limit, and an environment of its own (goal 125)", async () => {
  const repo = mkdtempSync(join(tmpdir(), "thermite-git-"));
  await gitText(["init", "--quiet", "--bare", repo]);
  // Input on stdin, and git's answer.
  const blob = (
    await gitText(["-C", repo, "hash-object", "-w", "--stdin"], { input: "hi\n" })
  ).trim();
  assert.match(blob, /^[0-9a-f]{40}$/);
  assert.equal((await git(["-C", repo, "cat-file", "blob", blob])).toString(), "hi\n");
  // A failure names the subcommand, past -C and -c, with git's own words.
  await assert.rejects(
    git(["-C", repo, "-c", "x.y=1", "cat-file", "blob", "0".repeat(40)]),
    (err: unknown) =>
      err instanceof GitError &&
      err.subcommand === "cat-file" &&
      /^git cat-file failed: fatal: /.test(err.message) &&
      err.stderr.startsWith("fatal: "),
  );
  // With only, nothing of the caller's environment but PATH reaches git.
  process.env.THERMITE_GIT_TEST = "leak";
  const seen = gitSync(["-C", repo, "var", "GIT_EDITOR"], {
    only: true,
    env: { EDITOR: "from-the-call" },
  }).toString();
  delete process.env.THERMITE_GIT_TEST;
  assert.equal(seen.trim(), "from-the-call");
  assert.throws(
    () => gitSync(["-C", repo, "rev-parse", "--verify", "nothing"], { only: true }),
    (err: unknown) => err instanceof GitError && err.subcommand === "rev-parse",
  );
  // A call past its time limit says so.
  await assert.rejects(
    git(["-C", repo, "hash-object", "--stdin"], { timeoutMs: 1000 }),
    /git hash-object failed: no answer within 1 s/,
  );
});
