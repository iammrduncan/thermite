import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { controlTokenFrom } from "../../src/supervisor/settings.ts";

test("the rig's token for control: read from its file; an empty one stops the supervisor, in words", () => {
  const file = join(mkdtempSync(join(tmpdir(), "thermite-sup-")), "control-rig-token");
  const env = { THERMITE_CONTROL_TOKEN_FILE: file };
  const url = "http://control:8800";
  // No control address, or no token file: no token, and nothing is read.
  assert.equal(controlTokenFrom(env, undefined), undefined);
  assert.equal(controlTokenFrom({}, url), undefined);
  // Not there yet, or empty, as the local stack's file is until its enroll step writes it.
  assert.throws(() => controlTokenFrom(env, url), /^Error: the rig has no token for control yet/);
  writeFileSync(file, "\n");
  assert.throws(
    () => controlTokenFrom(env, url),
    /no token for control yet \(secret file for THERMITE_CONTROL_TOKEN_FILE is empty\): enroll it with control/,
  );
  writeFileSync(file, "a-token-control-made\n");
  assert.equal(controlTokenFrom(env, url), "a-token-control-made");
});
