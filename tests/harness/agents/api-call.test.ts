import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, test } from "node:test";
import { apiCall } from "../../../src/harness/agents/api-call.ts";

describe("worker API calls", () => {
  test("a call returns the status and body, sends its own, and waits for a slow answer", async () => {
    const seen: { method?: string; auth?: string; body: string }[] = [];
    // The answer's headers come late, as from a long lane command.
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => {
        body += c;
      });
      req.on("end", () => {
        seen.push({ method: req.method, auth: req.headers.authorization, body });
        setTimeout(() => {
          res.writeHead(req.url === "/missing" ? 404 : 200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: req.url !== "/missing" }));
        }, 1500);
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const ok = await apiCall(`${url}/v1/lane/run`, "POST", { authorization: "Bearer t" }, "{}");
      assert.deepEqual(ok, { status: 200, text: '{"ok":true}' });
      assert.deepEqual(seen[0], { method: "POST", auth: "Bearer t", body: "{}" });
      const missing = await apiCall(`${url}/missing`, "GET", {});
      assert.equal(missing.status, 404);
    } finally {
      server.close();
    }
    await assert.rejects(apiCall(url, "GET", {}), /ECONNREFUSED/);
  });
});
