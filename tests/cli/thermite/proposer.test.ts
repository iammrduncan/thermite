import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);
const CLI = join(import.meta.dirname, "../../../src/cli/thermite/main.ts");

test("thermite status exits non-zero when the harness answers with an error (goal 164)", async (t) => {
  const server = createServer((req, res) => {
    if (req.url === "/v1/attempts/a-1")
      return void res.writeHead(200, { "content-type": "application/json" }).end('{"id":"a-1"}');
    res.writeHead(404, { "content-type": "application/json" }).end('{"error":"no attempt"}');
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const harness = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const token = join(mkdtempSync(join(tmpdir(), "thermite-status-")), "token");
  writeFileSync(token, "tok\n");
  const status = async (attempt: string) => {
    try {
      const r = await run(process.execPath, [
        "--experimental-strip-types",
        "--no-warnings",
        CLI,
        "status",
        "--harness",
        harness,
        "--token-file",
        token,
        "--attempt",
        attempt,
      ]);
      return { code: 0, stdout: r.stdout };
    } catch (err) {
      const e = err as { code: number; stdout: string };
      return { code: e.code, stdout: e.stdout };
    }
  };
  assert.deepEqual(await status("a-1"), { code: 0, stdout: '{"id":"a-1"}\n' });
  assert.deepEqual(await status("a-404"), { code: 1, stdout: '{"error":"no attempt"}\n' });
});
