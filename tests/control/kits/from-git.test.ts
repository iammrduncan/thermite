import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { kitBundleFromGit } from "../../../src/control/kits/from-git.ts";
import { KitRefused, KitRepos } from "../../../src/control/kits/repos.ts";
import { controlOnly, mcpClient } from "../../helpers/control-stack.ts";

/**
 * A kit given to control as its repository's git address, which control reads itself (goal 182):
 * MCP's kit_add and REST take {git: {url, ref, access}} in place of a bundle. What is refused
 * before control reaches out; the campaign acceptance check reads a kit over ssh with a deploy key.
 */

const TOKENS = {
  admin: "owner-token-abcdef",
  operator: "operator-token-abcdef",
  rigs: { "rig-a": "rig-token-abcdef" },
};

const text = (r: unknown) =>
  JSON.parse(((r as { content: { text: string }[] }).content[0] as { text: string }).text);

describe("a kit from its git address", () => {
  test("refused before control reaches out: an address that is not https, or ssh with a deploy key; a ref git does not allow", async () => {
    const refused = async (src: { url: string; ref?: string }, why: RegExp) => {
      await assert.rejects(kitBundleFromGit(src), (err: unknown) => {
        assert.ok(err instanceof KitRefused);
        assert.equal(err.status, 400);
        assert.match(err.message, why);
        return true;
      });
    };
    const https = /must be an https:\/\/ URL, or name a Git access for a private one/;
    await refused({ url: "http://git.example.com/kit.git" }, https);
    await refused({ url: "file:///var/lib/thermite-control/control.db" }, https);
    await refused({ url: "ssh://git@git.example.com/kit.git" }, https);
    await refused({ url: "https://git.example.com/kit.git", ref: "--upload-pack=x" }, /characters/);
    await refused({ url: "https://git.example.com/kit.git", ref: "a b" }, /characters/);
  });

  test("MCP and REST: bundle or git, one of the two; a ref inside git; a Git access control keeps", async () => {
    const kits = new KitRepos(mkdtempSync(join(tmpdir(), "thermite-kits-")));
    const { control } = await controlOnly({ tokens: TOKENS, options: { kits } });
    const op = await mcpClient(control, TOKENS.operator);
    const call = async (args: Record<string, unknown>) =>
      text(await op.callTool({ name: "kit_add", arguments: { name: "lab-kit", ...args } })).error;
    const url = "https://git.example.com/lab/kit.git";
    assert.match(await call({}), /Give the kit as bundle_base64 or as git, one of the two/);
    assert.match(
      await call({ bundle_base64: "AAAA", git: { url } }),
      /Give the kit as bundle_base64 or as git, one of the two/,
    );
    assert.match(
      await call({ git: { url }, ref: "main" }),
      /name the branch, tag or commit as git\.ref/,
    );
    assert.match(await call({ git: { url, access: "nope" } }), /no Git access named nope/);
    assert.match(await call({ git: { url: "http://git.example.com/kit.git" } }), /https:\/\/ URL/);

    const post = (body: string) =>
      control.request("/v1/kits/lab-kit", {
        method: "POST",
        body,
        headers: { authorization: `Bearer ${TOKENS.admin}`, "content-type": "application/json" },
      });
    const answer = async (body: unknown) => {
      const r = await post(JSON.stringify(body));
      return [r.status, ((await r.json()) as { error: string }).error] as const;
    };
    assert.deepEqual(await answer({ git: { url: "http://git.example.com/kit.git" } }), [
      400,
      "the kit's repository must be an https:// URL, or name a Git access for a private one",
    ]);
    assert.deepEqual(await answer({ git: { url, access: "nope" } }), [
      400,
      "no Git access named nope",
    ]);
    const [status, why] = await answer({ git: { url, branch: "main" } });
    assert.equal(status, 400);
    assert.match(why, /^bad request: git: /);
    assert.equal((await post("{not json")).status, 400);
  });
});
