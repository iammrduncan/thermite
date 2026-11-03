import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CAPS_ATTR, fileCapsCheck, isFailure } from "../../../src/harness/selftest/index.ts";

test("in the one-container image, files with capabilities are found, outside the folders left out", (t) => {
  const root = mkdtempSync(join(tmpdir(), "root-"));
  mkdirSync(join(root, "usr", "bin"), { recursive: true });
  mkdirSync(join(root, "scratch"));
  writeFileSync(join(root, "usr", "bin", "plain"), "");
  if (process.platform !== "linux") {
    // Capabilities are Linux's: elsewhere there are none to find, and the check says why.
    assert.equal(fileCapsCheck(root), "none (this system has no file capabilities)");
    t.skip("setting an extended attribute to find needs Linux (CI runs this part)");
    return;
  }
  assert.equal(fileCapsCheck(root), "none");
  // Setting the capabilities' own attribute needs a privilege a test has not: a user attribute
  // stands in for it, found the same way.
  const attr = "user.thermite-test";
  const set = (p: string) =>
    spawnSync("python3", [
      "-I",
      "-c",
      `import os,sys; os.setxattr(sys.argv[1], "${attr}", b"x")`,
      p,
    ]);
  writeFileSync(join(root, "usr", "bin", "ping"), "");
  writeFileSync(join(root, "scratch", "mine"), "");
  if (set(join(root, "usr", "bin", "ping")).status !== 0) {
    t.skip("this file system takes no user attributes");
    return;
  }
  set(join(root, "scratch", "mine"));
  assert.equal(
    fileCapsCheck(root, [join(root, "scratch")], attr),
    `FOUND 1 files with capabilities: ${join(root, "usr", "bin", "ping")}`,
  );
  assert.equal(isFailure(fileCapsCheck(root, [], attr)), true);
  assert.equal(fileCapsCheck(root, [], CAPS_ATTR), "none");
});
