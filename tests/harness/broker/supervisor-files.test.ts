import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { makeSupervisorFiles, supervisorPaths } from "../../../src/harness/broker/one-container.ts";

test("the supervisor's files are made again after a full reset empties its home (goal 165)", () => {
  const root = mkdtempSync(join(tmpdir(), "thermite-supfiles-"));
  const paths = supervisorPaths({
    THERMITE_SUPERVISOR_HOME: join(root, "home"),
    THERMITE_INBOX_DIR: join(root, "inbox"),
  });
  const ids = {
    uid: process.getuid?.() ?? 0,
    gid: process.getgid?.() ?? 0,
    inboxGid: process.getgid?.() ?? 0,
  };
  makeSupervisorFiles(paths, ids, "tok-1");
  assert.equal(readFileSync(paths.tokenFile, "utf8"), "tok-1");
  assert.equal(statSync(paths.tokenFile).mode & 0o777, 0o600);
  assert.equal(statSync(paths.home).mode & 0o777, 0o700);

  // The supervisor's wipe, as in its main: everything in its home goes but the tunnel's folders.
  mkdirSync(join(paths.home, "tunnel"));
  writeFileSync(join(paths.home, "relay-state.json"), "{}");
  for (const name of readdirSync(paths.home))
    if (name !== "tunnel") rmSync(join(paths.home, name), { recursive: true, force: true });
  assert.ok(!existsSync(paths.tokenFile));

  // Before its next start: the token and its tmp folder are back, what the wipe kept stays.
  makeSupervisorFiles(paths, ids, "tok-1");
  assert.equal(readFileSync(paths.tokenFile, "utf8"), "tok-1");
  assert.ok(statSync(paths.tmp).isDirectory());
  assert.ok(existsSync(join(paths.home, "tunnel")));
  assert.ok(!existsSync(join(paths.home, "relay-state.json")));

  // A link left at the token's path is replaced, never written through.
  const outside = join(root, "outside");
  writeFileSync(outside, "keep");
  rmSync(paths.tokenFile);
  symlinkSync(outside, paths.tokenFile);
  makeSupervisorFiles(paths, ids, "tok-2");
  assert.equal(readFileSync(outside, "utf8"), "keep");
  assert.equal(readFileSync(paths.tokenFile, "utf8"), "tok-2");
});
