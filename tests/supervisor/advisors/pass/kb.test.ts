import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, type TestContext, test } from "node:test";
import { MCP_TIMEOUT_MS } from "../../../../src/common/mcp-client.ts";
import { kbSearchFor } from "../../../../src/supervisor/advisors/pass/index.ts";
import { startFakeMcp } from "../../../helpers/fake-mcp.ts";

/** A made-up token: it reaches the fake server's headers only. */
const TOKEN = "kb-token-for-tests";

function tokenFile(value: string): string {
  const file = join(mkdtempSync(join(tmpdir(), "thermite-kb-")), "kb-token");
  writeFileSync(file, `${value}\n`);
  return file;
}

/** A server that takes every request and never answers it. */
async function silentServer(t: TestContext): Promise<string> {
  const server = createServer(() => {});
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
}

describe("the advisors file's kb search", () => {
  test("calls the file's tool with the token from its file, read at each search", async (t) => {
    const fake = await startFakeMcp({ kind: "bearer", token: TOKEN });
    t.after(() => fake.close());
    const file = tokenFile(TOKEN);
    const search = kbSearchFor({ kb: { mcp_url: fake.url, token_file: file, tool: "search" } });
    assert.ok(search);
    const found = await search("first page");
    assert.match(JSON.stringify(found), /notes\/start/);
    assert.deepEqual(fake.calls, [{ tool: "search", args: { query: "first page" } }]);
    assert.ok(fake.requests.every((r) => r.headers.authorization === `Bearer ${TOKEN}`));
    assert.ok(!fake.requests.some((r) => r.path.includes(TOKEN)));
    writeFileSync(file, "a-changed-token\n");
    await assert.rejects(search("first page"));
  });

  test("a server that never answers fails the search in its time limit, and the words hold no token", async (t) => {
    const url = await silentServer(t);
    const before = { ...MCP_TIMEOUT_MS };
    MCP_TIMEOUT_MS.connect = 300;
    MCP_TIMEOUT_MS.call = 300;
    t.after(() => Object.assign(MCP_TIMEOUT_MS, before));
    const search = kbSearchFor({
      kb: { mcp_url: url, token_file: tokenFile(TOKEN), tool: "search" },
    });
    assert.ok(search);
    const started = Date.now();
    const err = await search("anything").then(
      () => assert.fail("the search answered"),
      (e: unknown) => e as Error,
    );
    assert.ok(Date.now() - started < 5000, `took ${Date.now() - started} ms`);
    assert.match(err.message, /time/i);
    assert.doesNotMatch(err.message, new RegExp(TOKEN));
  });

  test("no kb, no search", () => {
    assert.equal(kbSearchFor({}), undefined);
  });
});
