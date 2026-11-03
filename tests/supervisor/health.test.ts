import assert from "node:assert/strict";
import { createServer } from "node:net";
import { describe, test } from "node:test";
import { Loops } from "../../src/common/health.ts";
import { serveHealth } from "../../src/supervisor/health.ts";

/** A port nothing listens on now. */
async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as { port: number }).port;
  await new Promise((r) => s.close(r));
  return port;
}

describe("the supervisor's health route (goal 173)", () => {
  test("it answers whether it is well, its loops' ages to its token, 503 for a loop held past its limit, and nothing else", async () => {
    const port = await freePort();
    let now = 0;
    const loops = new Loops(() => now);
    loops.add("report", 60_000);
    loops.add("commands", 5000);
    const server = serveHealth(
      { THERMITE_SUPERVISOR_HEALTH_LISTEN: `127.0.0.1:${port}` },
      "rig-1",
      loops,
      "sup-token",
    );
    await new Promise((r) => (server.listening ? r(undefined) : server.once("listening", r)));
    try {
      const url = `http://127.0.0.1:${port}`;
      const headers = { authorization: "Bearer sup-token" };
      // A probe gets whether it is well; another token gets no more.
      let res = await fetch(`${url}/v1/health`);
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true });
      res = await fetch(`${url}/v1/health`, { headers: { authorization: "Bearer other" } });
      assert.deepEqual(await res.json(), { ok: true });
      res = await fetch(`${url}/v1/health`, { headers });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), {
        ok: true,
        rig: "rig-1",
        loops: {
          report: { age_seconds: 0, limit_seconds: 1800, late: false },
          commands: { age_seconds: 0, limit_seconds: 1800, late: false },
        },
      });
      // The report loop is held, as by a call that never answers; the command loop goes on.
      now = 75 * 60_000;
      loops.tick("commands");
      res = await fetch(`${url}/v1/health`);
      assert.equal(res.status, 503);
      assert.deepEqual(await res.json(), { ok: false });
      res = await fetch(`${url}/v1/health`, { headers });
      assert.equal(res.status, 503);
      const body = (await res.json()) as { ok: boolean; loops: Record<string, { late: boolean }> };
      assert.equal(body.ok, false);
      assert.equal(body.loops.report?.late, true);
      assert.equal(body.loops.commands?.late, false);
      assert.equal((await fetch(`${url}/v1/settings`)).status, 404);
    } finally {
      server.close();
    }
  });
});
