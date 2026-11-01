import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import {
  cleanMcpError,
  headerSecrets,
  MCP_TIMEOUT_MS,
  mcpConnect,
} from "../../src/common/mcp-client.ts";

/** A made-up token: it reaches the silent server's headers only. */
const TOKEN = "mcp-client-token-for-tests";

test("an MCP server that never answers fails the connection in its time limit, and the words hold no token", async (t) => {
  const server = createServer(() => {});
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  const before = { ...MCP_TIMEOUT_MS };
  MCP_TIMEOUT_MS.connect = 300;
  MCP_TIMEOUT_MS.call = 300;
  t.after(() => Object.assign(MCP_TIMEOUT_MS, before));
  const headers = { authorization: `Bearer ${TOKEN}` };
  const started = Date.now();
  const err = await mcpConnect(undefined, "thermite-test")(url, headers).then(
    () => assert.fail("the server answered"),
    (e: unknown) => e,
  );
  assert.ok(Date.now() - started < 5000, `took ${Date.now() - started} ms`);
  const words = cleanMcpError(err, headerSecrets(headers));
  assert.match(words, /time/i);
  assert.doesNotMatch(words, new RegExp(TOKEN));
});
