import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { harnessAdvisors } from "../../../src/supervisor/advisors/harness.ts";

test("the harness's refusals of the advisors' calls are logged once each, with the status (goal 164)", async (t) => {
  let status = 500;
  const server = createServer((req, res) => {
    req.resume();
    if (status !== 200) return void res.writeHead(status).end("not now");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(req.url === "/v1/settings" ? '{"teachers":false,"auditor":true,"review":true}' : "{}");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const lines: { msg: string; fields: Record<string, unknown> | undefined }[] = [];
  const link = harnessAdvisors(
    `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    "tok",
    (_part, msg, fields) => void lines.push({ msg, fields }),
  );
  const told = { auditor: true, review_panel: 0, writer: false };

  // Refused: the defaults stand, and each call says so once, however often it fails.
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(await link.settings(), { teachers: true, auditor: true, review: true });
    await link.tell(told);
  }
  assert.deepEqual(lines, [
    {
      msg: "the harness did not give the rig's settings: the last ones stand",
      fields: { status: 500, answer: "not now" },
    },
    {
      msg: "the harness did not take which advisors decide",
      fields: { status: 500, answer: "not now" },
    },
  ]);

  // Through again: the harness's settings apply, and the next failure is said again.
  status = 200;
  assert.equal((await link.settings()).teachers, false);
  await link.tell(told);
  status = 404;
  assert.equal((await link.settings()).teachers, false);
  assert.equal(lines.length, 3);
  assert.deepEqual(lines[2]?.fields, { status: 404, answer: "not now" });

  // Out of reach: said with the error.
  server.close();
  server.closeAllConnections();
  await link.tell(told);
  assert.match(JSON.stringify(lines[3]), /"error":".*(fetch failed|ECONNREFUSED)/);
});
