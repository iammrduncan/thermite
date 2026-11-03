import assert from "node:assert/strict";
import { createServer, type Server, type Socket } from "node:net";
import { describe, test } from "node:test";
import { createUser } from "@nats-io/nkeys";
import { probeBus } from "../../../src/common/bus/index.ts";

/**
 * The check of a bus's server (common/bus/probe.ts), which a RunPod pod's supervisor runs on its
 * pod's own server: a server that takes the connection and never answers, and a port with no
 * server, each fail it in words within its time. A server that answers is the leaf acceptance's (a
 * real NATS server).
 */

const seed = createUser().getSeed();

/** A server that takes each connection and says nothing, as a hung NATS server does. */
async function silent(): Promise<{ url: string; open: () => number; close: () => Promise<void> }> {
  const sockets = new Set<Socket>();
  const server: Server = createServer((s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  return {
    url: `nats://127.0.0.1:${port}`,
    open: () => sockets.size,
    close: () =>
      new Promise((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
  };
}

describe("the check of a bus's server", () => {
  test("a server that takes the connection and never answers fails it within its time", async () => {
    const s = await silent();
    try {
      const t0 = Date.now();
      const why = await probeBus(s.url, "check", { seed }, 300);
      const took = Date.now() - t0;
      assert.ok(why, "it failed");
      assert.match(why, /no answer within 0\.3 s|no connection: /);
      assert.ok(took < 2_000, `it took ${took} ms`);
      assert.equal(s.open(), 1, "it reached the server");
    } finally {
      await s.close();
    }
  });

  test("a port with no server fails it, in words", async () => {
    const s = await silent();
    const url = s.url;
    await s.close();
    const why = await probeBus(url, "check", { seed }, 2_000);
    assert.match(why ?? "", /^no connection: /);
  });
});
