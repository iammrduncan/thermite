import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { Terminal } from "../../../src/agents/terminal/client.ts";
import type { TerminalHost } from "../../../src/agents/terminal/host.ts";
import { ANSWER_MAX, REQUEST_MAX } from "../../../src/agents/terminal/protocol.ts";
import { serveTerminal } from "../../../src/agents/terminal/server.ts";

const SECRET = "s".repeat(43);

/** A stand-in host that records what it was asked. */
function fakeHost() {
  const asked: string[] = [];
  const host = {
    status: () => {
      asked.push("status");
      return { state: "running" as const, pid: 7, cols: 120, rows: 40, output: 3 };
    },
    type: async (text: string, enter: boolean) => {
      asked.push(`type ${text} ${enter}`);
    },
    sendKeys: async (keys: readonly string[]) => {
      asked.push(`keys ${keys.join(",")}`);
    },
    interrupt: async () => {
      throw new Error("the program is ended: the interrupt not sent");
    },
    screenText: async () => ({
      cols: 120,
      rows: 40,
      cursor: { x: 2, y: 0 },
      alternate: false,
      lines: ["> "],
    }),
    screenSnapshot: async (scrollback: number) => ({
      cols: 120,
      rows: 40,
      data: `snap ${scrollback}`,
    }),
    end: async () => ({ how: "end steps" as const, code: 0, signal: null }),
  };
  return { host: host as unknown as TerminalHost, asked };
}

/** One raw line to a socket, and the answer's line. */
const raw = (socket: string, line: string) =>
  new Promise<string>((resolve, reject) => {
    let got = "";
    const s = connect(socket, () => s.write(line));
    s.on("data", (d) => {
      got += d;
    });
    s.on("close", () => resolve(got.trim()));
    s.on("error", reject);
  });

const dir = mkdtempSync(join(tmpdir(), "th-term-"));
const servers: { close(): void }[] = [];
after(() => {
  for (const s of servers) s.close();
});

function serve() {
  const { host, asked } = fakeHost();
  const socket = join(dir, `s${servers.length}.sock`);
  servers.push(serveTerminal(host, socket, SECRET));
  const terminal = new Terminal({ socket, secret: SECRET, done: new Promise(() => undefined) });
  return { socket, asked, terminal };
}

describe("the terminal host's socket", () => {
  test("the harness asks with the secret, and each answer is read by its schema", async () => {
    const { terminal, asked } = serve();
    await new Promise((r) => setTimeout(r, 50));
    assert.equal((await terminal.status()).pid, 7);
    await terminal.type("hello", false);
    await terminal.keys(["up", "enter"]);
    assert.deepEqual((await terminal.screen()).lines, ["> "]);
    assert.equal((await terminal.snapshot(5)).data, "snap 5");
    assert.deepEqual(await terminal.end(), { how: "end steps", code: 0, signal: null });
    assert.deepEqual(asked, ["status", "type hello false", "keys up,enter"]);
  });

  test("what the host could not do comes back in words", async () => {
    const { terminal } = serve();
    await new Promise((r) => setTimeout(r, 50));
    await assert.rejects(terminal.interrupt(), /refused: the program is ended/);
  });

  test("a request without the secret, or one it doesn't know, or too long, does nothing", async () => {
    const { socket, asked } = serve();
    await new Promise((r) => setTimeout(r, 50));
    const refused = (a: string) => assert.equal(JSON.parse(a).ok, false, a);
    refused(await raw(socket, `${JSON.stringify({ op: "status" })}\n`));
    refused(
      await raw(socket, `${JSON.stringify({ op: "type", secret: "x".repeat(43), text: "hi" })}\n`),
    );
    refused(await raw(socket, `${JSON.stringify({ op: "rm -rf", secret: SECRET })}\n`));
    refused(await raw(socket, "not json\n"));
    refused(await raw(socket, "x".repeat(REQUEST_MAX + 10)));
    refused(
      await raw(socket, `${JSON.stringify({ op: "keys", secret: SECRET, keys: ["ctrl-c"] })}\n`),
    );
    assert.deepEqual(asked, []);
  });

  test("the harness reads no answer past its limit, and no answer that is not what it asked", async () => {
    const socket = join(dir, "liar.sock");
    let n = 0;
    const liar = createServer((s) => {
      s.on("data", () => {
        n++;
        if (n === 1) s.end(`${JSON.stringify({ ok: true, pid: "seven" })}\n`);
        else s.end("x".repeat(ANSWER_MAX + 2));
      });
    });
    servers.push(liar);
    await new Promise<void>((r) => liar.listen(socket, r));
    const t = new Terminal({ socket, secret: SECRET, done: new Promise(() => undefined) });
    await assert.rejects(t.status());
    await assert.rejects(t.status(), /over \d+ bytes/);
  });
});
