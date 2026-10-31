import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { withGitAuth } from "../../src/common/git-auth.ts";
import { makeDeployKey } from "../../src/control/git-keys.ts";

describe("git access for a private repository", () => {
  test("an SSH key lives in a 0600 file only while git runs, with the host pinned on first use", async () => {
    const key = makeDeployKey("thermite test");
    const known = join(mkdtempSync(join(tmpdir(), "thermite-known-")), "hosts", "known_hosts");
    let file = "";
    await withGitAuth({ kind: "ssh", privateKey: key.privateKey }, known, async (g) => {
      assert.equal(g.protocols, "ssh");
      const cmd = g.env.GIT_SSH_COMMAND ?? "";
      assert.match(cmd, /-o IdentitiesOnly=yes/);
      assert.match(cmd, /StrictHostKeyChecking=accept-new/);
      assert.ok(cmd.includes(known));
      file = /-i '([^']+)'/.exec(cmd)?.[1] ?? "";
      assert.equal(statSync(file).mode & 0o777, 0o600);
      assert.equal(readFileSync(file, "utf8"), key.privateKey);
      // The key never goes in an environment variable or an argument itself.
      assert.ok(!JSON.stringify(g.env).includes("PRIVATE KEY"));
    });
    assert.ok(!existsSync(file));
  });

  test("a token goes in a header, never the URL; no access means plain git", async () => {
    await withGitAuth({ kind: "token", token: "tok-123" }, undefined, async (g) => {
      assert.equal(g.protocols, "https");
      assert.equal(g.env.GIT_CONFIG_KEY_0, "http.extraHeader");
      assert.equal(
        g.env.GIT_CONFIG_VALUE_0,
        `Authorization: Basic ${Buffer.from("x-access-token:tok-123").toString("base64")}`,
      );
    });
    await withGitAuth(undefined, undefined, async (g) => assert.deepEqual(g.env, {}));
  });
});
