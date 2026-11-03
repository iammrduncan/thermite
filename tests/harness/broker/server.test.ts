import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { MAX_RUN_MS } from "../../../src/core/kit.ts";
import { BrokerClient } from "../../../src/harness/broker/client.ts";
import { startBrokerServer } from "../../../src/harness/broker/server.ts";

// Refused requests never reach the privileged handler, so this runs as any user.
const dir = mkdtempSync(join(tmpdir(), "brk-"));
const socketPath = join(dir, "b.sock");
const server = startBrokerServer({ socketPath, scratchDir: dir, baseEnv: {} });
after(() => server.close());

/** The promise's outcome, or a failure after `ms`: a call that never settles fails the test. */
function within<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms).unref(),
    ),
  ]);
}

describe("broker refusals", () => {
  test("a request refused by the broker's checks rejects its call; it never waits for ever", async () => {
    const client = new BrokerClient(socketPath);
    try {
      await assert.rejects(
        within(
          client.run({
            role: "run",
            argv: ["true"],
            cwd: dir,
            env: {},
            // A day and a second: past what the broker runs.
            timeoutMs: MAX_RUN_MS + 1000,
          }),
          5000,
        ),
        (err: Error) => /^broker: /.test(err.message) && /timeoutMs/.test(err.message),
      );
      // The connection still serves the next call.
      await assert.rejects(within(client.killRole("nobody" as never), 5000), (err: Error) =>
        /^broker: /.test(err.message),
      );
    } finally {
      client.close();
    }
  });

  test("a pair is one judge card's driver and timing user: any other is refused", async () => {
    const client = new BrokerClient(socketPath);
    const as = (role: string) => ({ role: role as never, argv: ["true"], cwd: dir });
    try {
      for (const [driver, candidate] of [
        ["driver", "run-1"],
        ["driver-2", "run"],
        ["checker", "run"],
        ["driver", "lane-1"],
        ["run", "driver"],
      ] as const)
        await assert.rejects(
          within(client.runPair(as(driver), as(candidate)), 5000),
          (err: Error) => /a pair is a judge card's driver and timing user/.test(err.message),
          `${driver} and ${candidate}`,
        );
    } finally {
      client.close();
    }
  });

  test("the answer to a refused request carries the request's own id", async () => {
    const sock = connect(socketPath);
    sock.setEncoding("utf8");
    const lines: string[] = [];
    let buf = "";
    const got = new Promise<void>((resolve) => {
      sock.on("data", (chunk: string) => {
        buf += chunk;
        for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
          lines.push(buf.slice(0, i));
          buf = buf.slice(i + 1);
        }
        if (lines.length >= 3) resolve();
      });
    });
    sock.write(`${JSON.stringify({ id: 41, op: "nothing" })}\n`);
    sock.write(`${JSON.stringify({ id: 42, op: "remove" })}\n`);
    // No id to read: the answer can only say -1.
    sock.write("not json\n");
    await within(got, 5000);
    sock.end();
    const answers = lines.map((l) => JSON.parse(l) as { id: number; ok: boolean });
    assert.deepEqual(answers.map((a) => [a.id, a.ok]).sort(), [
      [-1, false],
      [41, false],
      [42, false],
    ]);
  });
});
